import type {
  CropKeyframe,
  SilenceInterval,
  TranscriptWord,
  TranslatedSubtitleCue,
} from '../types/clipgenius';
import { isSoundEventCaptionText } from './captionLanguages';

export interface CaptionTrackCue {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
  leftPct: number;
  widthPct: number;
  isSoundEvent?: boolean;
  words?: TranscriptWord[];
}

export interface SkippedRange {
  startSec: number;
  endSec: number;
  reason: 'silence' | 'filler';
}

export interface EffectiveTimelineResult {
  skippedRanges: SkippedRange[];
  savedSec: number;
  effectiveDurationSec: number;
}

const FILLER_SINGLE_WORDS = new Set([
  'um',
  'umm',
  'uh',
  'uhh',
  'erm',
  'hmm',
  'ah',
  'ahh',
  'er',
]);

function normalizeToken(word: string): string {
  return word.toLowerCase().replace(/[^a-z']/g, '');
}

export function isFillerWord(word: string): boolean {
  const clean = normalizeToken(word);
  return FILLER_SINGLE_WORDS.has(clean);
}

export function filterWordsForCaptions(
  words: TranscriptWord[],
  removeFillers: boolean
): TranscriptWord[] {
  if (!removeFillers) return words;
  const filtered = words.filter((w) => w.kind === 'sound_event' || !isFillerWord(w.word));
  return filtered.length > 0 ? filtered : words;
}

export function computeEffectiveTimeline(params: {
  startSec: number;
  endSec: number;
  silences: SilenceInterval[];
  removeSilences: boolean;
  words: TranscriptWord[];
  removeFillers: boolean;
}): EffectiveTimelineResult {
  const { startSec, endSec, silences, removeSilences, words, removeFillers } = params;
  const totalClipSec = Math.max(0.5, endSec - startSec);
  const rawRanges: SkippedRange[] = [];

  if (removeSilences) {
    const soundEvents = words.filter((w) => w.kind === 'sound_event');
    for (const s of silences) {
      const clampedStart = Math.max(startSec, s.startSec);
      const clampedEnd = Math.min(endSec, s.endSec);
      // Leave 0.15s breathing room so cuts feel natural instead of jarring
      const trimStart = clampedStart + 0.08;
      const trimEnd = clampedEnd - 0.08;
      const overlapsSoundEvent = soundEvents.some(
        (ev) => ev.endSec > trimStart && ev.startSec < trimEnd
      );
      if (trimEnd - trimStart >= 0.25 && !overlapsSoundEvent) {
        rawRanges.push({
          startSec: Number(trimStart.toFixed(2)),
          endSec: Number(trimEnd.toFixed(2)),
          reason: 'silence',
        });
      }
    }
  }

  if (removeFillers) {
    for (const w of words) {
      if (w.kind === 'sound_event') continue;
      if (w.endSec <= startSec || w.startSec >= endSec) continue;
      if (isFillerWord(w.word)) {
        const clampedStart = Math.max(startSec, w.startSec);
        const clampedEnd = Math.min(endSec, w.endSec);
        if (clampedEnd - clampedStart >= 0.1) {
          rawRanges.push({
            startSec: Number(clampedStart.toFixed(2)),
            endSec: Number(clampedEnd.toFixed(2)),
            reason: 'filler',
          });
        }
      }
    }
  }

  // Sort & merge overlapping ranges
  rawRanges.sort((a, b) => a.startSec - b.startSec);
  const merged: SkippedRange[] = [];
  for (const r of rawRanges) {
    const prev = merged[merged.length - 1];
    if (prev && r.startSec <= prev.endSec + 0.05) {
      prev.endSec = Math.max(prev.endSec, r.endSec);
    } else {
      merged.push({ ...r });
    }
  }

  const savedSec = Number(
    merged.reduce((acc, r) => acc + Math.max(0, r.endSec - r.startSec), 0).toFixed(2)
  );
  const effectiveDurationSec = Number(Math.max(1, totalClipSec - savedSec).toFixed(2));

  return {
    skippedRanges: merged,
    savedSec,
    effectiveDurationSec,
  };
}

export function findNextPlayableTime(
  absTimeSec: number,
  skippedRanges: SkippedRange[]
): number | null {
  for (const range of skippedRanges) {
    if (absTimeSec >= range.startSec && absTimeSec < range.endSec - 0.03) {
      return range.endSec;
    }
  }
  return null;
}

/**
 * Generates an active-speaker crop trajectory from diarized word turns,
 * then applies bidirectional EMA smoothing so horizontal pans have zero jitter.
 */
export function buildSpeakerCropKeyframes(params: {
  words: TranscriptWord[];
  startSec: number;
  endSec: number;
  baseOffsetX: number;
  autoZoom: boolean;
}): CropKeyframe[] {
  const { words, startSec, endSec, baseOffsetX, autoZoom } = params;
  const clipWords = words.filter((w) => w.endSec >= startSec && w.startSec <= endSec);
  const baseX = Math.max(10, Math.min(90, baseOffsetX));

  if (clipWords.length === 0) {
    return [
      { timeSec: Number(startSec.toFixed(2)), xPct: baseX, zoom: autoZoom ? 1.04 : 1 },
      { timeSec: Number(endSec.toFixed(2)), xPct: baseX, zoom: autoZoom ? 1.08 : 1 },
    ];
  }

  const uniqueSpeakers = Array.from(new Set(clipWords.map((w) => w.speaker || 'Speaker 1')));
  const speakerAnchors = new Map<string, number>();

  if (uniqueSpeakers.length === 1) {
    speakerAnchors.set(uniqueSpeakers[0], baseX);
  } else {
    uniqueSpeakers.forEach((speaker, idx) => {
      const span = 50; // spread speakers smoothly between 25% and 75%
      const offset = 25 + (span * idx) / Math.max(1, uniqueSpeakers.length - 1);
      speakerAnchors.set(speaker, Math.round(offset));
    });
  }

  const rawPoints: CropKeyframe[] = [];
  let lastSpeaker = '';
  const clipDur = Math.max(1, endSec - startSec);
  const stepSec = Math.max(2, Math.min(5, clipDur / 6));

  for (let t = startSec; t <= endSec + 0.01; t += stepSec) {
    const clampedT = Math.min(endSec, t);
    const activeWord =
      clipWords.find((w) => clampedT >= w.startSec && clampedT <= w.endSec) ??
      clipWords.find((w) => w.startSec >= clampedT) ??
      clipWords[clipWords.length - 1];

    const speaker = activeWord?.speaker || uniqueSpeakers[0];
    const targetX = speakerAnchors.get(speaker) ?? baseX;
    const isSpeakerChange = lastSpeaker !== '' && lastSpeaker !== speaker;
    lastSpeaker = speaker;

    // Gentle zoom punch on speaker transition or emphasis midpoint
    const zoom = autoZoom
      ? isSpeakerChange
        ? 1.1
        : 1.03 + 0.04 * Math.sin(((clampedT - startSec) / clipDur) * Math.PI)
      : 1;

    rawPoints.push({
      timeSec: Number(clampedT.toFixed(2)),
      xPct: Number(targetX.toFixed(1)),
      zoom: Number(zoom.toFixed(3)),
      speaker,
    });
  }

  return smoothCropKeyframes(rawPoints, 0.45);
}

/**
 * Bidirectional Exponential Moving Average (zero-phase smoothing) to remove crop jitter
 * while keeping speaker framing centered without lag.
 */
export function smoothCropKeyframes(
  keyframes: CropKeyframe[],
  alpha: number = 0.45
): CropKeyframe[] {
  if (keyframes.length <= 2) {
    return keyframes.map((k) => ({ ...k }));
  }

  const clampedAlpha = Math.max(0.1, Math.min(0.95, alpha));
  const sorted = [...keyframes].sort((a, b) => a.timeSec - b.timeSec);

  // Forward pass
  const fwdX: number[] = [sorted[0].xPct];
  const fwdZoom: number[] = [sorted[0].zoom];
  for (let i = 1; i < sorted.length; i += 1) {
    fwdX.push(clampedAlpha * sorted[i].xPct + (1 - clampedAlpha) * fwdX[i - 1]);
    fwdZoom.push(clampedAlpha * sorted[i].zoom + (1 - clampedAlpha) * fwdZoom[i - 1]);
  }

  // Backward pass for zero phase lag
  const outX = new Array<number>(sorted.length);
  const outZoom = new Array<number>(sorted.length);
  outX[sorted.length - 1] = fwdX[sorted.length - 1];
  outZoom[sorted.length - 1] = fwdZoom[sorted.length - 1];

  for (let i = sorted.length - 2; i >= 0; i -= 1) {
    outX[i] = clampedAlpha * fwdX[i] + (1 - clampedAlpha) * outX[i + 1];
    outZoom[i] = clampedAlpha * fwdZoom[i] + (1 - clampedAlpha) * outZoom[i + 1];
  }

  return sorted.map((kf, idx) => ({
    ...kf,
    xPct: Number(Math.max(0, Math.min(100, outX[idx])).toFixed(1)),
    zoom: Number(Math.max(1, Math.min(1.35, outZoom[idx])).toFixed(3)),
  }));
}

export function evaluateCropAtTime(params: {
  keyframes: CropKeyframe[];
  timeSec: number;
  fallbackX: number;
  autoZoom: boolean;
}): { xPct: number; zoom: number } {
  const { keyframes, timeSec, fallbackX, autoZoom } = params;
  if (keyframes.length === 0) {
    return { xPct: fallbackX, zoom: autoZoom ? 1.05 : 1 };
  }

  const sorted = [...keyframes].sort((a, b) => a.timeSec - b.timeSec);
  if (timeSec <= sorted[0].timeSec) {
    return { xPct: sorted[0].xPct, zoom: autoZoom ? sorted[0].zoom : 1 };
  }
  const last = sorted[sorted.length - 1];
  if (timeSec >= last.timeSec) {
    return { xPct: last.xPct, zoom: autoZoom ? last.zoom : 1 };
  }

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (timeSec >= a.timeSec && timeSec <= b.timeSec) {
      const span = Math.max(0.001, b.timeSec - a.timeSec);
      const rawT = (timeSec - a.timeSec) / span;
      // Hermite smoothstep easing for cinema-grade panning
      const smoothT = rawT * rawT * (3 - 2 * rawT);
      const xPct = a.xPct + (b.xPct - a.xPct) * smoothT;
      const zoom = autoZoom ? a.zoom + (b.zoom - a.zoom) * smoothT : 1;
      return {
        xPct: Number(xPct.toFixed(1)),
        zoom: Number(zoom.toFixed(3)),
      };
    }
  }

  return { xPct: fallbackX, zoom: autoZoom ? 1.05 : 1 };
}

export function buildCaptionTrackCues(params: {
  words: TranscriptWord[];
  startSec: number;
  endSec: number;
  wordsPerCue?: number;
  translatedCues?: TranslatedSubtitleCue[];
}): CaptionTrackCue[] {
  const { words, startSec, endSec, wordsPerCue = 5, translatedCues } = params;
  const clipDur = Math.max(1, endSec - startSec);

  if (translatedCues && translatedCues.length > 0) {
    return translatedCues
      .filter((c) => c.endSec > startSec && c.startSec < endSec)
      .map((c, idx) => {
        const s = Math.max(startSec, c.startSec);
        const e = Math.min(endSec, Math.max(s + 0.3, c.endSec));
        return {
          id: `tr_cue_${idx}`,
          startSec: Number(s.toFixed(2)),
          endSec: Number(e.toFixed(2)),
          text: c.text,
          leftPct: Number((((s - startSec) / clipDur) * 100).toFixed(2)),
          widthPct: Number((Math.max(0.4, e - s) / clipDur * 100).toFixed(2)),
          isSoundEvent: isSoundEventCaptionText(c.text),
        };
      });
  }

  const inRange = words
    .filter((w) => w.endSec > startSec && w.startSec < endSec)
    .sort((a, b) => a.startSec - b.startSec);
  const cues: CaptionTrackCue[] = [];
  let speechBuffer: TranscriptWord[] = [];
  let cueCounter = 0;

  const MAX_GAP_SEC = 0.75;
  const MAX_CHAR_BUDGET = Math.max(26, wordsPerCue * 8);

  const emitSpeechChunk = (chunk: TranscriptWord[]) => {
    if (chunk.length === 0) return;
    const s = Math.max(startSec, chunk[0].startSec);
    const e = Math.min(endSec, Math.max(s + 0.35, chunk[chunk.length - 1].endSec));
    cues.push({
      id: `cue_${cueCounter++}`,
      startSec: Number(s.toFixed(2)),
      endSec: Number(e.toFixed(2)),
      text: chunk.map((w) => w.word).join(' '),
      leftPct: Number((((s - startSec) / clipDur) * 100).toFixed(2)),
      widthPct: Number((((e - s) / clipDur) * 100).toFixed(2)),
      isSoundEvent: false,
      words: chunk,
    });
  };

  const flushSpeech = () => {
    if (speechBuffer.length === 0) return;
    let current: TranscriptWord[] = [];

    for (const word of speechBuffer) {
      if (current.length > 0) {
        const prev = current[current.length - 1];
        const gapSec = word.startSec - prev.endSec;
        const speakerChanged =
          Boolean(prev.speaker && word.speaker) && prev.speaker !== word.speaker;
        const prevEndedSentence = /[.!?…]["')]*$/.test(prev.word.trim());
        const projectedChars =
          current.reduce((acc, w) => acc + w.word.length + 1, 0) + word.word.length;

        const shouldBreak =
          gapSec > MAX_GAP_SEC ||
          speakerChanged ||
          current.length >= wordsPerCue ||
          (prevEndedSentence && current.length >= 2) ||
          (current.length >= 2 && projectedChars > MAX_CHAR_BUDGET);

        if (shouldBreak) {
          emitSpeechChunk(current);
          current = [];
        }
      }
      current.push(word);
    }

    emitSpeechChunk(current);
    speechBuffer = [];
  };

  for (const token of inRange) {
    if (token.kind === 'sound_event') {
      flushSpeech();
      const s = Math.max(startSec, token.startSec);
      const e = Math.min(endSec, Math.max(s + 0.45, token.endSec));
      cues.push({
        id: `cue_snd_${cueCounter++}`,
        startSec: Number(s.toFixed(2)),
        endSec: Number(e.toFixed(2)),
        text: token.word,
        leftPct: Number((((s - startSec) / clipDur) * 100).toFixed(2)),
        widthPct: Number((((e - s) / clipDur) * 100).toFixed(2)),
        isSoundEvent: true,
        words: [token],
      });
    } else {
      speechBuffer.push(token);
    }
  }
  flushSpeech();

  return cues;
}

export interface ActiveCaptionDisplay {
  cueId: string;
  words: string[];
  highlightedIdx: number;
  isSoundEvent: boolean;
}

/**
 * Single source of truth for resolving which caption cue and active word should
 * render in Live Preview at `playheadAbsSec`, matching CaptionTrack & FFmpeg ASS 1:1.
 * - Never flickers off during brief intra-cue inter-word gaps.
 * - Clears cleanly during silent gaps between cues.
 * - Uses exact per-word startSec/endSec when available, falling back to character-weighted
 *   progress for translated cues.
 */
export function resolveActiveCaptionCueAtTime(params: {
  cues: CaptionTrackCue[];
  playheadAbsSec: number;
  allowIdlePreviewFallback: boolean;
}): ActiveCaptionDisplay | null {
  const { cues, playheadAbsSec, allowIdlePreviewFallback } = params;
  if (cues.length === 0) return null;

  let activeCue: CaptionTrackCue | undefined;
  for (let i = 0; i < cues.length; i += 1) {
    const c = cues[i];
    const nextStart = i + 1 < cues.length ? cues[i + 1].startSec : Number.POSITIVE_INFINITY;
    const leadIn = Math.max(c.startSec - 0.08, i > 0 ? cues[i - 1].endSec : c.startSec - 0.08);
    const tailOut = Math.min(c.endSec + 0.14, nextStart - 0.01);
    if (playheadAbsSec >= leadIn && playheadAbsSec <= tailOut) {
      activeCue = c;
      break;
    }
  }

  const isIdlePreview = !activeCue && allowIdlePreviewFallback;
  if (isIdlePreview) {
    activeCue = cues[0];
  }
  if (!activeCue) return null;

  if (activeCue.isSoundEvent || isSoundEventCaptionText(activeCue.text)) {
    return {
      cueId: activeCue.id,
      words: [activeCue.text.trim()],
      highlightedIdx: 0,
      isSoundEvent: true,
    };
  }

  if (activeCue.words && activeCue.words.length > 0) {
    const tokens = activeCue.words.map((w) => w.word);
    if (isIdlePreview) {
      return {
        cueId: activeCue.id,
        words: tokens,
        highlightedIdx: 0,
        isSoundEvent: false,
      };
    }
    let idx = 0;
    for (let i = 0; i < activeCue.words.length; i += 1) {
      if (playheadAbsSec >= activeCue.words[i].startSec - 0.06) {
        idx = i;
      } else {
        break;
      }
    }
    return {
      cueId: activeCue.id,
      words: tokens,
      highlightedIdx: Math.max(0, Math.min(tokens.length - 1, idx)),
      isSoundEvent: false,
    };
  }

  const tokens = activeCue.text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (isIdlePreview) {
    return {
      cueId: activeCue.id,
      words: tokens,
      highlightedIdx: 0,
      isSoundEvent: false,
    };
  }

  const cueDur = Math.max(0.25, activeCue.endSec - activeCue.startSec);
  const progress = Math.max(0, Math.min(0.999, (playheadAbsSec - activeCue.startSec) / cueDur));
  const totalWeight = tokens.reduce((acc, t) => acc + Math.max(2, t.length), 0);
  const targetWeight = progress * totalWeight;
  let accWeight = 0;
  let highlightedIdx = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    accWeight += Math.max(2, tokens[i].length);
    if (accWeight >= targetWeight) {
      highlightedIdx = i;
      break;
    }
  }

  return {
    cueId: activeCue.id,
    words: tokens,
    highlightedIdx,
    isSoundEvent: false,
  };
}

export function generateSrtFromTranslatedCues(
  cues: TranslatedSubtitleCue[],
  clipStartOffsetSec: number = 0
): string {
  if (cues.length === 0) return '';
  const fmt = (sec: number) => {
    const safe = Math.max(0, sec);
    const hrs = Math.floor(safe / 3600);
    const mins = Math.floor((safe % 3600) / 60);
    const secs = Math.floor(safe % 60);
    const ms = Math.round((safe - Math.floor(safe)) * 1000);
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(
      2,
      '0'
    )},${String(ms % 1000).padStart(3, '0')}`;
  };
  const lines: string[] = [];
  cues.forEach((cue, i) => {
    const s = Math.max(0, cue.startSec - clipStartOffsetSec);
    const e = Math.max(s + 0.4, cue.endSec - clipStartOffsetSec);
    lines.push(`${i + 1}`);
    lines.push(`${fmt(s)} --> ${fmt(e)}`);
    lines.push(cue.text);
    lines.push('');
  });
  return lines.join('\n');
}

export function generateVttFromTranslatedCues(
  cues: TranslatedSubtitleCue[],
  clipStartOffsetSec: number = 0
): string {
  if (cues.length === 0) return 'WEBVTT\n\n';
  const fmt = (sec: number) => {
    const safe = Math.max(0, sec);
    const hrs = Math.floor(safe / 3600);
    const mins = Math.floor((safe % 3600) / 60);
    const secs = Math.floor(safe % 60);
    const ms = Math.round((safe - Math.floor(safe)) * 1000);
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(
      2,
      '0'
    )}.${String(ms % 1000).padStart(3, '0')}`;
  };
  const lines: string[] = ['WEBVTT', ''];
  cues.forEach((cue) => {
    const s = Math.max(0, cue.startSec - clipStartOffsetSec);
    const e = Math.max(s + 0.4, cue.endSec - clipStartOffsetSec);
    lines.push(`${fmt(s)} --> ${fmt(e)}`);
    lines.push(cue.text);
    lines.push('');
  });
  return lines.join('\n');
}

