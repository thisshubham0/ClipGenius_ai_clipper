import {
  buildDefaultClipVersions,
  formatSoundEventLabel,
  normalizeSoundCategory,
} from '../../src/lib/clipVersions';
import { computeWeightedViralScore, SCORE_DISCLAIMER } from '../../src/lib/scoring';
import type {
  Clip,
  ScoreCriterion,
  SoundEventCategory,
  TranscriptWord,
} from '../../src/types/clipgenius';

export interface SilenceInterval {
  startSec: number;
  endSec: number;
  durationSec: number;
}

export interface DiarizedSegment {
  startSec: number;
  endSec: number;
  speaker: string;
  text: string;
  kind?: 'speech' | 'sound_event';
  soundCategory?: SoundEventCategory | string;
}

export interface RawHighlightCandidate {
  title: string;
  startSec: number;
  endSec: number;
  speaker: string;
  summary: string;
  recommendationReason?: string;
  criteria: {
    hookStrength: { score: number; rationale: string };
    emotionalImpact: { score: number; rationale: string };
    informationValue: { score: number; rationale: string };
    audienceInterest: { score: number; rationale: string };
    storyCompleteness: { score: number; rationale: string };
    shareability: { score: number; rationale: string };
  };
  metadata: {
    primaryTitle: string;
    alternativeTitles: string[];
    description: string;
    hooks: string[];
    hashtags: string[];
    platformCaptions: {
      tiktok: string;
      reels: string;
      shorts: string;
      linkedin: string;
    };
  };
}

export function parseSilenceDetectLog(stderr: string): SilenceInterval[] {
  const intervals: SilenceInterval[] = [];
  let currentStart: number | null = null;

  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) {
      currentStart = Number(startMatch[1]);
      continue;
    }

    const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
    if (endMatch) {
      const endSec = Number(endMatch[1]);
      const durationSec = Number(endMatch[2]);
      const startSec =
        currentStart !== null ? currentStart : Math.max(0, Number((endSec - durationSec).toFixed(2)));
      intervals.push({
        startSec: Number(startSec.toFixed(2)),
        endSec: Number(endSec.toFixed(2)),
        durationSec: Number(durationSec.toFixed(2)),
      });
      currentStart = null;
    }
  }

  return intervals;
}

export function parseSceneDetectLog(stderr: string): number[] {
  const cuts: number[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.includes('showinfo')) continue;
    const match = line.match(/pts_time:([0-9.]+)/);
    if (match) {
      const ts = Number(Number(match[1]).toFixed(2));
      if (Number.isFinite(ts) && (cuts.length === 0 || ts - cuts[cuts.length - 1] >= 0.4)) {
        cuts.push(ts);
      }
    }
  }
  return cuts;
}

export function alignSegmentWords(segments: DiarizedSegment[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  const sortedSegments = [...segments].sort((a, b) => a.startSec - b.startSec);

  for (const seg of sortedSegments) {
    const rawText = (seg.text ?? '').trim();
    if (!rawText) continue;

    const segStart = Math.max(0, Number.isFinite(seg.startSec) ? seg.startSec : 0);
    const segEnd = Math.max(segStart + 0.45, Number.isFinite(seg.endSec) ? seg.endSec : segStart + 1.5);

    const looksBracketedSound = /^\[[^\]]{2,42}\]$/.test(rawText);
    if (seg.kind === 'sound_event' || looksBracketedSound) {
      const category = normalizeSoundCategory(
        typeof seg.soundCategory === 'string' && seg.soundCategory.trim().length > 0
          ? seg.soundCategory
          : rawText
      );
      words.push({
        word: formatSoundEventLabel(category, rawText),
        startSec: Number(segStart.toFixed(2)),
        endSec: Number(segEnd.toFixed(2)),
        speaker: seg.speaker || 'Audio Event',
        confidence: 0.92,
        kind: 'sound_event',
        soundCategory: category,
      });
      continue;
    }

    const tokens = rawText.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    const totalDur = segEnd - segStart;
    const totalWeight = tokens.reduce((acc, t) => acc + Math.max(2, t.length), 0);
    let cursor = segStart;

    for (const token of tokens) {
      const share = Math.max(2, token.length) / totalWeight;
      const wordDur = Math.max(0.08, totalDur * share);
      const nextCursor = Math.min(segEnd, cursor + wordDur);
      words.push({
        word: token,
        startSec: Number(cursor.toFixed(2)),
        endSec: Number(Math.max(cursor + 0.08, nextCursor).toFixed(2)),
        speaker: seg.speaker || 'Speaker 1',
        confidence: 0.94,
        kind: 'speech',
      });
      cursor = nextCursor;
    }
  }

  return words.sort((a, b) => a.startSec - b.startSec);
}

