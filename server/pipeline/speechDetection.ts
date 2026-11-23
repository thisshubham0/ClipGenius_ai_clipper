import type { DiarizedSegment, SilenceInterval } from './clipPostProcess';

const PLACEHOLDER_NON_SPEECH_REGEX =
  /^(\[(non_speech_audio|no_speech_detected|no speech|ambient audio|silence|music|music playing|instrumental|inaudible|background noise)\]|none|n\/a)$/i;

/**
 * FFmpeg vocal-clarity filter chain used before Gemini speech transcription:
 * - highpass=80Hz removes AC hum / handling rumble
 * - lowpass=7800Hz keeps full consonant clarity while suppressing high-frequency hiss
 * - dynaudnorm lifts quiet English voices (or speech under background music) cleanly without clipping
 */
export function buildVoiceClarityAudioFilter(includeSilenceDetect: boolean = true): string {
  const chain = [
    'highpass=f=80',
    'lowpass=f=7800',
    'dynaudnorm=f=150:g=15:p=0.9:m=15',
  ];
  if (includeSilenceDetect) {
    chain.push('silencedetect=noise=-35dB:d=0.6');
  }
  return chain.join(',');
}

/**
 * Returns true if the transcript text is empty or only contains a non-speech sentinel.
 */
export function isPlaceholderNonSpeechText(text?: string | null): boolean {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_NON_SPEECH_REGEX.test(trimmed)) return true;
  // Strip any bracketed sound tags and check if any real spoken characters remain
  const stripped = trimmed.replace(/\[[^\]]{1,48}\]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, '');
  return stripped.length < 2;
}

/**
 * Counts spoken words across diarized segments (excluding sound_event segments).
 */
export function countSpokenWordsInSegments(segments: DiarizedSegment[]): number {
  let count = 0;
  for (const seg of segments) {
    const text = (seg.text ?? '').trim();
    if (!text) continue;
    if (seg.kind === 'sound_event' || /^\[[^\]]{2,42}\]$/.test(text)) continue;
    const words = text.split(/\s+/).filter(Boolean);
    count += words.length;
  }
  return count;
}

/**
 * Canonicalizes raw speaker labels emitted by LLMs (e.g. "speaker_01", "S2", "Host").
 */
