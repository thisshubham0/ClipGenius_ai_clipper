import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CAPTION_STYLES } from '../../src/data/demoProject';
import {
  buildCaptionTrackCues,
  computeEffectiveTimeline,
  filterWordsForCaptions,
  generateSrtFromTranslatedCues,
  generateVttFromTranslatedCues,
} from '../../src/lib/editorEngine';
import {
  getExportFormatOption,
  normalizeExportContainerFormat,
  normalizeExportQuality,
} from '../../src/lib/exportFormats';
import { generateSrtFromWords, generateVttFromWords } from '../../src/lib/scoring';
import type {
  AspectRatio,
  BrandKit,
  CaptionAnimationStyle,
  CaptionStyle,
  Clip,
  ExportContainerFormat,
  ExportJob,
  ExportQuality,
  Project,
  SocialExportPreset,
  TranscriptWord,
} from '../../src/types/clipgenius';
import { getSafeCaptionLayoutMetrics, resolveCaptionStyle } from '../../src/lib/captionStyles';
import { resolveClipBackgroundStyle } from '../../src/lib/clipVersions';
import { getRawVideoPathForProject } from '../pipeline/analyzer';
import {
  ensureStorageDirs,
  getExportFilePath,
  getMediaFilePath,
  sanitizeStorageKey,
  signExportDownloadUrl,
} from '../storage/storageAdapter';
import { appendGifPaletteFilter, buildContainerEncodingArgs } from './exportFfmpegArgs';
import { generateDemoClipMp4 } from './ffmpegThumb';
import { probeVideoFile } from './ffprobe';
import {
  buildClipRenderFilterGraph,
  buildZipArchive,
  computeKeepSegments,
  generateAssSubtitles,
  getTargetDimensions,
  type ZipEntryInput,
} from './renderSpec';
import { ensureSoundtrackFile } from './soundtracks';

const DEMO_IMAGE_MAP: Record<string, string> = {
  demo_clip_1: 'src/assets/images/clip_podcast_founder_1794996401712.jpg',
  demo_clip_2: 'src/assets/images/clip_creator_keynote_1794996401709.jpg',
  demo_clip_3: 'src/assets/images/clip_studio_interview_1794996403009.jpg',
};

interface InternalExportRecord {
  job: ExportJob;
  ownerUid?: string;
  onJobUpdated?: (job: ExportJob) => void;
  outputFilePath?: string;
  contentType: string;
  project: Project;
  clip: Clip;
  brandKit?: Partial<BrandKit>;
}

export interface DiskExportArtifactMeta {
  jobId: string;
  outputFilePath: string;
  filename: string;
  contentType: string;
  kind: 'mp4' | 'batch_zip';
  containerFormat: ExportContainerFormat;
  fileSizeBytes: number;
}

const exportStore = new Map<string, InternalExportRecord>();
const pendingQueue: string[] = [];
const MAX_CONCURRENT_RENDERS = 2;
let activeRenderCount = 0;

function slugifyFilename(input: string, fallback: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || fallback;
}

async function writeExportMetaSidecar(meta: DiskExportArtifactMeta): Promise<void> {
  const metaPath = getExportFilePath(`${meta.jobId}.meta.json`);
  await fs.writeFile(metaPath, JSON.stringify(meta), 'utf8').catch(() => {});
}