export interface CaptionTrackLayoutBlock extends CaptionTrackCue {
  visualLeftPct: number;
  visualWidthPct: number;
  showInlineText: boolean;
  relStartSec: number;
  relEndSec: number;
}

/**
 * Computes non-overlapping visual positions for caption cues across the full
 * [startSec, endSec] segment duration. Enforces a minimum visible width without
 * allowing adjacent blocks to overlap, and hides unreadable inline text on
 * ultra-narrow blocks (full text is shown on hover/focus).
 */
export function layoutCaptionTrackBlocks(
  cues: CaptionTrackCue[],
  startSec: number,
  endSec: number
): CaptionTrackLayoutBlock[] {
  if (cues.length === 0) return [];
  const clipDur = Math.max(1, endSec - startSec);
  const sorted = [...cues].sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

  const MIN_WIDTH_PCT = 1.6;
  const HARD_MIN_WIDTH_PCT = 0.85;
  const GAP_PCT = 0.25;
  const INLINE_TEXT_THRESHOLD_PCT = 5.5;

  const rawItems = sorted.map((cue) => {
    const clampedStart = Math.max(startSec, Math.min(endSec, cue.startSec));
    const clampedEnd = Math.max(clampedStart + 0.2, Math.min(endSec, cue.endSec));
    const relStartSec = Number(Math.max(0, clampedStart - startSec).toFixed(2));
    const relEndSec = Number(Math.min(clipDur, clampedEnd - startSec).toFixed(2));
    const trueLeftPct = Math.max(0, Math.min(99.2, (relStartSec / clipDur) * 100));
    const trueWidthPct = Math.max(0.2, ((relEndSec - relStartSec) / clipDur) * 100);
    return {
      cue,
      relStartSec,
      relEndSec,
      trueLeftPct,
      trueWidthPct,
    };
  });

  const placed: Array<{
    item: (typeof rawItems)[number];
    left: number;
    width: number;
  }> = [];

  for (let i = 0; i < rawItems.length; i += 1) {
    const item = rawItems[i];
    const prev = placed[placed.length - 1];
    const minAllowedLeft = prev ? prev.left + prev.width + GAP_PCT : 0;
    const left = Math.max(item.trueLeftPct, minAllowedLeft);

    const nextTrueLeft = i + 1 < rawItems.length ? rawItems[i + 1].trueLeftPct : 100;
    const desiredWidth = Math.max(MIN_WIDTH_PCT, item.trueWidthPct);
    const maxRightBeforeNext =
      i + 1 < rawItems.length
        ? Math.max(left + HARD_MIN_WIDTH_PCT, nextTrueLeft - GAP_PCT)
        : 100;
    const width = Math.max(
      HARD_MIN_WIDTH_PCT,
      Math.min(desiredWidth, Math.max(HARD_MIN_WIDTH_PCT, maxRightBeforeNext - left))
    );

    placed.push({ item, left, width });
  }

  // If dense cues pushed the last block beyond 100%, compress cleanly into [0, 100]
  const last = placed[placed.length - 1];
  const overflowEnd = last ? last.left + last.width : 100;
  if (overflowEnd > 100) {
    // Shift/scale only the contiguous trailing overflow cluster or normalize linearly
    const scale = 100 / overflowEnd;
    for (const p of placed) {
      p.left = p.left * scale;
      p.width = Math.max(0.45, p.width * scale);
    }
  }

  // Final pass guaranteeing strict non-overlap and bounds within [0, 100]
  const result: CaptionTrackLayoutBlock[] = [];
  for (let i = 0; i < placed.length; i += 1) {
    const cur = placed[i];
    const prevBlock = result[i - 1];
    let visualLeftPct = Math.max(0, cur.left);
    if (prevBlock) {
      const prevRight = prevBlock.visualLeftPct + prevBlock.visualWidthPct;
      if (visualLeftPct < prevRight + 0.1) {
        visualLeftPct = Math.min(99.5, prevRight + 0.1);
      }
    }
    const maxWidth = Math.max(0.4, 100 - visualLeftPct);
    let visualWidthPct = Math.min(cur.width, maxWidth);
    if (i + 1 < placed.length) {
      const nextLeft = placed[i + 1].left;
      if (visualLeftPct + visualWidthPct > nextLeft - 0.1 && nextLeft - visualLeftPct > 0.5) {
        visualWidthPct = nextLeft - visualLeftPct - 0.1;
      }
    }
    visualLeftPct = Number(visualLeftPct.toFixed(2));
    visualWidthPct = Number(Math.max(0.4, visualWidthPct).toFixed(2));

    result.push({
      ...cur.item.cue,
      leftPct: Number(cur.item.trueLeftPct.toFixed(2)),
      widthPct: Number(cur.item.trueWidthPct.toFixed(2)),
      visualLeftPct,
      visualWidthPct,
      showInlineText: visualWidthPct >= INLINE_TEXT_THRESHOLD_PCT,
      relStartSec: cur.item.relStartSec,
      relEndSec: cur.item.relEndSec,
    });
  }

  return result;
}

