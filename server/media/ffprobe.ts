import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface FfprobeResult {
  valid: boolean;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  pixelFormat?: string;
  audioCodec?: string;
  hasAudio: boolean;
  formatName: string;
  fileSizeBytes: number;
  error?: string;
}

interface RawFfprobeStream {
  codec_type?: string;
  codec_name?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
}

interface RawFfprobePayload {
  streams?: RawFfprobeStream[];
  format?: {
    duration?: string;
    size?: string;
    format_name?: string;
  };
}

export function isBrowserNativeVideo(params: {
  ext: string;
  codec: string;
  pixelFormat?: string;
  audioCodec?: string;
}): boolean {
  const lowerExt = params.ext.toLowerCase();
  const upperCodec = params.codec.toUpperCase();
  const pixFmt = (params.pixelFormat ?? '').toLowerCase();
  const audio = (params.audioCodec ?? '').toLowerCase();

  const is10BitOrUnsupportedPixFmt =
    pixFmt.includes('10le') ||
    pixFmt.includes('10be') ||
    pixFmt.includes('12le') ||
    pixFmt.includes('yuv444');
  if (is10BitOrUnsupportedPixFmt) {
    return false;
  }

  const audioOk =
    !audio ||
    audio === 'aac' ||
    audio === 'mp3' ||
    audio === 'opus' ||
    audio === 'vorbis';
  if (!audioOk) {
    return false;
  }

  if (lowerExt === '.mp4' && upperCodec.includes('H264')) {
    return true;
  }
  if (
    lowerExt === '.webm' &&
    (upperCodec.includes('VP8') || upperCodec.includes('VP9') || upperCodec.includes('AV1'))
  ) {
    return true;
  }
  return false;
}

export function parseFrameRate(rawRate?: string): number {
  if (!rawRate || rawRate === '0/0') return 30;
  if (rawRate.includes('/')) {
    const [numStr, denStr] = rawRate.split('/');
    const num = Number(numStr);
    const den = Number(denStr);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      const val = num / den;
      return val > 0 && val <= 240 ? Number(val.toFixed(2)) : 30;
    }
    return 30;
  }
  const parsed = Number(rawRate);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 240 ? Number(parsed.toFixed(2)) : 30;
}

export function parseFfprobeJson(jsonStr: string, fallbackBytes: number = 0): FfprobeResult {
  let payload: RawFfprobePayload;
  try {
    payload = JSON.parse(jsonStr) as RawFfprobePayload;
  } catch {
    return {
      valid: false,
      durationSec: 0,
      width: 0,
      height: 0,
      fps: 0,
      codec: '',
      hasAudio: false,
      formatName: '',
      fileSizeBytes: fallbackBytes,
      error: 'Unable to parse FFprobe output.',
    };
  }

  const streams = payload.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  if (!videoStream || !videoStream.width || !videoStream.height) {
    return {
      valid: false,
      durationSec: 0,
      width: 0,
      height: 0,
      fps: 0,
      codec: '',
      hasAudio: Boolean(audioStream),
      formatName: payload.format?.format_name ?? '',
      fileSizeBytes: Number(payload.format?.size) || fallbackBytes,
      error: 'File does not contain a valid video stream.',
    };
  }

  const durationSec = Math.max(0, Number(payload.format?.duration ?? 0));
  const fps = parseFrameRate(videoStream.avg_frame_rate || videoStream.r_frame_rate);
  const videoCodec = (videoStream.codec_name ?? 'unknown').toUpperCase();
  const audioCodec = audioStream?.codec_name ? ` / ${audioStream.codec_name.toUpperCase()}` : '';

  return {
    valid: true,
    durationSec: Number(durationSec.toFixed(2)),
    width: videoStream.width,
    height: videoStream.height,
    fps,
    codec: `${videoCodec}${audioCodec}`,
    pixelFormat: videoStream.pix_fmt,
    audioCodec: audioStream?.codec_name,
    hasAudio: Boolean(audioStream),
    formatName: payload.format?.format_name ?? 'unknown',
    fileSizeBytes: Number(payload.format?.size) || fallbackBytes,
  };
}

export async function probeVideoFile(
  filePath: string,
  fallbackBytes: number = 0
): Promise<FfprobeResult> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }
    );
    return parseFfprobeJson(stdout, fallbackBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'FFprobe failed';
    return {
      valid: false,
      durationSec: 0,
      width: 0,
      height: 0,
      fps: 0,
      codec: '',
      hasAudio: false,
      formatName: '',
      fileSizeBytes: fallbackBytes,
      error: `FFprobe inspection failed: ${message}`,
    };
  }
}