export function snapBoundsToWords(
  rawStartSec: number,
  rawEndSec: number,
  words: TranscriptWord[],
  maxDurationSec: number
): { startSec: number; endSec: number; clipWords: TranscriptWord[] } {
  const safeMax = Math.max(5, maxDurationSec);
  if (words.length === 0) {
    const s = Math.max(0, Math.min(rawStartSec, safeMax - 5));
    const e = Math.max(s + 5, Math.min(rawEndSec, safeMax));
    return { startSec: Number(s.toFixed(2)), endSec: Number(e.toFixed(2)), clipWords: [] };
  }

  let startIdx = words.findIndex((w) => w.endSec > rawStartSec);
  if (startIdx === -1) startIdx = Math.max(0, words.length - 1);

  let bestStartIdx = startIdx;
  let bestStartDist = Infinity;
  const startMin = Math.max(0, startIdx - 3);
  const startMax = Math.min(words.length - 1, startIdx + 3);
  for (let i = startMin; i <= startMax; i += 1) {
    if (
      i === 0 ||
      words[i].kind === 'sound_event' ||
      /[.!?]$/.test(words[i - 1].word)
    ) {
      const dist = Math.abs(words[i].startSec - rawStartSec);
      if (dist < bestStartDist) {
        bestStartDist = dist;
        bestStartIdx = i;
      }
    }
  }
  startIdx = bestStartIdx;

  let endIdx = words.length - 1;
  for (let i = words.length - 1; i >= startIdx; i -= 1) {
    if (words[i].startSec <= rawEndSec) {
      endIdx = i;
      break;
    }
  }

  let bestEndIdx = endIdx;
  let bestEndDist = Infinity;
  const endMin = Math.max(startIdx, endIdx - 3);
  const endMax = Math.min(words.length - 1, endIdx + 3);
  for (let i = endMin; i <= endMax; i += 1) {
    if (
      i === words.length - 1 ||
      words[i].kind === 'sound_event' ||
      /[.!?]$/.test(words[i].word)
    ) {
      const dist = Math.abs(words[i].endSec - rawEndSec);
      if (dist < bestEndDist) {
        bestEndDist = dist;
        bestEndIdx = i;
      }
    }
  }
  endIdx = bestEndIdx;

  const clipWords = words.slice(startIdx, Math.max(startIdx + 1, endIdx + 1));
  const snappedStart = Math.max(0, clipWords[0]?.startSec ?? rawStartSec);
  const snappedEnd = Math.min(
    safeMax,
    Math.max(snappedStart + 5, clipWords[clipWords.length - 1]?.endSec ?? rawEndSec)
  );

  return {
    startSec: Number(snappedStart.toFixed(2)),
    endSec: Number(snappedEnd.toFixed(2)),
    clipWords,
  };
}

function computeIntervalOverlapRatio(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): number {
  const inter = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  const minDur = Math.max(0.1, Math.min(aEnd - aStart, bEnd - bStart));
  return inter / minDur;
}