export async function resolveExportArtifactFromDisk(
  jobId: string
): Promise<DiskExportArtifactMeta | null> {
  try {
    const metaPath = getExportFilePath(`${jobId}.meta.json`);
    const raw = await fs.readFile(metaPath, 'utf8');
    const parsed = JSON.parse(raw) as DiskExportArtifactMeta;
    if (!parsed.outputFilePath) return null;
    await fs.access(parsed.outputFilePath);
    return parsed;
  } catch {
    // Legacy fallback: check if <jobId>.mp4 or <jobId>.zip exists on disk without sidecar
    const legacyCandidates: { ext: string; mime: string; kind: 'mp4' | 'batch_zip'; fmt: ExportContainerFormat }[] = [
      { ext: 'mp4', mime: 'video/mp4', kind: 'mp4', fmt: 'mp4' },
      { ext: 'mov', mime: 'video/quicktime', kind: 'mp4', fmt: 'mov' },
      { ext: 'webm', mime: 'video/webm', kind: 'mp4', fmt: 'webm' },
      { ext: 'mkv', mime: 'video/x-matroska', kind: 'mp4', fmt: 'mkv' },
      { ext: 'gif', mime: 'image/gif', kind: 'mp4', fmt: 'gif' },
      { ext: 'mp3', mime: 'audio/mpeg', kind: 'mp4', fmt: 'mp3' },
      { ext: 'zip', mime: 'application/zip', kind: 'batch_zip', fmt: 'mp4' },
    ];
    for (const cand of legacyCandidates) {
      const p = getExportFilePath(`${jobId}.${cand.ext}`);
      try {
        const stat = await fs.stat(p);
        if (stat.size > 0) {
          return {
            jobId,
            outputFilePath: p,
            filename: `${sanitizeStorageKey(jobId)}.${cand.ext}`,
            contentType: cand.mime,
            kind: cand.kind,
            containerFormat: cand.fmt,
            fileSizeBytes: stat.size,
          };
        }
      } catch {
        // continue
      }
    }
    return null;
  }
}

async function verifyRenderedMediaPlayable(
  filePath: string,
  containerFormat: ExportContainerFormat
): Promise<void> {
  const stat = await fs.stat(filePath);
  if (stat.size < 256) {
    throw new Error(`Rendered ${containerFormat.toUpperCase()} output is empty or truncated.`);
  }

  const probeJson = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      'ffprobe',
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `FFprobe verification failed (code ${code}).`));
    });
  });

  const parsed = JSON.parse(probeJson) as {
    streams?: { codec_type?: string; width?: number; height?: number }[];
    format?: { duration?: string };
  };
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const duration = Number(parsed.format?.duration ?? 0);

  if (containerFormat === 'mp3') {
    const hasAudioStream = streams.some((s) => s.codec_type === 'audio');
    if (!hasAudioStream || !(duration > 0.1)) {
      throw new Error('Rendered MP3 verification failed: missing valid audio stream.');
    }
    return;
  }

  const videoStream = streams.find((s) => s.codec_type === 'video');
  if (!videoStream || !(videoStream.width && videoStream.width > 0) || !(videoStream.height && videoStream.height > 0)) {
    throw new Error(`Rendered ${containerFormat.toUpperCase()} verification failed: missing valid video stream.`);
  }

  if (containerFormat !== 'gif' && !(duration > 0.1)) {
    throw new Error(`Rendered ${containerFormat.toUpperCase()} verification failed: invalid media duration.`);
  }
}

function resolveClipCaptionStyle(clip: Clip) {
  return resolveCaptionStyle(clip);
}

async function resolveClipSourceVideo(
  project: Project,
  clip: Clip
): Promise<{ inputPath: string; seekSec: number; durationSec: number }> {
  const clipDur = Math.max(2, Number((clip.endSec - clip.startSec).toFixed(2)));

  if (!project.isDemo) {
    const rawPath = getRawVideoPathForProject(project);
    if (!rawPath) {
      throw new Error('No source video storage key found for this project.');
    }
    await fs.access(rawPath);
    return {
      inputPath: rawPath,
      seekSec: Math.max(0, clip.startSec),
      durationSec: clipDur,
    };
  }

  const relImg = DEMO_IMAGE_MAP[clip.id] ?? DEMO_IMAGE_MAP.demo_clip_1;
  const imgAbs = path.resolve(process.cwd(), relImg);
  const demoMasterPath = getMediaFilePath(`${sanitizeStorageKey(clip.id)}_preview.mp4`);
  const ok = await generateDemoClipMp4(imgAbs, demoMasterPath, 12);
  if (!ok) {
    throw new Error('Unable to synthesize demo clip master with FFmpeg.');
  }

  // Demo preview masters are 12s long; keep renders fast and frame-accurate
  return {
    inputPath: demoMasterPath,
    seekSec: 0,
    durationSec: Math.min(12, Math.max(4, clipDur)),
  };
}

