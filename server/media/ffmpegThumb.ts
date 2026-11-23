import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isBrowserNativeVideo } from './ffprobe';

const execFileAsync = promisify(execFile);

export async function generateVideoThumbnail(
  inputPath: string,
  outputJpgPath: string,
  durationSec: number
): Promise<boolean> {
  const seekSec = durationSec > 4 ? Math.min(2.5, durationSec * 0.25) : 0;
  try {
    await fs.mkdir(path.dirname(outputJpgPath), { recursive: true });
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-ss',
        seekSec.toFixed(2),
        '-i',
        inputPath,
        '-vframes',
        '1',
        '-vf',
        'scale=960:-2',
        '-q:v',
        '3',
        outputJpgPath,
      ],
      { timeout: 20000 }
    );
    return true;
  } catch {
    return false;
  }
}

export async function transcodePreviewIfNeeded(
  inputPath: string,
  outputMp4Path: string,
  ext: string,
  codec: string,
  pixelFormat?: string,
  audioCodec?: string,
  durationSec?: number
): Promise<boolean> {
  if (
    isBrowserNativeVideo({
      ext,
      codec,
      pixelFormat,
      audioCodec,
    })
  ) {
    return false;
  }

  // Skip blocking full-file transcode for very long (>5 min) non-native masters;
  // per-clip on-demand transcoding (/api/clips/:id/preview) handles them in ~2s!
  if (typeof durationSec === 'number' && durationSec > 300) {
    return false;
  }

  try {
    await fs.mkdir(path.dirname(outputMp4Path), { recursive: true });
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i',
        inputPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-profile:v',
        'main',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '25',
        '-vf',
        'scale=1280:-2',
        '-c:a',
        'aac',
        '-ac',
        '2',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        outputMp4Path,
      ],
      { timeout: 90000 }
    );
    const stat = await fs.stat(outputMp4Path);
    return stat.size > 1000;
  } catch {
    await fs.rm(outputMp4Path, { force: true }).catch(() => {});
    return false;
  }
}

/**
 * Fast, browser-universal H.264 (yuv420p) + stereo AAC segment transcoder
 * for on-demand clip preview playback (makes 10-bit x265 / HEVC / MKV / MOV
 * play reliably in every browser in ~1.5-3s).
 */
export async function renderClipSegmentSourceMp4(params: {
  inputPath: string;
  outputMp4Path: string;
  startSec: number;
  durationSec: number;
}): Promise<boolean> {
  try {
    const stat = await fs.stat(params.outputMp4Path);
    if (stat.size > 1000) return true;
  } catch {
    // Render once and cache
  }

  const safeStart = Math.max(0, params.startSec);
  const safeDur = Math.max(2, Math.min(180, params.durationSec));
  const tmpPath = `${params.outputMp4Path}.tmp.mp4`;

  try {
    await fs.mkdir(path.dirname(params.outputMp4Path), { recursive: true });
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-ss',
        safeStart.toFixed(2),
        '-i',
        params.inputPath,
        '-t',
        safeDur.toFixed(2),
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-vf',
        'scale=min(1280\\,iw):-2',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-profile:v',
        'main',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '25',
        '-c:a',
        'aac',
        '-ac',
        '2',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        tmpPath,
      ],
      { timeout: 45000 }
    );
    const stat = await fs.stat(tmpPath);
    if (stat.size <= 1000) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      return false;
    }
    await fs.rename(tmpPath, params.outputMp4Path);
    return true;
  } catch {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    return false;
  }
}

export async function extractAudioWaveformPeaks(
  inputPath: string,
  numBars: number = 48
): Promise<number[]> {
  const fallback = Array.from({ length: numBars }, (_, idx) =>
    Math.round(28 + Math.abs(Math.sin(idx * 0.45) * 48) + ((idx * 17) % 18))
  );

  try {
    const { stdout } = await execFileAsync(
      'ffmpeg',
      [
        '-v',
        'quiet',
        '-i',
        inputPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '2000',
        '-f',
        's16le',
        '-t',
        '60',
        'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 15000 }
    );

    const buf = stdout as unknown as Buffer;
    const totalSamples = Math.floor(buf.length / 2);
    if (totalSamples < numBars) return fallback;

    const bucketSize = Math.floor(totalSamples / numBars);
    const rawPeaks: number[] = [];

    for (let b = 0; b < numBars; b += 1) {
      let maxSample = 0;
      const start = b * bucketSize;
      const end = Math.min(totalSamples, start + bucketSize);
      for (let i = start; i < end; i += 2) {
        const val = Math.abs(buf.readInt16LE(i * 2));
        if (val > maxSample) maxSample = val;
      }
      rawPeaks.push(maxSample);
    }

    const globalMax = Math.max(...rawPeaks, 1);
    return rawPeaks.map((p) => Math.max(12, Math.min(100, Math.round((p / globalMax) * 100))));
  } catch {
    return fallback;
  }
}

export async function generateDemoClipMp4(
  imagePath: string,
  outputMp4Path: string,
  durationSec: number = 12
): Promise<boolean> {
  try {
    const stat = await fs.stat(outputMp4Path);
    if (stat.size > 1000) {
      return true;
    }
  } catch {
    // Generate once
  }

  const tmpPath = `${outputMp4Path}.tmp.mp4`;
  try {
    await fs.mkdir(path.dirname(outputMp4Path), { recursive: true });
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-loop',
        '1',
        '-i',
        imagePath,
        '-f',
        'lavfi',
        '-i',
        'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-t',
        String(durationSec),
        '-vf',
        "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,zoompan=z='min(zoom+0.0012,1.12)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=720x1280:fps=24",
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-profile:v',
        'main',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-ac',
        '2',
        '-shortest',
        '-movflags',
        '+faststart',
        tmpPath,
      ],
      { timeout: 30000 }
    );
    await fs.rename(tmpPath, outputMp4Path);
    return true;
  } catch {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    return false;
  }
}
