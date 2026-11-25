import fs from 'node:fs/promises';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type {
  Clip,
  ClipDurationPreset,
  PipelineStage,
  ProcessingJob,
  Project,
  Transcript,
  TranscriptWord,
  TranslatedSubtitleCue,
} from '../../src/types/clipgenius';
import {
  buildDiarizationLanguageInstruction,
  normalizeCaptionLanguageCode,
} from '../../src/lib/captionLanguages';
import { buildCaptionTrackCues } from '../../src/lib/editorEngine';
import {
  detectSceneCuts,
  extractAudioAndDetectSilences,
  extractAudioSliceFromMp3,
  extractClipAudioSegment,
} from '../media/ffmpegAnalysis';
import { getMediaFilePath, sanitizeStorageKey } from '../storage/storageAdapter';
import {
  alignSegmentWords,
  buildRankedClipsFromCandidates,
  type DiarizedSegment,
  type RawHighlightCandidate,
  type SilenceInterval,
} from './clipPostProcess';
import {
  buildClipTranscriptionWindows,
  buildProjectTranscriptionWindows,
  countSpokenWordsInSegments,
  extractConsolidatedSpeakers,
  isPlaceholderNonSpeechText,
  mergeSpeechAndSoundSegments,
  normalizeAndConsolidateSpeakers,
  parseTimestampToSeconds,
} from './speechDetection';

interface PipelineCache {
  audioPath?: string;
  silences?: SilenceInterval[];
  verbatimTranscript?: string;
  language?: string;
  speakers?: string[];
  diarizedSegments?: DiarizedSegment[];
  words?: TranscriptWord[];
  sceneCuts?: number[];
  topics?: { title: string; startSec: number; endSec: number; summary: string }[];
  candidates?: RawHighlightCandidate[];
}

interface PipelineRunState {
  running: boolean;
  cache: PipelineCache;
}

const projectPipelineStates = new Map<string, PipelineRunState>();
const projectListeners = new Map<string, Set<(project: Project) => void>>();

export function subscribeProjectUpdates(
  projectId: string,
  listener: (project: Project) => void
): () => void {
  let set = projectListeners.get(projectId);
  if (!set) {
    set = new Set();
    projectListeners.set(projectId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

function emitProjectUpdate(project: Project) {
  const listeners = projectListeners.get(project.id);
  if (!listeners) return;
  for (const fn of listeners) {
    fn(project);
  }
}

const STAGE_ORDER: PipelineStage[] = [
  'audio_extract',
  'transcription',
  'diarization',
  'scene_detection',
  'topic_segmentation',
  'highlight_detection',
  'clip_ranking',
];

function ensureStageEntries(project: Project) {
  const existingMap = new Map(project.processingStages.map((s) => [s.stage, s]));
  project.processingStages = STAGE_ORDER.map((stage, idx) => {
    const existing = existingMap.get(stage);
    if (existing) return existing;
    return {
      id: `stg_${project.id}_${idx + 1}`,
      projectId: project.id,
      stage,
      status: 'queued',
      progressPct: 0,
      message: 'Queued',
      updatedAt: new Date().toISOString(),
    };
  });
}

function setStageStatus(
  project: Project,
  stage: PipelineStage,
  patch: Partial<ProcessingJob>
) {
  const target = project.processingStages.find((s) => s.stage === stage);
  if (target) {
    Object.assign(target, patch, { updatedAt: new Date().toISOString() });
  }
  emitProjectUpdate(project);
}

function isTransientHighDemandError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /503|429|UNAVAILABLE|high demand|overloaded|RESOURCE_EXHAUSTED|timed out|ETIMEDOUT|ECONNRESET|fetch failed/i.test(
    msg
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function generateWithFallback(
  aiClient: GoogleGenAI,
  primaryModel: string,
  fallbackModels: string[],
  params: Omit<Parameters<GoogleGenAI['models']['generateContent']>[0], 'model'>,
  lowLatencyThinking: boolean = false,
  perAttemptTimeoutMs: number = 45000
) {
  const models = [primaryModel, ...fallbackModels];
  let lastErr: unknown;

  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < models.length; i += 1) {
      const model = models[i];
      const supportsThinkingLevel =
        (model.startsWith('gemini-4') || model.startsWith('gemini-3')) &&
        !model.includes('transcribe');
      const mergedConfig =
        lowLatencyThinking && supportsThinkingLevel
          ? {
              ...(params.config ?? {}),
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            }
          : params.config;

      try {
        return await withTimeout(
          aiClient.models.generateContent({
            ...params,
            ...(mergedConfig ? { config: mergedConfig } : {}),
            model,
          }),
          perAttemptTimeoutMs,
          `Model ${model}`
        );
      } catch (err) {
        lastErr = err;
        const isLastTryOverall = pass === 1 && i === models.length - 1;
        if (!isTransientHighDemandError(err) || isLastTryOverall) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, pass === 0 ? 500 : 1400));
      }
    }
  }
  throw lastErr;
}

function formatSecAsClock(sec: number): string {
  const safe = Math.max(0, sec);
  const mins = Math.floor(safe / 60);
  const rem = safe - mins * 60;
  return `${String(mins).padStart(2, '0')}:${rem.toFixed(2).padStart(5, '0')}`;
}

interface RawModelTimedSegment {
  startTime?: string | number;
  endTime?: string | number;
  startSec?: number | string;
  endSec?: number | string;
  speaker?: string;
  text?: string;
  kind?: string;
  soundCategory?: string;
}