function buildClipSubtitlesText(
  clip: Clip,
  projectWords?: TranscriptWord[]
): { srt: string; vtt: string } {
  const activeLang = clip.subtitleLanguage || 'original';
  const useTranslated =
    activeLang !== 'original' && activeLang !== clip.wordsLanguage;
  const translatedRaw = useTranslated ? clip.translatedCues?.[activeLang] : undefined;
  const translated = translatedRaw?.filter(
    (c) => c.endSec > clip.startSec && c.startSec < clip.endSec
  );

  if (translated && translated.length > 0) {
    return {
      srt: generateSrtFromTranslatedCues(translated, clip.startSec),
      vtt: generateVttFromTranslatedCues(translated, clip.startSec),
    };
  }

  const resolvedStyle = resolveCaptionStyle(clip);
  const { effectiveWordsPerCue } = getSafeCaptionLayoutMetrics(
    clip.aspectRatio,
    resolvedStyle
  );

  const clipInRange = clip.words.filter(
    (w) => w.endSec > clip.startSec && w.startSec < clip.endSec
  );
  const projInRange = (projectWords ?? []).filter(
    (w) => w.endSec > clip.startSec && w.startSec < clip.endSec
  );
  const baseWords =
    projInRange.length > clipInRange.length &&
    projInRange.some((w) => w.kind !== 'sound_event')
      ? projInRange
      : clipInRange.length > 0
        ? clipInRange
        : clip.words;

  const filteredWords = filterWordsForCaptions(
    baseWords,
    Boolean(clip.removeFillers)
  );

  const trackCues = buildCaptionTrackCues({
    words: filteredWords,
    startSec: clip.startSec,
    endSec: clip.endSec,
    wordsPerCue: effectiveWordsPerCue,
  });

  if (trackCues.length > 0) {
    const cuesForExport = trackCues.map((c) => ({
      startSec: c.startSec,
      endSec: c.endSec,
      text: c.text,
    }));
    return {
      srt: generateSrtFromTranslatedCues(cuesForExport, clip.startSec),
      vtt: generateVttFromTranslatedCues(cuesForExport, clip.startSec),
    };
  }

  const fallbackWords = clip.captionText
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w, idx) => ({
      word: w,
      startSec: clip.startSec + idx * 0.45,
      endSec: clip.startSec + (idx + 1) * 0.45,
      speaker: clip.speaker,
      confidence: 1,
    }));

  return {
    srt: generateSrtFromWords(fallbackWords, clip.startSec, effectiveWordsPerCue),
    vtt: generateVttFromWords(fallbackWords, clip.startSec, effectiveWordsPerCue),
  };
}

function buildSocialCopyText(clip: Clip): string {
  const lines = [
    `Title: ${clip.metadata.primaryTitle}`,
    '',
    'Alternative Titles:',
    ...clip.metadata.alternativeTitles.map((t, i) => `  ${i + 1}. ${t}`),
    '',
    `Description: ${clip.metadata.description}`,
    '',
    `Hashtags: ${clip.metadata.hashtags.join(' ')}`,
    '',
    '--- Platform Captions ---',
    `TikTok:   ${clip.metadata.platformCaptions.tiktok}`,
    `Reels:    ${clip.metadata.platformCaptions.reels}`,
    `Shorts:   ${clip.metadata.platformCaptions.shorts}`,
    `LinkedIn: ${clip.metadata.platformCaptions.linkedin}`,
    '',
    `Viral Score Estimate: ${clip.score.overallEstimate}/100 (Estimate, not a guarantee)`,
  ];
  return `${lines.join('\n')}\n`;
}

