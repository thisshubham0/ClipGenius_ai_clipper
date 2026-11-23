import type { ClipDurationPreset, ScoreCriterion, TranscriptWord } from '../types/clipgenius';

export const SCORE_DISCLAIMER =
  'Estimate only based on narrative structure, pacing, and hook clarity — not a performance guarantee.';

export const CLIP_DURATION_PRESETS: readonly ClipDurationPreset[] = [15, 30, 45, 60, 90];

export function computeWeightedViralScore(criteria: ScoreCriterion[]): number {
  if (criteria.length === 0) return 0;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const item of criteria) {
    const clampedScore = Math.max(0, Math.min(100, item.score));
    const safeWeight = Math.max(0, item.weight);
    weightedSum += clampedScore * safeWeight;
    totalWeight += safeWeight;
  }

  if (totalWeight <= 0) return 0;
  return Math.round(weightedSum / totalWeight);
}

export function formatTimecode(totalSeconds: number, includeMs: boolean = false): string {
  const safe = Math.max(0, totalSeconds);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 100);

  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  const base = hrs > 0 ? `${String(hrs).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;

  if (!includeMs) return base;
  return `${base}.${String(ms % 100).padStart(2, '0')}`;
}

export function clampClipTrimRange(
  startSec: number,
  endSec: number,
  maxDurationSec: number,
  minClipSec: number = 5
): { startSec: number; endSec: number } {
  const safeMax = Math.max(minClipSec, maxDurationSec);
  const clampedStart = Math.max(0, Math.min(startSec, safeMax - minClipSec));
  const clampedEnd = Math.max(clampedStart + minClipSec, Math.min(endSec, safeMax));
  return {
    startSec: Number(clampedStart.toFixed(2)),
    endSec: Number(clampedEnd.toFixed(2)),
  };
}

export function applyDurationPreset(
  startSec: number,
  presetSec: ClipDurationPreset,
  maxDurationSec: number
): { startSec: number; endSec: number } {
  const safeMax = Math.max(5, maxDurationSec);
  const adjustedStart =
    startSec + presetSec > safeMax ? Math.max(0, safeMax - presetSec) : Math.max(0, startSec);
  return clampClipTrimRange(adjustedStart, adjustedStart + presetSec, safeMax);
}

function formatSrtTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(
    2,
    '0'
  )},${String(ms % 1000).padStart(3, '0')}`;
}

export function generateSrtFromWords(
  words: TranscriptWord[],
  clipStartOffsetSec: number = 0,
  wordsPerCue: number = 5
): string {
  if (words.length === 0) return '';
  const lines: string[] = [];
  let cueIndex = 1;

  for (let i = 0; i < words.length; i += wordsPerCue) {
    const chunk = words.slice(i, i + wordsPerCue);
    const start = Math.max(0, chunk[0].startSec - clipStartOffsetSec);
    const end = Math.max(start + 0.4, chunk[chunk.length - 1].endSec - clipStartOffsetSec);
    const text = chunk.map((w) => w.word).join(' ');

    lines.push(`${cueIndex}`);
    lines.push(`${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}`);
    lines.push(text);
    lines.push('');
    cueIndex += 1;
  }

  return lines.join('\n');
}

function formatVttTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(
    2,
    '0'
  )}.${String(ms % 1000).padStart(3, '0')}`;
}

export function generateVttFromWords(
  words: TranscriptWord[],
  clipStartOffsetSec: number = 0,
  wordsPerCue: number = 5
): string {
  if (words.length === 0) return 'WEBVTT\n\n';
  const lines: string[] = ['WEBVTT', ''];

  for (let i = 0; i < words.length; i += wordsPerCue) {
    const chunk = words.slice(i, i + wordsPerCue);
    const start = Math.max(0, chunk[0].startSec - clipStartOffsetSec);
    const end = Math.max(start + 0.4, chunk[chunk.length - 1].endSec - clipStartOffsetSec);
    const text = chunk.map((w) => w.word).join(' ');

    lines.push(`${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}`);
    lines.push(text);
    lines.push('');
  }

  return lines.join('\n');
}