export function normalizeSpeakerLabel(raw?: string | null, isSoundEvent?: boolean): string {
  if (isSoundEvent) return 'Audio Event';
  const cleaned = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return 'Speaker 1';
  if (/^audio\s*event$/i.test(cleaned)) return 'Audio Event';
  const numMatch = cleaned.match(/^(?:speaker|spk|voice|person|s)[_\s#-]*0*(\d+)$/i);
  if (numMatch) {
    const n = Math.max(1, Number(numMatch[1]));
    return `Speaker ${n}`;
  }
  return cleaned;
}

/**
 * Prevents runaway speaker-per-segment inflation (e.g. "Speaker 1" ... "Speaker 17" on a single-host video):
 * - Normalizes speaker label formatting.
 * - Defaults to a single speaker ("Speaker 1") when diarization appears fragmented
 *   (e.g., > maxSpeakers unique speakers or >= 4 speakers where most appear only once).
 * - Caps total distinct speech speakers at `maxSpeakers` (default 4) and renumbers cleanly
 *   as Speaker 1..N in order of appearance.
 */
export function normalizeAndConsolidateSpeakers(
  segments: DiarizedSegment[],
  maxSpeakers: number = 4
): DiarizedSegment[] {
  const safeMax = Math.max(1, Math.min(6, Math.round(maxSpeakers)));
  const normalized = segments.map((seg) => {
    const isSound =
      seg.kind === 'sound_event' || /^\[[^\]]{2,42}\]$/.test((seg.text ?? '').trim());
    return {
      ...seg,
      kind: (isSound ? 'sound_event' : 'speech') as 'speech' | 'sound_event',
      speaker: normalizeSpeakerLabel(seg.speaker, isSound),
    };
  });

  const speechSegs = normalized.filter((s) => s.kind !== 'sound_event');
  if (speechSegs.length === 0) return normalized;

  const counts = new Map<string, number>();
  const firstSeenOrder: string[] = [];
  for (const s of speechSegs) {
    const label = s.speaker;
    if (!counts.has(label)) {
      firstSeenOrder.push(label);
    }
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const distinctSpeakers = firstSeenOrder;
  if (distinctSpeakers.length <= 1) {
    const singleLabel =
      distinctSpeakers[0] && !/^Speaker \d+$/.test(distinctSpeakers[0])
        ? distinctSpeakers[0]
        : 'Speaker 1';
    return normalized.map((s) =>
      s.kind === 'sound_event' ? s : { ...s, speaker: singleLabel }
    );
  }

  const singleTurnCount = distinctSpeakers.filter((sp) => (counts.get(sp) ?? 0) === 1).length;
  const singleTurnRatio = singleTurnCount / distinctSpeakers.length;

  // Detect hallucinated speaker-per-segment inflation (e.g. Speaker 1..Speaker 17)
  const isFragmentedInflation =
    (distinctSpeakers.length > safeMax && singleTurnRatio >= 0.5) ||
    (distinctSpeakers.length >= 4 && singleTurnRatio >= 0.7);

  if (isFragmentedInflation) {
    // Only preserve speakers that recur >= 2 times (up to safeMax); otherwise default to single Speaker 1
    const recurring = distinctSpeakers
      .filter((sp) => (counts.get(sp) ?? 0) >= 2)
      .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
      .slice(0, safeMax);

    if (recurring.length <= 1) {
      return normalized.map((s) =>
        s.kind === 'sound_event' ? s : { ...s, speaker: 'Speaker 1' }
      );
    }

    const remap = new Map<string, string>();
    recurring.forEach((orig, idx) => {
      remap.set(orig, `Speaker ${idx + 1}`);
    });
    return normalized.map((s) =>
      s.kind === 'sound_event'
        ? s
        : { ...s, speaker: remap.get(s.speaker) ?? 'Speaker 1' }
    );
  }

  // Even when not heavily fragmented, strictly cap at safeMax by frequency and renumber cleanly
  if (distinctSpeakers.length > safeMax) {
    const kept = [...distinctSpeakers]
      .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
      .slice(0, safeMax);
    const keptInOrder = distinctSpeakers.filter((sp) => kept.includes(sp));
    const remap = new Map<string, string>();
    keptInOrder.forEach((orig, idx) => {
      const keepCustomName = !/^Speaker \d+$/.test(orig);
      remap.set(orig, keepCustomName ? orig : `Speaker ${idx + 1}`);
    });
    const fallbackSpeaker = remap.get(kept[0]) ?? 'Speaker 1';
    return normalized.map((s) =>
      s.kind === 'sound_event'
        ? s
        : { ...s, speaker: remap.get(s.speaker) ?? fallbackSpeaker }
    );
  }

  // Clean sequential numbering for generic Speaker N labels (e.g. Speaker 2, Speaker 5 -> Speaker 1, Speaker 2)
  const remap = new Map<string, string>();
  let genericCounter = 1;
  for (const sp of distinctSpeakers) {
    if (/^Speaker \d+$/.test(sp)) {
      remap.set(sp, `Speaker ${genericCounter++}`);
    } else {
      remap.set(sp, sp);
    }
  }

  return normalized.map((s) =>
    s.kind === 'sound_event' ? s : { ...s, speaker: remap.get(s.speaker) ?? 'Speaker 1' }
  );
}

/**
 * Extracts a clean, de-duplicated, consolidated list of speakers from segments.
 */
export function extractConsolidatedSpeakers(segments: DiarizedSegment[]): string[] {
  const speechSpeakers = Array.from(
    new Set(
      segments
        .filter((s) => s.kind !== 'sound_event')
        .map((s) => s.speaker || 'Speaker 1')
    )
  );
  if (speechSpeakers.length > 0) return speechSpeakers;
  const fallback = Array.from(new Set(segments.map((s) => s.speaker || 'Audio Event')));
  return fallback.length > 0 ? fallback : ['Speaker 1'];
}

/**
 * Computes non-silent speech-eligible intervals within [0, durationSec] from FFmpeg silencedetect gaps.
 */
export function computeNonSilentIntervals(
  durationSec: number,
  silences: SilenceInterval[] = []
): { startSec: number; endSec: number }[] {
  const safeDur = Math.max(1, durationSec);
  if (!silences || silences.length === 0) {
    return [{ startSec: 0, endSec: safeDur }];
  }

  const sorted = [...silences]
    .map((s) => ({
      startSec: Math.max(0, Math.min(safeDur, s.startSec)),
      endSec: Math.max(0, Math.min(safeDur, s.endSec)),
    }))
    .filter((s) => s.endSec > s.startSec + 0.15)
    .sort((a, b) => a.startSec - b.startSec);

  const active: { startSec: number; endSec: number }[] = [];
  let cursor = 0;

  for (const gap of sorted) {
    if (gap.startSec > cursor + 0.25) {
      active.push({ startSec: cursor, endSec: gap.startSec });
    }
    cursor = Math.max(cursor, gap.endSec);
  }

  if (safeDur > cursor + 0.25) {
    active.push({ startSec: cursor, endSec: safeDur });
  }

  return active.length > 0 ? active : [{ startSec: 0, endSec: safeDur }];
}

/**
 * Splits a plain verbatim transcript into short, readable subtitle segments distributed
 * across the non-silent audio regions of a video or clip.
 */
export function splitTranscriptIntoTimedSegments(
  transcriptText: string,
  durationSec: number,
  silences: SilenceInterval[] = [],
  offsetSec: number = 0
): DiarizedSegment[] {
  if (isPlaceholderNonSpeechText(transcriptText)) return [];

  const cleanText = transcriptText.replace(/\s+/g, ' ').trim();
  // Split into sentence-like chunks, then sub-chunk long sentences into ~6-word subtitle lines
  const rawSentences = cleanText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const sentence of rawSentences) {
    const words = sentence.split(/\s+/).filter(Boolean);
    if (words.length <= 7) {
      chunks.push(sentence);
    } else {
      for (let i = 0; i < words.length; i += 6) {
        chunks.push(words.slice(i, i + 6).join(' '));
      }
    }
  }

  if (chunks.length === 0) return [];

  const activeRanges = computeNonSilentIntervals(durationSec, silences);
  const totalActiveDur = activeRanges.reduce((acc, r) => acc + (r.endSec - r.startSec), 0);
  const totalWeight = chunks.reduce((acc, c) => acc + Math.max(4, c.length), 0);

  // Map virtual active time [0..totalActiveDur] onto real non-silent wall clock times
  const mapActiveTime = (virtualSec: number): number => {
    let remaining = Math.max(0, Math.min(totalActiveDur, virtualSec));
    for (const range of activeRanges) {
      const len = range.endSec - range.startSec;
      if (remaining <= len + 0.0001) {
        return range.startSec + remaining;
      }
      remaining -= len;
    }
    const last = activeRanges[activeRanges.length - 1];
    return last ? last.endSec : durationSec;
  };

  const segments: DiarizedSegment[] = [];
  let virtualCursor = 0;

  for (const chunk of chunks) {
    const share = Math.max(4, chunk.length) / totalWeight;
    const segDur = Math.max(0.45, totalActiveDur * share);
    const relStart = mapActiveTime(virtualCursor);
    const relEnd = Math.max(relStart + 0.4, mapActiveTime(virtualCursor + segDur));
    segments.push({
      startSec: Number((offsetSec + relStart).toFixed(2)),
      endSec: Number((offsetSec + Math.min(durationSec, relEnd)).toFixed(2)),
      speaker: 'Speaker 1',
      text: chunk,
      kind: 'speech',
    });
    virtualCursor += segDur;
  }

  return segments;
}

/**
 * Deterministically parses model-emitted timestamps in "HH:MM:SS.cc", "MM:SS.cc",
 * "MM:SS", "12.34s", or raw numeric seconds into decimal seconds.
 * Eliminates MMSS-as-integer confusion (e.g. "08:41" -> 521s, never 841s).
 */
export function parseTimestampToSeconds(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Match HH:MM:SS(.ms) or MM:SS(.ms)
  const colonMatch = trimmed.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/);
  if (colonMatch) {
    if (colonMatch[3] !== undefined) {
      const hrs = Number(colonMatch[1]);
      const mins = Number(colonMatch[2]);
      const secs = Number(colonMatch[3]);
      if (Number.isFinite(hrs) && Number.isFinite(mins) && Number.isFinite(secs)) {
        return Number((hrs * 3600 + mins * 60 + secs).toFixed(3));
      }
    } else {
      const mins = Number(colonMatch[1]);
      const secs = Number(colonMatch[2]);
      if (Number.isFinite(mins) && Number.isFinite(secs)) {
        return Number((mins * 60 + secs).toFixed(3));
      }
    }
  }

  // Match MM:SS.cc where seconds has decimals (regex above handles 2-part without decimal in group 2)
  const mmssDecMatch = trimmed.match(/^(\d{1,2}):(\d{1,2}\.\d+)$/);
  if (mmssDecMatch) {
    const mins = Number(mmssDecMatch[1]);
    const secs = Number(mmssDecMatch[2]);
    if (Number.isFinite(mins) && Number.isFinite(secs)) {
      return Number((mins * 60 + secs).toFixed(3));
    }
  }

  const numericStr = trimmed.replace(/s$/i, '').trim();
  const parsed = Number(numericStr);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Defense-in-depth detector & repair for multimodal models that accidentally emit
 * MMSS clock values as raw decimal numbers (e.g. 08:41 -> 841.0 instead of 521.0s,
 * 14:28 -> 1428.0 instead of 868.0s).
 * In true seconds >= 100, ~40% of timestamps have (t % 100) >= 60.
 * In MMSS-encoded numbers, ~0% have (t % 100) >= 60.
 */
export function detectAndRepairMmssSegments(
  segments: DiarizedSegment[],
  durationSec: number
): { segments: DiarizedSegment[]; repaired: boolean } {
  if (segments.length < 6 || durationSec < 95) {
    return { segments, repaired: false };
  }

  const candidateValues: number[] = [];
  for (const seg of segments) {
    if (Number.isFinite(seg.startSec) && seg.startSec >= 100) {
      candidateValues.push(seg.startSec);
    }
    if (Number.isFinite(seg.endSec) && seg.endSec >= 100) {
      candidateValues.push(seg.endSec);
    }
  }

  if (candidateValues.length < 10) {
    return { segments, repaired: false };
  }

  const modGe60Count = candidateValues.filter((v) => v % 100 >= 60).length;
  const modGe60Ratio = modGe60Count / candidateValues.length;

  // Also check that converting MMSS -> seconds stays within [0, durationSec * 1.08]
  // and fixes obvious minute-boundary jumps (e.g. 558 -> 602 or maxRaw > durationSec)
  const convertMmss = (v: number): number => {
    if (!Number.isFinite(v) || v < 60) return Math.max(0, v);
    const mins = Math.floor(v / 100);
    const secs = v % 100;
    if (secs >= 60) {
      // Interpolated value inside a minute boundary jump: clamp cleanly to next minute
      return mins * 60 + 59.9;
    }
    return Number((mins * 60 + secs).toFixed(2));
  };

  const maxRaw = Math.max(...candidateValues);
  const maxConverted = Math.max(...candidateValues.map(convertMmss));

  // Detect unmistakable MMSS signature: virtually zero timestamps in x60..x99 AND
  // converted range fits cleanly within the real video duration
  const looksMmss =
    modGe60Ratio <= 0.04 &&
    maxConverted <= durationSec + 5 &&
    (maxRaw > durationSec + 5 || candidateValues.length >= 16);

  if (!looksMmss) {
    return { segments, repaired: false };
  }

  return {
    repaired: true,
    segments: segments.map((seg) => {
      const nextStart = convertMmss(seg.startSec);
      const nextEnd = Math.max(nextStart + 0.35, convertMmss(seg.endSec));
      return {
        ...seg,
        startSec: nextStart,
        endSec: nextEnd,
      };
    }),
  };
}

/**
 * Clamps and repairs out-of-range, MMSS-encoded, or inverted timestamps emitted by multimodal models.
 * Handles cases where models output timestamps in milliseconds, MMSS-as-number, or beyond the media duration.
 * IMPORTANT: When `timestampsAreRelative` is true (extracted clip audio always starts at 0s),
 * we NEVER subtract `offsetSec`, preventing late-starting speech in long clips (e.g. 52s inside
 * a 104s clip with offsetSec=51.5s) from being wrongly shifted back to 0.5s.
 */
export function sanitizeSegmentTimings(
  segments: DiarizedSegment[],
  durationSec: number,
  offsetSec: number = 0,
  timestampsAreRelative: boolean = false
): DiarizedSegment[] {
  const safeDur = Math.max(1, durationSec);
  const valid = segments.filter((s) => s.text && s.text.trim().length > 0);
  if (valid.length === 0) return [];

  // Detect millisecond outputs (e.g. maxEnd > durationSec * 20 when durationSec <= 3600)
  const maxRawEnd = Math.max(...valid.map((s) => (Number.isFinite(s.endSec) ? s.endSec : 0)));
  const scaleDivisor = maxRawEnd > safeDur * 20 && maxRawEnd <= safeDur * 1500 ? 1000 : 1;

  const prescaled =
    scaleDivisor === 1
      ? valid
      : valid.map((s) => ({
          ...s,
          startSec: Number.isFinite(s.startSec) ? s.startSec / scaleDivisor : 0,
          endSec: Number.isFinite(s.endSec) ? s.endSec / scaleDivisor : 0,
        }));

  // Repair MMSS-encoded numeric timestamps BEFORE clamping to safeDur
  const mmssCheck = detectAndRepairMmssSegments(prescaled, safeDur);
  const normalizedInput = mmssCheck.segments;

  const scaledStarts = normalizedInput.map((s) => (Number.isFinite(s.startSec) ? s.startSec : 0));
  const scaledEnds = normalizedInput.map((s) => (Number.isFinite(s.endSec) ? s.endSec : 0));
  const minScaledStart = Math.min(...scaledStarts);
  const maxScaledEnd = Math.max(...scaledEnds);

  // Only treat timestamps as already absolute if caller didn't declare them relative
  // AND they clearly exceed the relative clip duration while anchored at offsetSec.
  const alreadyOffset =
    !timestampsAreRelative &&
    offsetSec > 2 &&
    minScaledStart >= offsetSec - 1.5 &&
    maxScaledEnd > safeDur + 2;

  const sorted = [...normalizedInput]
    .map((s) => {
      const rawStart = Number.isFinite(s.startSec) ? s.startSec : 0;
      const rawEnd = Number.isFinite(s.endSec) ? s.endSec : rawStart + 1.5;
      const relStart = alreadyOffset ? rawStart - offsetSec : rawStart;
      const relEnd = alreadyOffset ? rawEnd - offsetSec : rawEnd;

      const clampedStart = Math.max(0, Math.min(safeDur - 0.35, relStart));
      const clampedEnd = Math.max(
        clampedStart + 0.35,
        Math.min(safeDur, relEnd > clampedStart ? relEnd : clampedStart + 1.5)
      );

      return {
        ...s,
        startSec: Number((offsetSec + clampedStart).toFixed(2)),
        endSec: Number((offsetSec + clampedEnd).toFixed(2)),
        text: s.text.trim(),
      };
    })
    .sort((a, b) => a.startSec - b.startSec);

  return sorted;
}

/**
 * Splits a long clip duration into contiguous transcription windows (e.g. 35s each)
 * so multimodal models never lose timestamp sync or truncate after the first 20-30s.
 */
export function buildClipTranscriptionWindows(
  clipDurationSec: number,
  maxWindowSec: number = 35
): { relStartSec: number; durationSec: number }[] {
  const safeDur = Math.max(1, Number(clipDurationSec.toFixed(2)));
  const maxWin = Math.max(15, maxWindowSec);
  if (safeDur <= maxWin + 7) {
    return [{ relStartSec: 0, durationSec: safeDur }];
  }

  const count = Math.ceil(safeDur / maxWin);
  const winLen = safeDur / count;
  const windows: { relStartSec: number; durationSec: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = Number((i * winLen).toFixed(2));
    const end = i === count - 1 ? safeDur : Number(((i + 1) * winLen).toFixed(2));
    windows.push({
      relStartSec: start,
      durationSec: Number(Math.max(1, end - start).toFixed(2)),
    });
  }
  return windows;
}

/**
 * Splits a full project video into contiguous transcription windows so long uploads
 * (e.g., 24-minute episodes or 45-minute podcasts) stay tightly synced to the real audio
 * without MMSS drift, output truncation, or end-of-video timestamp pileups.
 */
export function buildProjectTranscriptionWindows(
  videoDurationSec: number
): { startSec: number; durationSec: number }[] {
  const safeDur = Math.max(1, Number(videoDurationSec.toFixed(2)));
  if (safeDur <= 55) {
    return [{ startSec: 0, durationSec: safeDur }];
  }
  const targetWindowSec =
    safeDur <= 480 ? 48 : safeDur <= 1800 ? 85 : 115;
  return buildClipTranscriptionWindows(safeDur, targetWindowSec).map((w) => ({
    startSec: w.relStartSec,
    durationSec: w.durationSec,
  }));
}

/**
 * Combines Stage 3 diarized segments with Stage 2 verbatim transcript recovery,
 * and consolidates runaway speaker IDs:
 * - If Stage 3 missed speech (0 spoken words or dropped >75% of a real verbatim transcript),
 *   recovers timed speech segments from verbatimTranscript across non-silent regions
 *   while preserving valid non-speech sound events (e.g., [Laughing], [Applause]).
 * - Consolidates speaker labels so a single-speaker clip never shows 17+ bogus speakers.
 */
export function mergeSpeechAndSoundSegments(params: {
  diarizedSegments: DiarizedSegment[];
  verbatimTranscript?: string;
  durationSec: number;
  silences?: SilenceInterval[];
  offsetSec?: number;
  timestampsAreRelative?: boolean;
  maxSpeakers?: number;
}): DiarizedSegment[] {
  const {
    diarizedSegments,
    verbatimTranscript = '',
    durationSec,
    silences = [],
    offsetSec = 0,
    timestampsAreRelative = false,
    maxSpeakers = 4,
  } = params;

  const sanitized = sanitizeSegmentTimings(
    diarizedSegments,
    durationSec,
    offsetSec,
    timestampsAreRelative
  );
  const diarizedSpeechWords = countSpokenWordsInSegments(sanitized);

  const hasRealVerbatim = !isPlaceholderNonSpeechText(verbatimTranscript);
  const verbatimWordCount = hasRealVerbatim
    ? verbatimTranscript.trim().split(/\s+/).filter(Boolean).length
    : 0;

  // Recover spoken subtitles if diarization missed speech or drastically truncated it
  const shouldRecoverFromVerbatim =
    hasRealVerbatim &&
    verbatimWordCount >= 2 &&
    (diarizedSpeechWords === 0 || (verbatimWordCount >= 8 && diarizedSpeechWords < verbatimWordCount * 0.25));

  if (shouldRecoverFromVerbatim) {
    const recoveredSpeech = splitTranscriptIntoTimedSegments(
      verbatimTranscript,
      durationSec,
      silences,
      offsetSec
    );
    const genuineSoundEvents = sanitized.filter(
      (s) =>
        s.kind === 'sound_event' &&
        !/^\[(ambient audio|silence|no speech|non_speech_audio)\]$/i.test(s.text.trim())
    );
    return normalizeAndConsolidateSpeakers(
      [...recoveredSpeech, ...genuineSoundEvents].sort((a, b) => a.startSec - b.startSec),
      maxSpeakers
    );
  }

  if (sanitized.length > 0) {
    return normalizeAndConsolidateSpeakers(sanitized, maxSpeakers);
  }

  return [
    {
      startSec: Number(offsetSec.toFixed(2)),
      endSec: Number((offsetSec + Math.max(1, durationSec)).toFixed(2)),
      speaker: 'Audio Event',
      text: '[Ambient audio]',
      kind: 'sound_event',
      soundCategory: 'ambient',
    },
  ];
}