export async function renderClipToFormat(params: {
  project: Project;
  clip: Clip;
  quality: ExportQuality;
  aspectRatio: AspectRatio;
  burnCaptions: boolean;
  containerFormat: ExportContainerFormat;
  outputPath: string;
  brandKit?: Partial<BrandKit>;
  fastPreview?: boolean;
  onProgress?: (pct: number) => void;
}): Promise<void> {
  const {
    project,
    clip,
    quality,
    aspectRatio,
    burnCaptions,
    containerFormat,
    outputPath,
    brandKit,
    fastPreview = false,
    onProgress,
  } = params;

  await ensureStorageDirs();
  const source = await resolveClipSourceVideo(project, clip);
  const effectiveQuality: ExportQuality = containerFormat === 'gif' ? '480p' : quality;
  const { width, height } = getTargetDimensions(aspectRatio, effectiveQuality);

  // Detect whether the source container actually has an audio stream
  let hasAudio = true;
  if (!project.isDemo) {
    try {
      const probed = await probeVideoFile(source.inputPath, 0);
      hasAudio = Boolean(probed.audioCodec);
    } catch {
      hasAudio = true;
    }
  }

  // Compute silence/filler cuts for this clip
  const effectiveTimeline = computeEffectiveTimeline({
    startSec: clip.startSec,
    endSec: clip.startSec + source.durationSec,
    silences: project.silences ?? [],
    removeSilences: Boolean(clip.removeSilences),
    words: clip.words,
    removeFillers: Boolean(clip.removeFillers),
  });

  const keepSegments = computeKeepSegments(
    clip.startSec,
    clip.startSec + source.durationSec,
    effectiveTimeline.skippedRanges
  );

  const isAudioOnly = containerFormat === 'mp3';
  const isGif = containerFormat === 'gif';
  const shouldBurnCaptions = burnCaptions && !isAudioOnly;

  let assPath: string | undefined;
  if (shouldBurnCaptions) {
    const resolvedStyle = resolveClipCaptionStyle(clip);
    const assContent = generateAssSubtitles({
      clip,
      projectWords: project.transcript?.words,
      resolvedStyle,
      width,
      height,
      clipDurationSec: source.durationSec,
      brandKit,
      keepSegments,
    });
    assPath = `${outputPath}.ass`;
    await fs.writeFile(assPath, assContent, 'utf8');
  }

  const backgroundStyle = resolveClipBackgroundStyle(clip);
  const soundtrackPath =
    !isGif && clip.soundtrackId && clip.soundtrackId !== 'none'
      ? await ensureSoundtrackFile(clip.soundtrackId)
      : null;

  if (isAudioOnly && !hasAudio && !soundtrackPath) {
    throw new Error(
      'This clip has no audio track or soundtrack selected. Choose a soundtrack or export as MP4/MOV/WebM.'
    );
  }

  let graph = buildClipRenderFilterGraph({
    width,
    height,
    cropOffsetX: clip.cropOffsetX,
    backgroundBlurFill: backgroundStyle === 'blur_fill',
    backgroundStyle,
    assFilePath: assPath,
    autoZoom: Boolean(clip.autoZoom),
    keepSegments,
    clipDurationSec: source.durationSec,
    includeVideo: !isAudioOnly,
    hasAudio: hasAudio && !isGif,
    hasSoundtrack: Boolean(soundtrackPath) && !isGif,
    soundtrackVolume: clip.soundtrackVolume ?? 0.22,
  });

  if (isGif && graph.videoMap) {
    const gifGraph = appendGifPaletteFilter(graph.filterComplex, graph.videoMap);
    graph = {
      ...graph,
      filterComplex: gifGraph.filterComplex,
      videoMap: gifGraph.videoMap,
      audioMap: null,
    };
  }

  const fmtSpec = getExportFormatOption(containerFormat);
  const tmpOutPath = `${outputPath}.tmp.${fmtSpec.extension}`;
  const args: string[] = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-progress',
    'pipe:1',
  ];

  if (source.seekSec > 0) {
    args.push('-ss', source.seekSec.toFixed(2));
  }

  args.push('-i', source.inputPath);

  if (soundtrackPath) {
    args.push('-i', soundtrackPath);
  }

  args.push('-t', source.durationSec.toFixed(2));

  if (graph.filterComplex.trim().length > 0) {
    args.push('-filter_complex', graph.filterComplex);
  }

  if (!isAudioOnly && graph.videoMap) {
    args.push('-map', graph.videoMap);
  }

  if (graph.audioMap && !isGif) {
    args.push('-map', graph.audioMap);
  }

  const codecArgs = buildContainerEncodingArgs({
    containerFormat,
    quality: effectiveQuality,
    hasAudio: Boolean(graph.audioMap) && !isGif,
    fastPreview,
  });

  args.push(...codecArgs, tmpOutPath);

  const expectedOutDur = Math.max(
    0.5,
    keepSegments.reduce((acc, seg) => acc + Math.max(0, seg.relEnd - seg.relStart), 0)
  );

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderrText = '';

      child.stdout.on('data', (chunk: Buffer) => {
        const lines = chunk.toString('utf8').split(/\r?\n/);
        for (const line of lines) {
          if (line.startsWith('out_time_us=')) {
            const us = Number(line.slice('out_time_us='.length));
            if (Number.isFinite(us) && expectedOutDur > 0) {
              const pct = Math.max(
                5,
                Math.min(95, Math.round((us / 1_000_000 / expectedOutDur) * 94))
              );
              onProgress?.(pct);
            }
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString('utf8');
      });

      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              stderrText.trim() || `FFmpeg exited with status code ${code ?? 'unknown'}.`
            )
          );
        }
      });
    });

    // Verify rendered file with FFprobe so unplayable outputs never reach the user
    await verifyRenderedMediaPlayable(tmpOutPath, containerFormat);
    await fs.rename(tmpOutPath, outputPath);
  } catch (err) {
    await fs.rm(tmpOutPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    if (assPath) {
      await fs.rm(assPath, { force: true }).catch(() => {});
    }
  }
}