/**
 * Client-side safeguard that prevents runaway speaker inflation (e.g., Speaker 1..Speaker 17
 * from legacy projects) from cluttering the Transcript header. Defaults to ['Speaker 1']
 * unless multiple recurring speakers are genuinely present, and caps at maxSpeakers (4).
 */
export function consolidateDisplaySpeakers(
  words: TranscriptWord[],
  rawSpeakers?: string[],
  maxSpeakers: number = 4
): string[] {
  const cap = Math.max(1, Math.min(4, maxSpeakers));
  const speechWords = words.filter((w) => w.kind !== 'sound_event');

  if (speechWords.length > 0) {
    const wordCounts = new Map<string, number>();
    const turnCounts = new Map<string, number>();
    let prevSpeaker = '';

    for (const w of speechWords) {
      const label = (w.speaker || 'Speaker 1').trim() || 'Speaker 1';
      if (/^sound\b|^audio\b/i.test(label)) continue;
      wordCounts.set(label, (wordCounts.get(label) ?? 0) + 1);
      if (label !== prevSpeaker) {
        turnCounts.set(label, (turnCounts.get(label) ?? 0) + 1);
        prevSpeaker = label;
      }
    }

    const distinct = Array.from(wordCounts.keys());
    if (distinct.length === 0) return ['Speaker 1'];
    if (distinct.length === 1) return [distinct[0]];

    const singleTurnCount = distinct.filter(
      (s) => (turnCounts.get(s) ?? 0) <= 1 && (wordCounts.get(s) ?? 0) <= 12
    ).length;
    const isInflated =
      distinct.length > cap ||
      (distinct.length > 2 && singleTurnCount / distinct.length >= 0.55);

    if (isInflated) {
      const recurring = distinct
        .filter((s) => (turnCounts.get(s) ?? 0) >= 2 && (wordCounts.get(s) ?? 0) >= 8)
        .sort((a, b) => (wordCounts.get(b) ?? 0) - (wordCounts.get(a) ?? 0))
        .slice(0, cap);
      if (recurring.length <= 1) {
        return ['Speaker 1'];
      }
      return recurring.map((_, idx) => `Speaker ${idx + 1}`);
    }

    return distinct.slice(0, cap);
  }

  const cleanedRaw = Array.from(
    new Set(
      (rawSpeakers ?? [])
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !/^sound\b|^audio\b/i.test(s))
    )
  );
  if (cleanedRaw.length === 0 || cleanedRaw.length > cap) {
    return ['Speaker 1'];
  }
  return cleanedRaw;
}