function normalizeModelTimedSegments(
  rawSegments: RawModelTimedSegment[] | undefined
): DiarizedSegment[] {
  const out: DiarizedSegment[] = [];
  for (const s of rawSegments ?? []) {
    const text = typeof s?.text === 'string' ? s.text.trim() : '';
    if (!text) continue;
    const parsedStart =
      parseTimestampToSeconds(s.startTime) ?? parseTimestampToSeconds(s.startSec);
    const parsedEnd =
      parseTimestampToSeconds(s.endTime) ?? parseTimestampToSeconds(s.endSec);
    if (parsedStart === null) continue;
    const endVal =
      parsedEnd !== null && parsedEnd > parsedStart ? parsedEnd : parsedStart + 1.5;
    out.push({
      startSec: parsedStart,
      endSec: endVal,
      speaker: s.speaker || 'Speaker 1',
      text,
      kind: s.kind === 'sound_event' ? 'sound_event' : 'speech',
      soundCategory: s.soundCategory,
    });
  }
  return out;
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIdx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIdx < items.length) {
      const idx = nextIdx;
      nextIdx += 1;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function runProjectAnalysisPipeline(params: {
  project: Project;
  rawVideoPath: string;
  aiClient: GoogleGenAI | null;
  targetClipDurationSec?: ClipDurationPreset;
  captionLanguage?: string;
  resume?: boolean;
}): Promise<void> {
  const {
    project,
    rawVideoPath,
    aiClient,
    targetClipDurationSec = 30,
    captionLanguage = 'en',
    resume = true,
  } = params;
  const normalizedCaptionLang = normalizeCaptionLanguageCode(captionLanguage);
  const captionLangPrompt = buildDiarizationLanguageInstruction(normalizedCaptionLang);

  let state = projectPipelineStates.get(project.id);
  if (state?.running) {
    return;
  }
  if (!state) {
    state = { running: true, cache: {} };
    projectPipelineStates.set(project.id, state);
  } else {
    state.running = true;
  }

  ensureStageEntries(project);

  // If not resuming, reset all stage statuses
  if (!resume) {
    state.cache = {};
    for (const stg of project.processingStages) {
      stg.status = 'queued';
      stg.progressPct = 0;
      stg.message = 'Queued';
    }
  }

  project.status = 'processing';
  emitProjectUpdate(project);

  const isStageDone = (stage: PipelineStage) =>
    resume && project.processingStages.find((s) => s.stage === stage)?.status === 'completed';

  try {
    // Stage 1: Audio extraction & silence detection (FFmpeg)
    if (!isStageDone('audio_extract') || !state.cache.audioPath) {
      setStageStatus(project, 'audio_extract', {
        status: 'running',
        progressPct: 35,
        message: 'Extracting 16 kHz mono audio and running silence detection...',
      });

      const audioOutPath = getMediaFilePath(sanitizeStorageKey(`audio_${project.id}.mp3`));
      const extracted = await extractAudioAndDetectSilences(rawVideoPath, audioOutPath);

      if (!extracted.hasAudio) {
        throw new Error(
          'No audible audio track found in this video. Speech transcription requires an audio stream.'
        );
      }

      state.cache.audioPath = extracted.audioPath;
      state.cache.silences = extracted.silences;
      project.silenceCount = extracted.silences.length;
      project.silences = extracted.silences;

      setStageStatus(project, 'audio_extract', {
        status: 'completed',
        progressPct: 100,
        message: `Extracted mono MP3 · detected ${extracted.silences.length} silence gaps`,
      });
    }

    // Check Gemini server client before AI stages
    if (!aiClient) {
      setStageStatus(project, 'transcription', {
        status: 'requires_configuration',
        progressPct: 0,
        message:
          'Requires GEMINI_API_KEY in server environment (Settings > Secrets) to run transcription and highlight scoring.',
      });
      project.status = 'error';
      emitProjectUpdate(project);
      return;
    }

    const totalDurationSec = Math.max(1, project.video.durationSec || 30);
    const projectWindows = buildProjectTranscriptionWindows(totalDurationSec);
    const isMultiWindowVideo = projectWindows.length > 1;

    // Prepare audio input for single-window short videos (multi-window videos slice inline per window)
    let uploadedFileName: string | undefined;
    let audioPart:
      | { inlineData: { mimeType: string; data: string } }
      | { fileData: { mimeType: string; fileUri: string } }
      | undefined;

    if (!isMultiWindowVideo) {
      const audioBytes = await fs.readFile(state.cache.audioPath!);
      if (audioBytes.length <= 14 * 1024 * 1024) {
        audioPart = {
          inlineData: {
            mimeType: 'audio/mp3',
            data: audioBytes.toString('base64'),
          },
        };
      } else {
        const uploaded = await aiClient.files.upload({
          file: state.cache.audioPath!,
          config: { mimeType: 'audio/mp3' },
        });
        uploadedFileName = uploaded.name;
        audioPart = {
          fileData: {
            mimeType: uploaded.mimeType ?? 'audio/mp3',
            fileUri: uploaded.uri ?? '',
          },
        };
      }
    }

    try {
      // Stage 2: Audio Speech Transcription
      if (!isStageDone('transcription') || state.cache.verbatimTranscript === undefined) {
        if (isMultiWindowVideo) {
          setStageStatus(project, 'transcription', {
            status: 'completed',
            progressPct: 100,
            message: `Segmented ${(totalDurationSec / 60).toFixed(1)}m vocal track into ${projectWindows.length} precision-synced windows`,
          });
          state.cache.verbatimTranscript = '';
        } else {
          setStageStatus(project, 'transcription', {
            status: 'running',
            progressPct: 40,
            message: 'Listening to vocal-enhanced audio for spoken English words & voices...',
          });

          let rawText = '';
          try {
            const transcribeRes = await generateWithFallback(
              aiClient,
              'gemini-3.5-transcribe',
              [],
              {
                contents: {
                  parts: [
                    audioPart!,
                    {
                      text:
                        normalizedCaptionLang === 'en'
                          ? 'Listen carefully to every human voice in this audio, including quiet voices, accents, or speech over background music. Transcribe all spoken words accurately into natural English.'
                          : 'Listen carefully to every human voice in this audio, including quiet voices, accents, or speech over background music. Transcribe all spoken words verbatim.',
                    },
                  ],
                },
              },
              false,
              65000
            );
            rawText = (transcribeRes.text ?? '').trim();
          } catch {
            rawText = '';
          }

          if (isPlaceholderNonSpeechText(rawText)) {
            try {
              const fallbackRes = await generateWithFallback(
                aiClient,
                'gemini-3.8-flash',
                ['gemini-3.1-flash-lite'],
                {
                  contents: {
                    parts: [
                      audioPart!,
                      {
                        text:
                          'Listen very carefully to this entire audio track for ANY human voice (especially English speech, soft/distant voices, fast speech, accents, or talking over background music). ' +
                          (normalizedCaptionLang === 'en'
                            ? 'Transcribe EVERY spoken word clearly into English. '
                            : 'Transcribe EVERY spoken word verbatim. ') +
                          'Only respond with [NON_SPEECH_AUDIO] if there is truly zero human speech anywhere in the audio.',
                      },
                    ],
                  },
                },
                true,
                60000
              );
              rawText = (fallbackRes.text ?? '').trim();
            } catch {
              rawText = '';
            }
          }

          const isNonSpeechOnly = isPlaceholderNonSpeechText(rawText);
          state.cache.verbatimTranscript = isNonSpeechOnly ? '' : rawText;

          setStageStatus(project, 'transcription', {
            status: 'completed',
            progressPct: 100,
            message: isNonSpeechOnly
              ? 'Running deep vocal & acoustic scan next...'
              : `Detected ${rawText.split(/\s+/).length} spoken words from video audio`,
          });
        }
      }

      // Stage 3: Precision-Synced Speech Alignment + Sound Events via chunked MM:SS.cc windows
      if (!isStageDone('diarization') || !state.cache.diarizedSegments) {
        setStageStatus(project, 'diarization', {
          status: 'running',
          progressPct: 20,
          message: isMultiWindowVideo
            ? `Transcribing & syncing ${projectWindows.length} audio windows with exact MM:SS.cc timestamps...`
            : 'Detecting voices, syncing English subtitles & classifying audio sounds...',
        });

        let detectedLang = normalizedCaptionLang !== 'original' ? normalizedCaptionLang : 'en';
        let completedWindows = 0;

        const windowSegmentLists = await runWithConcurrency(
          projectWindows,
          5,
          async (win, winIdx): Promise<DiarizedSegment[]> => {
            const winClockEnd = formatSecAsClock(win.durationSec);
            const tmpSlicePath = isMultiWindowVideo
              ? getMediaFilePath(
                  sanitizeStorageKey(`projwin_${project.id}_w${winIdx}_${Date.now()}.mp3`)
                )
              : null;

            try {
              let winAudioPart = audioPart;
              if (isMultiWindowVideo && tmpSlicePath) {
                const sliced = await extractAudioSliceFromMp3({
                  inputMp3Path: state.cache.audioPath!,
                  startSec: win.startSec,
                  durationSec: win.durationSec,
                  outMp3Path: tmpSlicePath,
                });
                if (!sliced) return [];
                const sliceBytes = await fs.readFile(tmpSlicePath);
                winAudioPart = {
                  inlineData: {
                    mimeType: 'audio/mp3',
                    data: sliceBytes.toString('base64'),
                  },
                };
              }

              if (!winAudioPart) return [];

              const winSilences = (state.cache.silences ?? [])
                .filter((s) => s.endSec > win.startSec && s.startSec < win.startSec + win.durationSec)
                .map((s) => ({
                  startSec: Math.max(0, Number((s.startSec - win.startSec).toFixed(2))),
                  endSec: Math.min(
                    win.durationSec,
                    Number((s.endSec - win.startSec).toFixed(2))
                  ),
                  durationSec: s.durationSec,
                }));

              const transcriptHint =
                !isMultiWindowVideo && state.cache.verbatimTranscript
                  ? `Reference speech transcript (verify directly against the audio and include ALL spoken sentences with accurate MM:SS.cc timestamps):\n${state.cache.verbatimTranscript}`
                  : 'Listen directly and intently to the entire audio slice for ANY human voice — especially English speech, soft or accented dialogue, narration, or speech mixed with music. Transcribe EVERY spoken sentence with accurate MM:SS.cc timestamps as kind="speech".';

              const diarizationRes = await generateWithFallback(
                aiClient,
                'gemini-3.8-flash',
                ['gemini-3.1-flash-lite'],
                {
                  contents: {
                    parts: [
                      winAudioPart,
                      {
                        text:
                          `Listen directly to this ${win.durationSec.toFixed(1)}s audio slice (from 00:00.00 to ${winClockEnd}) and produce a chronological subtitle timeline of EVERYTHING audible:\n` +
                          captionLangPrompt +
                          `1. EXACT TIMESTAMPS: Express EVERY startTime and endTime as a string in "MM:SS.cc" format strictly relative to the start of THIS audio slice ("00:00.00" to "${winClockEnd}"). Example: "00:14.50" for 14.5 seconds into this audio, "01:08.20" for 68.2 seconds.\n` +
                          `2. PRIORITY — HUMAN VOICES & SPEECH: Whenever anyone speaks intelligible words (including English speech, quiet voices, narration, dialogue over music, or non-English speech), emit kind="speech" with crisp 3-10 word subtitle sentences covering the ENTIRE slice from 00:00.00 to ${winClockEnd}.\n` +
                          `3. SPEAKER GROUPING RULE: Default to "Speaker 1" for narration or single-host audio. ONLY assign "Speaker 2" (up to max 4 speakers total) when you clearly hear a distinct second human voice in conversation. NEVER create a new speaker number for each sentence.\n` +
                          `4. NON-SPEECH SOUNDS: During moments without speaking, emit kind="sound_event" with soundCategory and a concise bracketed label like "[Laughing]", "[Music playing]", "[Applause]".\n` +
                          `Do NOT invent words that are not spoken, and do NOT use filenames or titles as captions.\n\n` +
                          transcriptHint,
                      },
                    ],
                  },
                  config: {
                    systemInstruction:
                      'You are an expert multimodal speech-to-text transcriber and subtitle timing engine. Always output exact "MM:SS.cc" timestamps strictly relative to 00:00.00 of the attached audio clip. Reuse consistent speaker labels (defaulting to "Speaker 1"; max 4 distinct voices).',
                    responseMimeType: 'application/json',
                    responseSchema: {
                      type: Type.OBJECT,
                      required: ['language', 'segments'],
                      properties: {
                        language: { type: Type.STRING },
                        segments: {
                          type: Type.ARRAY,
                          items: {
                            type: Type.OBJECT,
                            required: ['startTime', 'endTime', 'speaker', 'text', 'kind'],
                            properties: {
                              startTime: {
                                type: Type.STRING,
                                description: 'Start timestamp in MM:SS.cc format relative to 00:00.00 of this audio slice.',
                              },
                              endTime: {
                                type: Type.STRING,
                                description: 'End timestamp in MM:SS.cc format relative to 00:00.00 of this audio slice.',
                              },
                              speaker: { type: Type.STRING },
                              text: { type: Type.STRING },
                              kind: {
                                type: Type.STRING,
                                description: 'Either "speech" or "sound_event".',
                              },
                              soundCategory: {
                                type: Type.STRING,
                                description: 'For sound_event: laughing, crying, singing, humming, applause, cheering, sighing, gasping, whispering, music, screaming, coughing, ambient, or other.',
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
                true,
                60000
              );

              const parsed = JSON.parse((diarizationRes.text ?? '{}').trim()) as {
                language?: string;
                segments?: RawModelTimedSegment[];
              };
              if (winIdx === 0 && parsed.language && normalizedCaptionLang === 'original') {
                detectedLang = parsed.language;
              }

              let rawSegments = normalizeModelTimedSegments(parsed.segments);
              let windowVerbatim = !isMultiWindowVideo ? state.cache.verbatimTranscript ?? '' : '';

              // Vocal-focus rescue if this window returned 0 spoken words
              if (
                countSpokenWordsInSegments(rawSegments) === 0 &&
                isPlaceholderNonSpeechText(windowVerbatim)
              ) {
                try {
                  const transcribeFallback = await withTimeout(
                    aiClient.models.generateContent({
                      model: 'gemini-3.5-transcribe',
                      contents: [
                        winAudioPart,
                        {
                          text:
                            normalizedCaptionLang === 'en'
                              ? 'Listen closely for ANY spoken human voice in this audio slice and transcribe all spoken words accurately into natural English. Return [NON_SPEECH_AUDIO] only if nobody speaks.'
                              : 'Listen closely for ANY spoken human voice in this audio slice and transcribe all spoken words verbatim. Return [NON_SPEECH_AUDIO] only if nobody speaks.',
                        },
                      ],
                    }),
                    40000,
                    `Window ${winIdx + 1} voice rescue`
                  );
                  const rescueText = (transcribeFallback.text ?? '').trim();
                  if (rescueText && !isPlaceholderNonSpeechText(rescueText)) {
                    windowVerbatim = rescueText;
                  }
                } catch {
                  // Keep existing window segments
                }
              }

              return mergeSpeechAndSoundSegments({
                diarizedSegments: rawSegments,
                verbatimTranscript: windowVerbatim,
                durationSec: win.durationSec,
                silences: winSilences,
                offsetSec: win.startSec,
                timestampsAreRelative: true,
                maxSpeakers: 4,
              });
            } catch {
              return [];
            } finally {
              if (tmpSlicePath) {
                await fs.rm(tmpSlicePath, { force: true }).catch(() => {});
              }
              completedWindows += 1;
              if (isMultiWindowVideo) {
                const pct = Math.min(
                  95,
                  20 + Math.round((completedWindows / projectWindows.length) * 75)
                );
                setStageStatus(project, 'diarization', {
                  status: 'running',
                  progressPct: pct,
                  message: `Synced ${completedWindows}/${projectWindows.length} audio windows...`,
                });
              }
            }
          }
        );

        const combinedRaw = windowSegmentLists.flat().sort((a, b) => a.startSec - b.startSec);
        const hasAnyRealSpeech = countSpokenWordsInSegments(combinedRaw) > 0;
        const cleanedCombined = hasAnyRealSpeech
          ? combinedRaw.filter(
              (s) =>
                !(
                  s.kind === 'sound_event' &&
                  /^\[(ambient audio|silence|no speech|non_speech_audio)\]$/i.test(s.text.trim())
                )
            )
          : combinedRaw;

        const segments =
          cleanedCombined.length > 0
            ? normalizeAndConsolidateSpeakers(cleanedCombined, 4)
            : [
                {
                  startSec: 0,
                  endSec: Number(totalDurationSec.toFixed(2)),
                  speaker: 'Audio Event',
                  text: '[Ambient audio]',
                  kind: 'sound_event' as const,
                  soundCategory: 'ambient',
                },
              ];

        const words = alignSegmentWords(segments);
        const soundEventCount = words.filter((w) => w.kind === 'sound_event').length;
        const speechWordCount = words.length - soundEventCount;
        const speakers = extractConsolidatedSpeakers(segments);

        state.cache.language = detectedLang;
        state.cache.speakers = speakers;
        state.cache.diarizedSegments = segments;
        state.cache.words = words;

        const transcript: Transcript = {
          id: `tr_${project.id}`,
          videoId: project.video.id,
          language: state.cache.language,
          speakers,
          words,
        };
        project.transcript = transcript;

        setStageStatus(project, 'diarization', {
          status: 'completed',
          progressPct: 100,
          message: `Synced ${speechWordCount} word(s) & ${soundEventCount} sound event(s) (${speakers.length} voice/audio source${speakers.length === 1 ? '' : 's'})`,
        });
      }

      // Stage 4: Scene Detection via FFmpeg
      if (!isStageDone('scene_detection') || !state.cache.sceneCuts) {
        setStageStatus(project, 'scene_detection', {
          status: 'running',
          progressPct: 50,
          message: 'Scanning visual frames for scene cuts...',
        });

        const cuts = await detectSceneCuts(rawVideoPath);
        state.cache.sceneCuts = cuts;
        project.sceneCutsSec = cuts;

        setStageStatus(project, 'scene_detection', {
          status: 'completed',
          progressPct: 100,
          message: `Detected ${cuts.length} visual scene transitions`,
        });
      }

      // Stage 5: Topic & Moment Segmentation via gemini-3.8-flash
      if (!isStageDone('topic_segmentation') || !state.cache.topics) {
        setStageStatus(project, 'topic_segmentation', {
          status: 'running',
          progressPct: 50,
          message: 'Segmenting video into distinct narrative & emotional moments...',
        });

        const segmentsSummary = (state.cache.diarizedSegments ?? [])
          .map(
            (s) =>
              `[${s.startSec.toFixed(1)}s-${s.endSec.toFixed(1)}s] ${
                s.kind === 'sound_event' ? `SOUND(${s.soundCategory ?? 'other'})` : s.speaker
              }: ${s.text}`
          )
          .join('\n');

        const topicRes = await generateWithFallback(
          aiClient,
          'gemini-3.1-flash-lite',
          ['gemini-3.8-flash'],
          {
            contents: `Segment this ${project.video.durationSec.toFixed(1)}s video timeline into distinct topic/emotional chapters covering the ENTIRE video from start to finish.\nScene cuts at seconds: ${(state.cache.sceneCuts ?? []).join(', ') || 'none'}\n\nAudio & Speech Timeline:\n${segmentsSummary}`,
            config: {
              systemInstruction:
                'Return concise chronological chapters covering the entire video, noting both spoken topics and high-emotion audio moments (laughter, singing, crying, applause, dramatic turns).',
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                required: ['topics'],
                properties: {
                  topics: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      required: ['title', 'startSec', 'endSec', 'summary'],
                      properties: {
                        title: { type: Type.STRING },
                        startSec: { type: Type.NUMBER },
                        endSec: { type: Type.NUMBER },
                        summary: { type: Type.STRING },
                      },
                    },
                  },
                },
              },
            },
          },
          true
        );

        const parsedTopics = JSON.parse((topicRes.text ?? '{}').trim()) as {
          topics?: { title: string; startSec: number; endSec: number; summary: string }[];
        };

        state.cache.topics = parsedTopics.topics ?? [];
        setStageStatus(project, 'topic_segmentation', {
          status: 'completed',
          progressPct: 100,
          message: `Identified ${state.cache.topics.length} distinct video chapter(s)`,
        });
      }

      // Stage 6: Best-Moment Highlight Detection, Scoring & Recommendations via gemini-3.8-flash
      if (!isStageDone('highlight_detection') || !state.cache.candidates) {
        const dur = Math.max(5, project.video.durationSec);
        const targetClipCount =
          dur < 35
            ? 2
            : dur < 120
            ? Math.max(3, Math.min(4, Math.ceil(dur / 28)))
            : Math.min(8, Math.max(4, Math.round(dur / 75)));

        setStageStatus(project, 'highlight_detection', {
          status: 'running',
          progressPct: 55,
          message: `Analyzing full video to recommend ${targetClipCount} distinct best moments...`,
        });

        const segmentsSummary = (state.cache.diarizedSegments ?? [])
          .map(
            (s) =>
              `[${s.startSec.toFixed(1)}s-${s.endSec.toFixed(1)}s] ${
                s.kind === 'sound_event' ? `SOUND(${s.soundCategory ?? 'other'})` : s.speaker
              }: ${s.text}`
          )
          .join('\n');

        const highlightRes = await generateWithFallback(
          aiClient,
          'gemini-3.8-flash',
          ['gemini-3.1-flash-lite'],
          {
            contents:
              `Analyze this ENTIRE ${dur.toFixed(1)}s video and select ${targetClipCount} DISTINCT, NON-OVERLAPPING best highlight moments to recommend to the user.\n` +
              `IMPORTANT RULES:\n` +
              `- NEVER just pick an arbitrary 0s-30s opening slice unless the opening genuinely has the strongest hook.\n` +
              `- Spread recommendations across different standout moments in the video (strongest hooks, emotional peaks, funniest laughter/reactions, singing/musical climaxes, sharpest insights, or dramatic reveals).\n` +
              `- Target ~${Math.min(targetClipDurationSec, Math.max(8, Math.round(dur * 0.65)))}s per clip (strictly within 0s..${dur.toFixed(1)}s and ending on natural sentence or sound boundaries).\n` +
              `- For every clip, explain in "recommendationReason" WHY this specific moment stood out from the rest of the video.\n\n` +
              `Scene cuts (sec): ${(state.cache.sceneCuts ?? []).slice(0, 40).join(', ') || 'none'}\n` +
              `Chapters:\n${JSON.stringify(state.cache.topics)}\n\n` +
              `Audio & Speech Timeline:\n${segmentsSummary}`,
            config: {
              systemInstruction:
                'You are an expert short-form video producer. Analyze the entire audio/speech timeline and recommend distinct, non-overlapping standout moments from different parts of the video — never arbitrary fixed slices. Provide honest 0-100 sub-scores with grounded rationales, a concise recommendationReason, primary + 3 alternative titles, hooks, hashtags, and captions for TikTok, Reels, Shorts, and LinkedIn.',
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                required: ['clips'],
                properties: {
                  clips: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      required: [
                        'title',
                        'startSec',
                        'endSec',
                        'speaker',
                        'summary',
                        'recommendationReason',
                        'criteria',
                        'metadata',
                      ],
                      properties: {
                        title: { type: Type.STRING },
                        startSec: { type: Type.NUMBER },
                        endSec: { type: Type.NUMBER },
                        speaker: { type: Type.STRING },
                        summary: { type: Type.STRING },
                        recommendationReason: { type: Type.STRING },
                        criteria: {
                          type: Type.OBJECT,
                          required: [
                            'hookStrength',
                            'emotionalImpact',
                            'informationValue',
                            'audienceInterest',
                            'storyCompleteness',
                            'shareability',
                          ],
                          properties: {
                            hookStrength: {
                              type: Type.OBJECT,
                              required: ['score', 'rationale'],
                              properties: { score: { type: Type.NUMBER }, rationale: { type: Type.STRING } },
                            },
                            emotionalImpact: {
                              type: Type.OBJECT,
                              required: ['score', 'rationale'],
                              properties: { score: { type: Type.NUMBER }, rationale: { type: Type.STRING } },
                            },
                            informationValue: {
                              type: Type.OBJECT,
                              required: ['score', 'rationale'],
                              properties: { score: { type: Type.NUMBER }, rationale: { type: Type.STRING } },
                            },
                            audienceInterest: {
                              type: Type.OBJECT,
                              required: ['score', 'rationale'],
                              properties: { score: { type: Type.NUMBER }, rationale: { type: Type.STRING } },
                            },
                            storyCompleteness: {
                              type: Type.OBJECT,
                              required: ['score', 'rationale'],
                              properties: { score: { type: Type.NUMBER }, rationale: { type: Type.STRING } },
                            },
                            shareability: {
                              type: Type.OBJECT,
                              required: ['score', 'rationale'],
                              properties: { score: { type: Type.NUMBER }, rationale: { type: Type.STRING } },
                            },
                          },
                        },
                        metadata: {
                          type: Type.OBJECT,
                          required: [
                            'primaryTitle',
                            'alternativeTitles',
                            'description',
                            'hooks',
                            'hashtags',
                            'platformCaptions',
                          ],
                          properties: {
                            primaryTitle: { type: Type.STRING },
                            alternativeTitles: { type: Type.ARRAY, items: { type: Type.STRING } },
                            description: { type: Type.STRING },
                            hooks: { type: Type.ARRAY, items: { type: Type.STRING } },
                            hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
                            platformCaptions: {
                              type: Type.OBJECT,
                              required: ['tiktok', 'reels', 'shorts', 'linkedin'],
                              properties: {
                                tiktok: { type: Type.STRING },
                                reels: { type: Type.STRING },
                                shorts: { type: Type.STRING },
                                linkedin: { type: Type.STRING },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          true
        );

        const parsedHighlights = JSON.parse((highlightRes.text ?? '{}').trim()) as {
          clips?: RawHighlightCandidate[];
        };
        const candidates = parsedHighlights.clips ?? [];
        if (candidates.length === 0) {
          throw new Error('Highlight detection returned zero candidate clips.');
        }

        state.cache.candidates = candidates;
        setStageStatus(project, 'highlight_detection', {
          status: 'completed',
          progressPct: 100,
          message: `Recommended ${candidates.length} distinct standout moment(s)`,
        });
      }

      // Stage 7: Candidate Clip Snapping, Deduplication, Version Generation & Ranking
      setStageStatus(project, 'clip_ranking', {
        status: 'running',
        progressPct: 70,
        message: 'Ranking best moments & generating Ver-1 to Ver-4 creative variants...',
      });

      const rankedClips = buildRankedClipsFromCandidates({
        projectId: project.id,
        candidates: state.cache.candidates ?? [],
        words: state.cache.words ?? [],
        maxDurationSec: project.video.durationSec,
        thumbnailUrl: project.video.thumbnailUrl,
        width: project.video.width,
        height: project.video.height,
      });

      const wordsLang =
        normalizedCaptionLang !== 'original'
          ? normalizedCaptionLang
          : state.cache.language || 'en';
      for (const clip of rankedClips) {
        clip.wordsLanguage = wordsLang;
        if (normalizedCaptionLang !== 'original') {
          clip.subtitleLanguage = normalizedCaptionLang;
        }
      }
      if (normalizedCaptionLang !== 'original' && project.transcript) {
        project.transcript.language = normalizedCaptionLang;
      }

      project.clips = rankedClips;
      project.status = 'ready';

      setStageStatus(project, 'clip_ranking', {
        status: 'completed',
        progressPct: 100,
        message: `Ranked ${rankedClips.length} clip(s) · Top estimate: ${rankedClips[0]?.score.overallEstimate ?? 0}/100`,
      });
    } finally {
      if (uploadedFileName) {
        await aiClient.files.delete({ name: uploadedFileName }).catch(() => {});
      }
    }
  } catch (err) {
    let message = err instanceof Error ? err.message : 'Pipeline stage failed.';
    try {
      const parsedErr = JSON.parse(message) as { error?: { message?: string } };
      if (parsedErr?.error?.message) {
        message = parsedErr.error.message;
      }
    } catch {
      // Message is already plain text
    }
    const runningStage =
      project.processingStages.find((s) => s.status === 'running')?.stage ?? 'transcription';
    setStageStatus(project, runningStage, {
      status: 'failed',
      message,
    });
    project.status = 'error';
    emitProjectUpdate(project);
  } finally {
    state.running = false;
  }
}

export function getRawVideoPathForProject(project: Project): string | null {
  const key = project.video.rawStorageKey || project.video.storageKey;
  if (!key) return null;
  const resolvedKey = key.startsWith('proxy_') ? key.replace(/^proxy_/, 'raw_') : key;
  return getMediaFilePath(resolvedKey);
}

export interface ClipVoiceDetectionResult {
  words: TranscriptWord[];
  cues: TranslatedSubtitleCue[];
  captionText: string;
  language: string;
  speakers: string[];
  speechWordCount: number;
  soundEventCount: number;
}

/**
 * Helper to transcribe & align a single <= ~40s vocal-enhanced audio window
 * and return segments offset accurately onto [windowOffsetAbsSec, windowOffsetAbsSec + windowDurationSec].
 */
async function detectWindowSpeechSegments(opts: {
  project: Project;
  clip: Clip;
  rawVideoPath: string;
  aiClient: GoogleGenAI;
  effectiveLang: string;
  windowStartAbsSec: number;
  windowDurationSec: number;
  windowIndex: number;
}): Promise<DiarizedSegment[]> {
  const {
    project,
    clip,
    rawVideoPath,
    aiClient,
    effectiveLang,
    windowStartAbsSec,
    windowDurationSec,
    windowIndex,
  } = opts;

  const tmpAudioPath = getMediaFilePath(
    sanitizeStorageKey(`clipvoice_${project.id}_${clip.id}_w${windowIndex}_${Date.now()}.mp3`)
  );
  let uploadedFileName: string | undefined;

  try {
    const extracted = await extractClipAudioSegment({
      videoPath: rawVideoPath,
      startSec: windowStartAbsSec,
      durationSec: windowDurationSec,
      outMp3Path: tmpAudioPath,
    });

    if (!extracted.hasAudio) {
      return [];
    }

    const audioBuf = await fs.readFile(tmpAudioPath);
    let audioPart:
      | { inlineData: { mimeType: string; data: string } }
      | { fileData: { mimeType: string; fileUri: string } };

    if (audioBuf.byteLength <= 10 * 1024 * 1024) {
      audioPart = {
        inlineData: {
          mimeType: 'audio/mp3',
          data: audioBuf.toString('base64'),
        },
      };
    } else {
      const uploadedFile = await aiClient.files.upload({
        file: tmpAudioPath,
        config: { mimeType: 'audio/mp3' },
      });
      uploadedFileName = uploadedFile.name;
      audioPart = {
        fileData: {
          mimeType: uploadedFile.mimeType ?? 'audio/mp3',
          fileUri: uploadedFile.uri ?? '',
        },
      };
    }

    // Pass 1: Dedicated speech recognition on this isolated vocal-enhanced window
    let verbatimTranscript = '';
    try {
      const transcribeRes = await withTimeout(
        aiClient.models.generateContent({
          model: 'gemini-3.5-transcribe',
          contents: [
            audioPart,
            {
              text:
                `Listen closely to the ENTIRE ${windowDurationSec.toFixed(1)}s audio window and transcribe EVERY spoken word accurately from start to finish, especially English speech even if quiet, fast, accented, or spoken over background music. ` +
                'Return ONLY the spoken words as plain text (no timestamps, no speaker labels, no commentary).',
            },
          ],
        }),
        45000,
        `Clip voice transcription window ${windowIndex + 1}`
      );
      const rawText = (transcribeRes.text ?? '').trim();
      if (rawText && !isPlaceholderNonSpeechText(rawText)) {
        verbatimTranscript = rawText;
      }
    } catch {
      verbatimTranscript = '';
    }

    const langDirective = buildDiarizationLanguageInstruction(effectiveLang);
    const windowClockEnd = formatSecAsClock(windowDurationSec);

    // Pass 2: Timestamped voice & sound alignment strictly relative to 00:00.00..windowClockEnd
    const diarizedRes = await generateWithFallback(
      aiClient,
      'gemini-3.8-flash',
      ['gemini-3.1-flash-lite'],
      {
        contents: [
          audioPart,
          {
            text:
              `Analyze the ENTIRE ${windowDurationSec.toFixed(1)}s clip audio track from 00:00.00 to ${windowClockEnd} and produce synced ${
                effectiveLang === 'hinglish' ? 'Hinglish' : 'English'
              } subtitles from ALL spoken human voices.\n` +
              `IMPORTANT: Listen closely to the audio directly from start to end without stopping early. Extract EVERY spoken English word or sentence even if the voice is soft, accented, conversational, or mixed over background music.\n` +
              `Rules:\n` +
              `1. Express EVERY startTime and endTime as a string in "MM:SS.cc" format strictly relative to the start of THIS audio file ("00:00.00" to "${windowClockEnd}"). Example: "00:12.40" for 12.4 seconds.\n` +
              `2. For spoken words: set kind="speech", default speaker to "Speaker 1" (only use "Speaker 2" up to max 4 speakers if you hear a clearly distinct second voice — NEVER invent a new speaker per sentence), and write accurate spoken subtitle text in ${
                effectiveLang === 'hinglish' ? 'natural Hinglish (Roman script)' : 'clean natural English'
              }.\n` +
              `3. Break speech into crisp 3-7 word subtitle segments covering the ENTIRE ${windowDurationSec.toFixed(1)}s duration so captions sync tightly with the speaker.\n` +
              `4. Only emit kind="sound_event" (e.g. [Laughing], [Singing], [Music playing]) for moments with NO spoken words.\n` +
              `5. ${langDirective}\n\n` +
              (verbatimTranscript
                ? `Reference ASR transcript (verify against audio and preserve EVERY spoken phrase across the full duration):\n${verbatimTranscript}`
                : 'No pre-pass text was supplied — transcribe all spoken voices directly from the attached clip audio.'),
          },
        ],
        config: {
          systemInstruction:
            'You are an expert English speech recognition and subtitle timing engine. Always prioritize detecting human voices across the ENTIRE audio window with exact "MM:SS.cc" timestamps relative to 00:00.00. Reuse consistent speaker labels (defaulting to "Speaker 1"; max 4 speakers) and never invent a new speaker for every segment.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            required: ['language', 'segments'],
            properties: {
              language: { type: Type.STRING },
              segments: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  required: ['speaker', 'startTime', 'endTime', 'text', 'kind'],
                  properties: {
                    speaker: { type: Type.STRING },
                    startTime: {
                      type: Type.STRING,
                      description: 'Start timestamp in MM:SS.cc format relative to 00:00.00 of this audio clip.',
                    },
                    endTime: {
                      type: Type.STRING,
                      description: 'End timestamp in MM:SS.cc format relative to 00:00.00 of this audio clip.',
                    },
                    text: { type: Type.STRING },
                    kind: { type: Type.STRING, enum: ['speech', 'sound_event'] },
                    soundCategory: {
                      type: Type.STRING,
                      enum: [
                        'laughing',
                        'crying',
                        'singing',
                        'humming',
                        'cheering',
                        'applause',
                        'music',
                        'gasping',
                        'sighing',
                        'screaming',
                        'coughing',
                        'ambient',
                        'other',
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
      true,
      55000
    );

    const parsed = JSON.parse((diarizedRes.text ?? '{}').trim()) as {
      language?: string;
      segments?: RawModelTimedSegment[];
    };
    let rawSegments: DiarizedSegment[] = normalizeModelTimedSegments(parsed.segments);

    // Pass 3: Vocal-focus English speech rescue if Pass 2 missed spoken voices in this window
    if (countSpokenWordsInSegments(rawSegments) < 2) {
      try {
        const rescueRes = await withTimeout(
          aiClient.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: [
              audioPart,
              {
                text:
                  `Focus exclusively on detecting human speech and English voices across this entire ${windowDurationSec.toFixed(1)}s audio window (00:00.00 to ${windowClockEnd}).\n` +
                  `Ignore background music or ambient noise if someone is speaking underneath it.\n` +
                  `Transcribe every audible spoken English phrase with startTime/endTime in "MM:SS.cc" format relative to 00:00.00 using speaker="Speaker 1" unless clearly distinct voices speak. ` +
                  (effectiveLang === 'hinglish'
                    ? 'Write natural Hinglish (Roman script).'
                    : 'Write clean natural English subtitles.') +
                  ' Return an empty segments array ONLY if there is genuinely zero human speech.',
              },
            ],
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                required: ['segments'],
                properties: {
                  segments: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      required: ['speaker', 'startTime', 'endTime', 'text'],
                      properties: {
                        speaker: { type: Type.STRING },
                        startTime: { type: Type.STRING },
                        endTime: { type: Type.STRING },
                        text: { type: Type.STRING },
                      },
                    },
                  },
                },
              },
            },
          }),
          50000,
          `Clip English voice rescue window ${windowIndex + 1}`
        );

        const rescueParsed = JSON.parse((rescueRes.text ?? '{}').trim()) as {
          segments?: RawModelTimedSegment[];
        };
        const rescued: DiarizedSegment[] = normalizeModelTimedSegments(
          rescueParsed.segments
        ).filter((s) => !isPlaceholderNonSpeechText(s.text));
        if (countSpokenWordsInSegments(rescued) > countSpokenWordsInSegments(rawSegments)) {
          rawSegments = rescued;
        }
      } catch {
        // Proceed with Pass 1 + Pass 2 merge below
      }
    }

    return mergeSpeechAndSoundSegments({
      diarizedSegments: rawSegments,
      verbatimTranscript,
      durationSec: windowDurationSec,
      silences: extracted.silences,
      offsetSec: windowStartAbsSec,
      timestampsAreRelative: true,
      maxSpeakers: 4,
    });
  } finally {
    if (uploadedFileName) {
      await aiClient.files.delete({ name: uploadedFileName }).catch(() => {});
    }
    await fs.rm(tmpAudioPath, { force: true }).catch(() => {});
  }
}

/**
 * On-demand vocal-enhanced voice detection & English (or Hinglish) subtitle alignment
 * for a specific clip slice [clip.startSec, clip.endSec].
 * Automatically chunks long clips (> 42s) into ~35s contiguous windows so timestamps stay
 * tightly synced across the ENTIRE clip duration (never bunching at the start).
 */
export async function detectClipSpeechAndSubtitles(opts: {
  project: Project;
  clip: Clip;
  rawVideoPath: string;
  aiClient: GoogleGenAI;
  targetLanguage?: string;
}): Promise<ClipVoiceDetectionResult> {
  const { project, clip, rawVideoPath, aiClient, targetLanguage = 'en' } = opts;
  const normalizedLang = normalizeCaptionLanguageCode(targetLanguage);
  const effectiveLang = normalizedLang === 'original' ? 'en' : normalizedLang;
  const clipDuration = Math.max(
    1,
    Number((clip.endSec - clip.startSec).toFixed(2))
  );

  const windows = buildClipTranscriptionWindows(clipDuration, 35);
  const windowResults = await Promise.all(
    windows.map((win, idx) =>
      detectWindowSpeechSegments({
        project,
        clip,
        rawVideoPath,
        aiClient,
        effectiveLang,
        windowStartAbsSec: Number((clip.startSec + win.relStartSec).toFixed(2)),
        windowDurationSec: win.durationSec,
        windowIndex: idx,
      })
    )
  );

  const combinedRaw = windowResults.flat().sort((a, b) => a.startSec - b.startSec);
  if (combinedRaw.length === 0) {
    throw new Error('This clip does not contain a playable audio track.');
  }

  // Drop generic [Ambient audio] placeholders from silent windows if other windows have real speech
  const hasRealSpeech = countSpokenWordsInSegments(combinedRaw) > 0;
  const filteredCombined = hasRealSpeech
    ? combinedRaw.filter(
        (s) =>
          !(
            s.kind === 'sound_event' &&
            /^\[(ambient audio|silence|no speech|non_speech_audio)\]$/i.test(s.text.trim())
          )
      )
    : combinedRaw;

  const consolidatedSegments = normalizeAndConsolidateSpeakers(filteredCombined, 4);
  const speakers = extractConsolidatedSpeakers(consolidatedSegments);

  const words = alignSegmentWords(consolidatedSegments);
  const speechWordCount = words.filter((w) => w.kind !== 'sound_event').length;
  const soundEventCount = words.filter((w) => w.kind === 'sound_event').length;

  const cues = buildCaptionTrackCues({
    words,
    startSec: clip.startSec,
    endSec: clip.endSec,
    wordsPerCue: 5,
  }).map((c) => ({
    startSec: c.startSec,
    endSec: c.endSec,
    text: c.text,
  }));

  const captionText = words
    .map((w) => w.word)
    .join(' ')
    .trim();

  return {
    words,
    cues,
    captionText,
    language: effectiveLang,
    speakers,
    speechWordCount,
    soundEventCount,
  };
}

export function clearPipelineCache(projectId: string) {
  projectPipelineStates.delete(projectId);
  const audioOutPath = getMediaFilePath(sanitizeStorageKey(`audio_${projectId}.mp3`));
  void fs.rm(audioOutPath, { force: true }).catch(() => {});
}