export async function renderClipToMp4(params: {
  project: Project;
  clip: Clip;
  quality: ExportQuality;
  aspectRatio: AspectRatio;
  burnCaptions: boolean;
  outputMp4Path: string;
  brandKit?: Partial<BrandKit>;
  fastPreview?: boolean;
  onProgress?: (pct: number) => void;
}): Promise<void> {
  return renderClipToFormat({
    project: params.project,
    clip: params.clip,
    quality: params.quality,
    aspectRatio: params.aspectRatio,
    burnCaptions: params.burnCaptions,
    containerFormat: 'mp4',
    outputPath: params.outputMp4Path,
    brandKit: params.brandKit,
    fastPreview: params.fastPreview,
    onProgress: params.onProgress,
  });
}

async function executeExportRecord(record: InternalExportRecord): Promise<void> {
  const { job, project, clip, brandKit } = record;
  const containerFormat = normalizeExportContainerFormat(job.containerFormat);
  const fmtSpec = getExportFormatOption(containerFormat);

  job.status = 'running';
  job.progressPct = 5;
  job.error = undefined;
  job.updatedAt = new Date().toISOString();

  try {
    await ensureStorageDirs();

    if (job.kind === 'mp4') {
      const activeVersion = clip.versions?.find((v) => v.id === clip.activeVersionId);
      const versionTag = activeVersion ? `_${slugifyFilename(activeVersion.label, 'ver-1')}` : '';
      const qualLabel = fmtSpec.supportsResolution ? `${job.quality} ` : '';
      job.message = `Encoding ${activeVersion ? `${activeVersion.label} · ` : ''}${qualLabel}${fmtSpec.label}${job.burnCaptions && fmtSpec.supportsBurnCaptions ? ' with burned-in captions' : ''}...`;
      const slug = slugifyFilename(clip.title, clip.id);
      const langSuffix =
        job.subtitleLanguage && job.subtitleLanguage !== 'original'
          ? `_${job.subtitleLanguage}`
          : '';
      const qualityPart = fmtSpec.supportsResolution
        ? `_${job.aspectRatio.replace(':', 'x')}_${job.quality}`
        : containerFormat === 'gif'
          ? `_${job.aspectRatio.replace(':', 'x')}_gif`
          : '_audio';
      const downloadName = `${slug}${versionTag}${qualityPart}${langSuffix}.${fmtSpec.extension}`;
      const diskFile = getExportFilePath(`${job.id}.${fmtSpec.extension}`);

      await renderClipToFormat({
        project,
        clip,
        quality: job.quality,
        aspectRatio: job.aspectRatio,
        burnCaptions: job.burnCaptions,
        containerFormat,
        outputPath: diskFile,
        brandKit,
        onProgress: (pct) => {
          job.progressPct = pct;
          job.updatedAt = new Date().toISOString();
        },
      });

      const stat = await fs.stat(diskFile);
      const signed = signExportDownloadUrl(job.id, 3600);

      record.outputFilePath = diskFile;
      record.contentType = fmtSpec.mimeType;
      job.filename = downloadName;
      job.fileSizeBytes = stat.size;
      job.downloadUrl = signed.url;
      job.previewUrl = fmtSpec.supportsInlineVideoPreview ? `${signed.url}&inline=1` : undefined;
      job.expiresAt = signed.expiresAt;
      job.progressPct = 100;
      job.status = 'completed';
      job.message = `Verified playable · ${qualLabel}${fmtSpec.label}`;
      job.updatedAt = new Date().toISOString();

      await writeExportMetaSidecar({
        jobId: job.id,
        outputFilePath: diskFile,
        filename: downloadName,
        contentType: fmtSpec.mimeType,
        kind: 'mp4',
        containerFormat,
        fileSizeBytes: stat.size,
      });

      record.onJobUpdated?.(job);
      return;
    }

    // Batch ZIP export (all selected edited clips rendered in the user's chosen format!)
    const targetClipIds =
      job.clipIds && job.clipIds.length > 0
        ? job.clipIds
        : project.clips.map((c) => c.id);
    const clipsToPack = project.clips.filter((c) => targetClipIds.includes(c.id));
    if (clipsToPack.length === 0) {
      throw new Error('No clips selected for batch ZIP export.');
    }

    const entries: ZipEntryInput[] = [];
    const tempFiles: string[] = [];

    try {
      for (let i = 0; i < clipsToPack.length; i += 1) {
        const c = clipsToPack[i];
        const activeVer = c.versions?.find((v) => v.id === c.activeVersionId);
        const verPart = activeVer ? `_${slugifyFilename(activeVer.label, 'ver-1')}` : '';
        const prefix = `clip_${String(i + 1).padStart(2, '0')}_${slugifyFilename(c.title, c.id)}`;
        const basePct = Math.round((i / clipsToPack.length) * 90);
        const spanPct = Math.round(90 / clipsToPack.length);

        job.message = `Rendering ${fmtSpec.label} clip ${i + 1} of ${clipsToPack.length}: ${c.title}`;
        job.progressPct = Math.max(5, basePct);
        job.updatedAt = new Date().toISOString();

        const tmpMediaPath = getExportFilePath(`${job.id}_part_${i}.${fmtSpec.extension}`);
        tempFiles.push(tmpMediaPath);

        await renderClipToFormat({
          project,
          clip: c,
          quality: job.quality,
          aspectRatio: c.aspectRatio,
          burnCaptions: job.burnCaptions,
          containerFormat,
          outputPath: tmpMediaPath,
          brandKit,
          onProgress: (subPct) => {
            job.progressPct = Math.min(92, basePct + Math.round((subPct / 100) * spanPct));
            job.updatedAt = new Date().toISOString();
          },
        });

        const mediaBuf = await fs.readFile(tmpMediaPath);
        const subs = buildClipSubtitlesText(c, project.transcript?.words);
        const copyTxt = buildSocialCopyText(c);
        const fileQualifier = fmtSpec.supportsResolution ? `_${job.quality}` : '';

        entries.push(
          {
            name: `${prefix}/${prefix}${verPart}${fileQualifier}.${fmtSpec.extension}`,
            data: mediaBuf,
            storeOnly: true,
          },
          { name: `${prefix}/${prefix}.srt`, data: Buffer.from(subs.srt, 'utf8') },
          { name: `${prefix}/${prefix}.vtt`, data: Buffer.from(subs.vtt, 'utf8') },
          { name: `${prefix}/social-copy.txt`, data: Buffer.from(copyTxt, 'utf8') }
        );
      }

      job.message = `Packaging ${clipsToPack.length} ${fmtSpec.label} clip(s) into ZIP bundle...`;
      job.progressPct = 95;
      job.updatedAt = new Date().toISOString();

      const zipBuf = buildZipArchive(entries);
      const zipDiskPath = getExportFilePath(`${job.id}.zip`);
      await fs.writeFile(zipDiskPath, zipBuf);

      const stat = await fs.stat(zipDiskPath);
      const signed = signExportDownloadUrl(job.id, 3600);
      const projSlug = slugifyFilename(project.title, project.id);
      const zipName = `${projSlug}_all_clips_${fmtSpec.extension}_${job.quality}.zip`;

      record.outputFilePath = zipDiskPath;
      record.contentType = 'application/zip';
      job.filename = zipName;
      job.fileSizeBytes = stat.size;
      job.downloadUrl = signed.url;
      job.expiresAt = signed.expiresAt;
      job.progressPct = 100;
      job.status = 'completed';
      job.message = `Ready · ${clipsToPack.length} ${fmtSpec.label} clip(s) + SRT/VTT/Copy ZIP`;
      job.updatedAt = new Date().toISOString();

      await writeExportMetaSidecar({
        jobId: job.id,
        outputFilePath: zipDiskPath,
        filename: zipName,
        contentType: 'application/zip',
        kind: 'batch_zip',
        containerFormat,
        fileSizeBytes: stat.size,
      });

      record.onJobUpdated?.(job);
    } finally {
      await Promise.all(tempFiles.map((f) => fs.rm(f, { force: true }).catch(() => {})));
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'FFmpeg render failed.';
    job.status = 'failed';
    job.error = errMsg;
    job.message = 'Render failed — click Retry to try again.';
    job.updatedAt = new Date().toISOString();
    record.onJobUpdated?.(job);
  }
}

function drainQueue(): void {
  while (activeRenderCount < MAX_CONCURRENT_RENDERS && pendingQueue.length > 0) {
    const nextJobId = pendingQueue.shift();
    if (!nextJobId) break;
    const rec = exportStore.get(nextJobId);
    if (!rec) continue;

    activeRenderCount += 1;
    void executeExportRecord(rec).finally(() => {
      activeRenderCount = Math.max(0, activeRenderCount - 1);
      drainQueue();
    });
  }
}

export function enqueueSingleClipExport(params: {
  project: Project;
  clip: Clip;
  quality: ExportQuality;
  containerFormat?: ExportContainerFormat;
  aspectRatio?: AspectRatio;
  burnCaptions: boolean;
  platformPreset?: SocialExportPreset;
  brandKit?: Partial<BrandKit>;
  ownerUid?: string;
  onJobUpdated?: (job: ExportJob) => void;
}): ExportJob {
  const now = new Date().toISOString();
  const jobId = `exp_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const aspectRatio = params.aspectRatio ?? params.clip.aspectRatio;
  const platformPreset = params.platformPreset ?? 'custom';
  const containerFormat = normalizeExportContainerFormat(params.containerFormat);
  const quality = normalizeExportQuality(params.quality);
  const fmtSpec = getExportFormatOption(containerFormat);

  const job: ExportJob = {
    id: jobId,
    projectId: params.project.id,
    clipId: params.clip.id,
    clipTitle: params.clip.title,
    kind: 'mp4',
    containerFormat,
    format: `${containerFormat}_${quality}`,
    quality,
    aspectRatio,
    platformPreset,
    burnCaptions: params.burnCaptions,
    subtitleLanguage: params.clip.subtitleLanguage || 'original',
    status: 'queued',
    progressPct: 0,
    message: `Queued for ${fmtSpec.label} FFmpeg render worker...`,
    attempt: 1,
    createdAt: now,
    updatedAt: now,
  };

  exportStore.set(jobId, {
    job,
    ownerUid: params.ownerUid,
    onJobUpdated: params.onJobUpdated,
    contentType: fmtSpec.mimeType,
    project: params.project,
    clip: { ...params.clip },
    brandKit: params.brandKit,
  });

  params.onJobUpdated?.(job);
  pendingQueue.push(jobId);
  drainQueue();
  return job;
}

export function enqueueBatchZipExport(params: {
  project: Project;
  clipIds?: string[];
  quality: ExportQuality;
  containerFormat?: ExportContainerFormat;
  burnCaptions: boolean;
  brandKit?: Partial<BrandKit>;
  ownerUid?: string;
  onJobUpdated?: (job: ExportJob) => void;
}): ExportJob {
  const now = new Date().toISOString();
  const jobId = `zip_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const containerFormat = normalizeExportContainerFormat(params.containerFormat);
  const quality = normalizeExportQuality(params.quality);
  const fmtSpec = getExportFormatOption(containerFormat);
  const selectedIds =
    params.clipIds && params.clipIds.length > 0
      ? params.clipIds
      : params.project.clips.map((c) => c.id);
  const firstClip = params.project.clips[0];

  const job: ExportJob = {
    id: jobId,
    projectId: params.project.id,
    clipId: firstClip?.id ?? 'batch',
    clipIds: selectedIds,
    clipTitle: `All Clips Bundle (${selectedIds.length} ${fmtSpec.label}${selectedIds.length === 1 ? '' : 's'})`,
    kind: 'batch_zip',
    containerFormat,
    format: `zip_${containerFormat}_${quality}`,
    quality,
    aspectRatio: firstClip?.aspectRatio ?? '9:16',
    platformPreset: 'custom',
    burnCaptions: params.burnCaptions,
    status: 'queued',
    progressPct: 0,
    message: `Queued batch ${fmtSpec.label} render for ${selectedIds.length} clip(s)...`,
    attempt: 1,
    createdAt: now,
    updatedAt: now,
  };

  exportStore.set(jobId, {
    job,
    ownerUid: params.ownerUid,
    onJobUpdated: params.onJobUpdated,
    contentType: 'application/zip',
    project: params.project,
    clip: firstClip ? { ...firstClip } : ({} as Clip),
    brandKit: params.brandKit,
  });

  params.onJobUpdated?.(job);
  pendingQueue.push(jobId);
  drainQueue();
  return job;
}

export function retryExportJob(jobId: string): ExportJob | null {
  const rec = exportStore.get(jobId);
  if (!rec) return null;
  if (rec.job.status === 'running' || rec.job.status === 'queued') {
    return rec.job;
  }

  rec.job.status = 'queued';
  rec.job.progressPct = 0;
  rec.job.error = undefined;
  rec.job.attempt += 1;
  rec.job.message = `Retry attempt #${rec.job.attempt} queued...`;
  rec.job.updatedAt = new Date().toISOString();

  pendingQueue.push(jobId);
  drainQueue();
  return rec.job;
}

function refreshSignedUrlIfNeeded(rec: InternalExportRecord): ExportJob {
  const { job } = rec;
  if (job.status === 'completed' && rec.outputFilePath) {
    const expMs = job.expiresAt ? Date.parse(job.expiresAt) : 0;
    // Automatically refresh links within 10 minutes of expiry so user downloads never fail with 403
    if (!Number.isFinite(expMs) || expMs - Date.now() < 10 * 60 * 1000) {
      const signed = signExportDownloadUrl(job.id, 3600);
      const fmtSpec = getExportFormatOption(job.containerFormat);
      job.downloadUrl = signed.url;
      job.previewUrl =
        job.kind === 'mp4' && fmtSpec.supportsInlineVideoPreview
          ? `${signed.url}&inline=1`
          : undefined;
      job.expiresAt = signed.expiresAt;
    }
  }
  return job;
}

export function listExportJobs(filter?: { projectId?: string; clipId?: string }): ExportJob[] {
  const all = Array.from(exportStore.values()).map((r) => refreshSignedUrlIfNeeded(r));
  return all
    .filter((job) => {
      if (filter?.projectId && job.projectId !== filter.projectId) return false;
      if (filter?.clipId && job.clipId !== filter.clipId) return false;
      return true;
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getExportRecord(jobId: string): InternalExportRecord | undefined {
  const rec = exportStore.get(jobId);
  if (rec) {
    refreshSignedUrlIfNeeded(rec);
  }
  return rec;
}