export function buildRankedClipsFromCandidates(params: {
  projectId: string;
  candidates: RawHighlightCandidate[];
  words: TranscriptWord[];
  maxDurationSec: number;
  thumbnailUrl: string;
  width: number;
  height: number;
}): Clip[] {
  const defaultAspect = '9:16' as const;
  const preferFramed = params.width > params.height;

  const built = params.candidates.map((cand, index) => {
    const snapped = snapBoundsToWords(
      cand.startSec,
      cand.endSec,
      params.words,
      params.maxDurationSec
    );

    const criteria: ScoreCriterion[] = [
      {
        key: 'hookStrength',
        label: 'Hook Strength',
        weight: 0.25,
        score: Math.max(0, Math.min(100, Math.round(cand.criteria.hookStrength.score))),
        rationale: cand.criteria.hookStrength.rationale,
      },
      {
        key: 'emotionalImpact',
        label: 'Emotional Impact',
        weight: 0.15,
        score: Math.max(0, Math.min(100, Math.round(cand.criteria.emotionalImpact.score))),
        rationale: cand.criteria.emotionalImpact.rationale,
      },
      {
        key: 'informationValue',
        label: 'Information Value',
        weight: 0.2,
        score: Math.max(0, Math.min(100, Math.round(cand.criteria.informationValue.score))),
        rationale: cand.criteria.informationValue.rationale,
      },
      {
        key: 'audienceInterest',
        label: 'Audience Interest',
        weight: 0.15,
        score: Math.max(0, Math.min(100, Math.round(cand.criteria.audienceInterest.score))),
        rationale: cand.criteria.audienceInterest.rationale,
      },
      {
        key: 'storyCompleteness',
        label: 'Story Completeness',
        weight: 0.15,
        score: Math.max(0, Math.min(100, Math.round(cand.criteria.storyCompleteness.score))),
        rationale: cand.criteria.storyCompleteness.rationale,
      },
      {
        key: 'shareability',
        label: 'Shareability',
        weight: 0.1,
        score: Math.max(0, Math.min(100, Math.round(cand.criteria.shareability.score))),
        rationale: cand.criteria.shareability.rationale,
      },
    ];

    const overallEstimate = computeWeightedViralScore(criteria);
    const clipId = `clip_ai_${Date.now()}_${index + 1}`;
    const captionSample =
      snapped.clipWords.slice(0, 14).map((w) => w.word).join(' ') || '';

    const versions = buildDefaultClipVersions({
      aspectRatio: defaultAspect,
      preferFramedBackground: preferFramed,
    });
    const v1 = versions[0];

    return {
      id: clipId,
      projectId: params.projectId,
      title: cand.title,
      startSec: snapped.startSec,
      endSec: snapped.endSec,
      aspectRatio: v1.aspectRatio,
      cropOffsetX: 50,
      autoSpeakerTracking: true,
      autoZoom: Boolean(v1.autoZoom),
      backgroundBlurFill: v1.backgroundStyle === 'blur_fill',
      backgroundStyle: v1.backgroundStyle,
      soundtrackId: v1.soundtrackId,
      soundtrackVolume: v1.soundtrackVolume,
      versions,
      activeVersionId: v1.id,
      isAiRecommended: true,
      recommendationReason:
        cand.recommendationReason?.trim() ||
        cand.criteria.hookStrength.rationale ||
        cand.summary,
      captionStyle: v1.captionStyle,
      captionOverrides: v1.captionOverrides ? { ...v1.captionOverrides } : {},
      captionText: captionSample,
      captionTextEdited: false,
      thumbnailUrl: params.thumbnailUrl,
      speaker: cand.speaker || 'Speaker 1',
      score: {
        id: `score_${clipId}`,
        clipId,
        overallEstimate,
        disclaimer: SCORE_DISCLAIMER,
        summary: cand.summary,
        criteria,
      },
      metadata: {
        primaryTitle: cand.metadata.primaryTitle || cand.title,
        alternativeTitles: cand.metadata.alternativeTitles.slice(0, 3),
        description: cand.metadata.description,
        hooks: cand.metadata.hooks,
        hashtags: cand.metadata.hashtags,
        platformCaptions: cand.metadata.platformCaptions,
      },
      words: snapped.clipWords,
    };
  });

  // Sort by highest estimated Viral Score and de-duplicate heavily overlapping windows
  const sorted = built.sort((a, b) => b.score.overallEstimate - a.score.overallEstimate);
  const distinct: Clip[] = [];
  for (const clip of sorted) {
    const heavilyOverlaps = distinct.some(
      (kept) =>
        computeIntervalOverlapRatio(
          kept.startSec,
          kept.endSec,
          clip.startSec,
          clip.endSec
        ) > 0.55
    );
    if (!heavilyOverlaps || distinct.length === 0) {
      distinct.push(clip);
    }
  }

  return distinct;
}
