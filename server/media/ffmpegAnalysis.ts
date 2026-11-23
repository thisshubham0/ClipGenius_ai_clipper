import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  parseSceneDetectLog,
  parseSilenceDetectLog,
  type SilenceInterval,
} from '../pipeline/clipPostProcess';
import { buildVoiceClarityAudioFilter } from '../pipeline/speechDetection';

const execFileAsync = promisify(execFile);

export async function extractAudioAndDetectSilences(
  videoPath: string,
  outMp3Path: string
): Promise<{ audioPath: string; silences: SilenceInterval[]; hasAudio: boolean }> {
  await fs.mkdir(path.dirname(outMp3Path), { recursive: true });

  // Pass 1: Vocal-clarity extraction (highpass + lowpass + dynaudnorm + silencedetect)
  // Lifts quiet English dialogue and speech over background music so ASR never misses voices.
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i',
        videoPath,
        '-map',
        '0:a:0',
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-b:a',
        '96k',
        '-af',
        buildVoiceClarityAudioFilter(true),
        outMp3Path,
      ],
      { timeout: 180000, maxBuffer: 8 * 1024 * 1024 }
    );

    const stat = await fs.stat(outMp3Path);
    if (stat.size > 512) {
      return {
        audioPath: outMp3Path,
        silences: parseSilenceDetectLog(stderr),
        hasAudio: true,
      };
    }
  } catch {
    // Fall through to plain extraction fallback for unusual audio codecs/layouts
  }

  // Pass 2: Plain audio extraction fallback without audio filters
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i',
        videoPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-b:a',
        '96k',
        outMp3Path,
      ],
      { timeout: 180000, maxBuffer: 8 * 1024 * 1024 }
    );

    const stat = await fs.stat(outMp3Path);
    return {
      audioPath: outMp3Path,
      silences: [],
      hasAudio: stat.size > 512,
    };
  } catch {
    return {
      audioPath: '',
      silences: [],
      hasAudio: false,
    };
  }
}

/**
 * Extracts a specific clip window's audio with vocal-clarity normalization so per-clip
 * voice detection and English subtitle generation work cleanly even on quiet/music-backed videos.
 */
export async function extractClipAudioSegment(params: {
  videoPath: string;
  startSec: number;
  durationSec: number;
  outMp3Path: string;
}): Promise<{ audioPath: string; silences: SilenceInterval[]; hasAudio: boolean }> {
  const { videoPath, startSec, durationSec, outMp3Path } = params;
  await fs.mkdir(path.dirname(outMp3Path), { recursive: true });

  const safeStart = Math.max(0, startSec);
  const safeDur = Math.max(1, durationSec);

  const attemptArgs = (withFilter: boolean): string[] => {
    const args = ['-y'];
    if (safeStart > 0) {
      args.push('-ss', safeStart.toFixed(2));
    }
    args.push(
      '-i',
      videoPath,
      '-t',
      safeDur.toFixed(2),
      '-map',
      '0:a:0?',
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '96k'
    );
    if (withFilter) {
      args.push('-af', buildVoiceClarityAudioFilter(true));
    }
    args.push(outMp3Path);
    return args;
  };

  for (const withFilter of [true, false]) {
    try {
      const { stderr } = await execFileAsync('ffmpeg', attemptArgs(withFilter), {
        timeout: 90000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const stat = await fs.stat(outMp3Path);
      if (stat.size > 512) {
        return {
          audioPath: outMp3Path,
          silences: withFilter ? parseSilenceDetectLog(stderr) : [],
          hasAudio: true,
        };
      }
    } catch {
      // Try next fallback
    }
  }

  return {
    audioPath: '',
    silences: [],
    hasAudio: false,
  };
}

/**
 * Fast-slices a contiguous window out of an already-extracted 16 kHz vocal-enhanced MP3.
 * Avoids re-decoding large video files when transcribing 20–45 minute uploads in chunks.
 */
export async function extractAudioSliceFromMp3(params: {
  inputMp3Path: string;
  startSec: number;
  durationSec: number;
  outMp3Path: string;
}): Promise<boolean> {
  const { inputMp3Path, startSec, durationSec, outMp3Path } = params;
  await fs.mkdir(path.dirname(outMp3Path), { recursive: true });
  const safeStart = Math.max(0, startSec);
  const safeDur = Math.max(1, durationSec);

  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-ss',
        safeStart.toFixed(2),
        '-i',
        inputMp3Path,
        '-t',
        safeDur.toFixed(2),
        '-ac',
        '1',
        '-ar',
        '16000',
        '-b:a',
        '96k',
        outMp3Path,
      ],
      { timeout: 30000, maxBuffer: 2 * 1024 * 1024 }
    );
    const stat = await fs.stat(outMp3Path);
    return stat.size > 512;
  } catch {
    return false;
  }
}

export async function detectSceneCuts(videoPath: string): Promise<number[]> {
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-i',
        videoPath,
        '-vf',
        "select='gt(scene,0.35)',showinfo",
        '-f',
        'null',
        '-',
      ],
      { timeout: 90000, maxBuffer: 8 * 1024 * 1024 }
    );
    return parseSceneDetectLog(stderr);
  } catch {
    return [];
  }
}
