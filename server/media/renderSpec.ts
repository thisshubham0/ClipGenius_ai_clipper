import zlib from 'node:zlib';
import type {
  AspectRatio,
  BackgroundStyle,
  BrandKit,
  CaptionAnimationStyle,
  CaptionStyle,
  Clip,
  TranscriptWord,
} from '../../src/types/clipgenius';
import {
  getAssAlignment,
  getSafeCaptionLayoutMetrics,
  mapFontFamilyToAss,
  resolveCaptionStyle,
  wrapCaptionWords,
  type ResolvedCaptionStyle,
} from '../../src/lib/captionStyles';
import {
  buildCaptionTrackCues,
  filterWordsForCaptions,
  type SkippedRange,
} from '../../src/lib/editorEngine';
import { getBackgroundStyleOption } from '../../src/lib/clipVersions';

export interface TargetDimensions {
  width: number;
  height: number;
}

export interface KeepSegment {
  /** Start offset in seconds relative to clip startSec */
  relStart: number;
  /** End offset in seconds relative to clip startSec */
  relEnd: number;
}

/**
 * Given clip bounds [clipStartSec, clipEndSec] and absolute skippedRanges
 * (from removeSilences / removeFillers), returns the kept relative intervals
 * in [0, clipEndSec - clipStartSec].
 */
export function computeKeepSegments(
  clipStartSec: number,
  clipEndSec: number,
  skippedRanges: SkippedRange[]
): KeepSegment[] {
  const duration = Math.max(0.5, Number((clipEndSec - clipStartSec).toFixed(3)));
  if (!skippedRanges || skippedRanges.length === 0) {
    return [{ relStart: 0, relEnd: duration }];
  }

  const relSkips = skippedRanges
    .map((r) => ({
      start: Math.max(0, Number((r.startSec - clipStartSec).toFixed(3))),
      end: Math.min(duration, Number((r.endSec - clipStartSec).toFixed(3))),
    }))
    .filter((r) => r.end - r.start >= 0.1)
    .sort((a, b) => a.start - b.start);

  if (relSkips.length === 0) {
    return [{ relStart: 0, relEnd: duration }];
  }

  const kept: KeepSegment[] = [];
  let cursor = 0;
  for (const skip of relSkips) {
    if (skip.start > cursor + 0.1) {
      kept.push({
        relStart: Number(cursor.toFixed(3)),
        relEnd: Number(skip.start.toFixed(3)),
      });
    }
    cursor = Math.max(cursor, skip.end);
  }
  if (duration - cursor >= 0.1) {
    kept.push({
      relStart: Number(cursor.toFixed(3)),
      relEnd: Number(duration.toFixed(3)),
    });
  }

  return kept.length > 0 ? kept : [{ relStart: 0, relEnd: duration }];
}

/**
 * Maps a timestamp relative to the uncut clip start into the concatenated
 * timeline produced after removing skipped silence/filler segments.
 */
export function remapTimeThroughKeepSegments(
  relSec: number,
  keepSegments?: KeepSegment[]
): number {
  if (!keepSegments || keepSegments.length === 0) {
    return Math.max(0, relSec);
  }
  let acc = 0;
  for (const seg of keepSegments) {
    if (relSec <= seg.relStart) {
      return Number(acc.toFixed(3));
    }
    if (relSec <= seg.relEnd) {
      return Number((acc + (relSec - seg.relStart)).toFixed(3));
    }
    acc += seg.relEnd - seg.relStart;
  }
  return Number(acc.toFixed(3));
}

export function getTargetDimensions(
  aspectRatio: AspectRatio,
  quality: '480p' | '720p' | '1080p'
): TargetDimensions {
  if (quality === '480p') {
    switch (aspectRatio) {
      case '9:16':
        return { width: 480, height: 854 };
      case '16:9':
        return { width: 854, height: 480 };
      case '1:1':
        return { width: 480, height: 480 };
      case '4:5':
        return { width: 480, height: 600 };
      default:
        return { width: 480, height: 854 };
    }
  }
  const isHd = quality === '1080p';
  switch (aspectRatio) {
    case '9:16':
      return isHd ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
    case '16:9':
      return isHd ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
    case '1:1':
      return isHd ? { width: 1080, height: 1080 } : { width: 720, height: 720 };
    case '4:5':
      return isHd ? { width: 1080, height: 1350 } : { width: 720, height: 900 };
    default:
      return isHd ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
  }
}

/**
 * Converts standard #RRGGBB hex color into ASS &H00BBGGRR format.
 */
export function hexToAssColor(hex: string, alphaHex: string = '00'): string {
  const cleaned = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return `&H${alphaHex}FFFFFF`;
  }
  const r = cleaned.slice(0, 2).toUpperCase();
  const g = cleaned.slice(2, 4).toUpperCase();
  const b = cleaned.slice(4, 6).toUpperCase();
  return `&H${alphaHex.toUpperCase()}${b}${g}${r}`;
}

export function formatAssTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const cs = Math.floor((safe - Math.floor(safe)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

export function escapeFfmpegFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

export interface AssSubtitleOptions {
  clip: Clip;
  projectWords?: TranscriptWord[];
  resolvedStyle?: Partial<ResolvedCaptionStyle> & CaptionStyle & { animation: CaptionAnimationStyle };
  width: number;
  height: number;
  clipDurationSec: number;
  brandKit?: Partial<BrandKit>;
  keepSegments?: KeepSegment[];
}

function splitManualCaptionIntoCues(
  text: string,
  totalDurationSec: number
): { relStart: number; relEnd: number; text: string; isSoundEvent?: boolean }[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const wordsPerCue = 6;
  const groups: string[] = [];
  for (let i = 0; i < tokens.length; i += wordsPerCue) {
    groups.push(tokens.slice(i, i + wordsPerCue).join(' '));
  }
  const safeDur = Math.max(1, totalDurationSec);
  const slice = safeDur / groups.length;
  return groups.map((groupText, idx) => ({
    relStart: Number((idx * slice).toFixed(3)),
    relEnd: Number(Math.min(safeDur, (idx + 1) * slice).toFixed(3)),
    text: groupText,
  }));
}

/**
 * Generates an Advanced SubStation Alpha (.ass) file matching the browser
 * caption studio (font size, colors, top/center/bottom alignment, uppercase,
 * karaoke timing tags, manual caption overrides, non-speech sound events like
 * [Laughing] / [Singing] / [Humming], silence-cut remapping, translated subtitles,
 * and optional brand watermark).
 */
export function generateAssSubtitles(options: AssSubtitleOptions): string {
  const { clip, projectWords, width, height, clipDurationSec, brandKit, keepSegments } = options;
  const baseResolved = resolveCaptionStyle(clip);
  const resolvedStyle: ResolvedCaptionStyle = options.resolvedStyle
    ? {
        ...baseResolved,
        ...options.resolvedStyle,
      }
    : baseResolved;
  const { effectiveWordsPerCue: wordsPerCue } = getSafeCaptionLayoutMetrics(
    clip.aspectRatio,
    resolvedStyle
  );

  const hasCuts =
    Boolean(keepSegments && keepSegments.length > 0) &&
    (keepSegments!.length > 1 ||
      keepSegments![0].relStart > 0.05 ||
      keepSegments![0].relEnd < clipDurationSec - 0.05);

  const effectiveDurationSec =
    keepSegments && keepSegments.length > 0
      ? Math.max(
          0.5,
          Number(
            keepSegments
              .reduce((acc, seg) => acc + Math.max(0, seg.relEnd - seg.relStart), 0)
              .toFixed(3)
          )
        )
      : clipDurationSec;

  const activeLang = clip.subtitleLanguage || 'original';
  const useTranslatedCues =
    activeLang !== 'original' && activeLang !== clip.wordsLanguage;
  const translatedCues = useTranslatedCues
    ? clip.translatedCues?.[activeLang]
    : undefined;

  let cues: {
    relStart: number;
    relEnd: number;
    text: string;
    isSoundEvent?: boolean;
    wordTimings?: { relStart: number; relEnd: number }[];
  }[];

  if (
    activeLang === 'original' &&
    clip.captionTextEdited &&
    clip.captionText.trim().length > 0
  ) {
    cues = splitManualCaptionIntoCues(clip.captionText, effectiveDurationSec);
  } else {
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
      wordsPerCue,
      translatedCues,
    });

    if (trackCues.length > 0) {
      cues = trackCues
        .map((c) => {
          const rawStart = Math.max(0, c.startSec - clip.startSec);
          const rawEnd = Math.min(clipDurationSec, Math.max(rawStart + 0.35, c.endSec - clip.startSec));
          const relStart = hasCuts
            ? remapTimeThroughKeepSegments(rawStart, keepSegments)
            : rawStart;
          const relEnd = hasCuts
            ? remapTimeThroughKeepSegments(rawEnd, keepSegments)
            : rawEnd;
          const clampedEnd = Math.min(effectiveDurationSec, Math.max(relStart + 0.2, relEnd));

          const wordTimings =
            !c.isSoundEvent && c.words && c.words.length > 0
              ? c.words.map((w, idx) => {
                  const rawWS = Math.max(rawStart, w.startSec - clip.startSec);
                  const rawWE = Math.min(rawEnd, Math.max(rawWS + 0.06, w.endSec - clip.startSec));
                  const mappedS = hasCuts
                    ? remapTimeThroughKeepSegments(rawWS, keepSegments)
                    : rawWS;
                  const mappedE = hasCuts
                    ? remapTimeThroughKeepSegments(rawWE, keepSegments)
                    : rawWE;
                  return {
                    relStart: idx === 0 ? relStart : Math.max(relStart, Math.min(clampedEnd - 0.04, mappedS)),
                    relEnd: idx === c.words!.length - 1 ? clampedEnd : Math.min(clampedEnd, Math.max(mappedS + 0.04, mappedE)),
                  };
                })
              : undefined;

          return {
            relStart,
            relEnd: clampedEnd,
            text: c.text,
            isSoundEvent: c.isSoundEvent,
            wordTimings,
          };
        })
        .filter((c) => c.relEnd > c.relStart + 0.05);
    } else if (clip.captionTextEdited && clip.captionText.trim().length > 0) {
      cues = splitManualCaptionIntoCues(clip.captionText, effectiveDurationSec);
    } else {
      cues = [];
    }
  }

  const alignment = getAssAlignment(resolvedStyle.position, resolvedStyle.textAlign);
  const assFontName = mapFontFamilyToAss(resolvedStyle.fontFamily);
  const isBoldFlag = resolvedStyle.fontWeight >= 700 ? -1 : 0;

  const scaleFactor = Math.min(width, height) / 720;
  const scaledFontSize = Math.max(24, Math.round(resolvedStyle.fontSizePx * 1.9 * scaleFactor));
  const soundEventFontSize = Math.max(22, Math.round(scaledFontSize * 0.88));
  const marginV = Math.round(height * (resolvedStyle.position === 'center' ? 0.04 : 0.1));
  const marginLR = Math.round(width * 0.08);

  const primaryAss =
    resolvedStyle.animation === 'karaoke'
      ? hexToAssColor(resolvedStyle.highlightColor)
      : hexToAssColor(resolvedStyle.primaryColor);
  const highlightAss = hexToAssColor(resolvedStyle.highlightColor);
  const secondaryAss = hexToAssColor(resolvedStyle.primaryColor);
  const outlineAss = hexToAssColor(resolvedStyle.strokeColor);
  const shadowAss = '&H80000000';
  const soundEventAss = hexToAssColor('#7DD3FC');

  // Match background box vs clean stroke outline from Captions tab & Live Preview
  const hasBoxBg = resolvedStyle.backgroundOpacity >= 0.18;
  const assAlphaByte = Math.round((1 - Math.min(0.95, Math.max(0, resolvedStyle.backgroundOpacity))) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
  const boxBgAss = hexToAssColor(resolvedStyle.backgroundColor, assAlphaByte);
  const borderStyle = hasBoxBg ? 3 : 1;
  const captionOutlineColor = hasBoxBg ? boxBgAss : outlineAss;
  const captionBackColor = hasBoxBg ? boxBgAss : shadowAss;
  const captionOutlineWidth = hasBoxBg
    ? Number(Math.max(4, Math.round(6 * scaleFactor)).toFixed(1))
    : Number(Math.max(0.5, resolvedStyle.strokeWidthPx * 1.2 * scaleFactor).toFixed(1));
  const captionShadowDepth = hasBoxBg ? 0 : Number(Math.max(1, 2 * scaleFactor).toFixed(1));

  const watermarkAlign =
    brandKit?.watermarkPosition === 'top_left'
      ? 7
      : brandKit?.watermarkPosition === 'bottom_right'
      ? 3
      : 9;

  const lines: string[] = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${assFontName},${scaledFontSize},${primaryAss},${secondaryAss},${captionOutlineColor},${captionBackColor},${isBoldFlag},0,0,0,100,100,0,0,${borderStyle},${captionOutlineWidth},${captionShadowDepth},${alignment},${marginLR},${marginLR},${marginV},1`,
    `Style: SoundEvent,${assFontName},${soundEventFontSize},${soundEventAss},${soundEventAss},${outlineAss},${shadowAss},-1,-1,0,0,100,100,1,0,1,2.5,2,${alignment},${marginLR},${marginLR},${marginV},1`,
    `Style: Watermark,DejaVu Sans,${Math.max(18, Math.round(22 * scaleFactor))},&H30FFFFFF,&H30FFFFFF,&H60000000,&H80000000,0,0,0,0,100,100,0,0,1,1.5,1,${watermarkAlign},36,36,32,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  if (
    brandKit &&
    brandKit.watermarkPosition &&
    brandKit.watermarkPosition !== 'none' &&
    brandKit.watermarkText?.trim()
  ) {
    lines.push(
      `Dialogue: 0,${formatAssTimestamp(0)},${formatAssTimestamp(effectiveDurationSec)},Watermark,,0,0,0,,${escapeAssText(brandKit.watermarkText.trim())}`
    );
  }

  for (const cue of cues) {
    if (cue.relEnd <= cue.relStart) continue;
    const startTs = formatAssTimestamp(cue.relStart);
    const endTs = formatAssTimestamp(cue.relEnd);

    if (cue.isSoundEvent) {
      const soundText = `{\\fad(100,100)}${escapeAssText(cue.text)}`;
      lines.push(`Dialogue: 1,${startTs},${endTs},SoundEvent,,0,0,0,,${soundText}`);
      continue;
    }

    const rawText = resolvedStyle.uppercase ? cue.text.toUpperCase() : cue.text;
    const tokens = rawText.trim().split(/\s+/).filter(Boolean);
    const wrappedLines = wrapCaptionWords(tokens, wordsPerCue, 2);
    const lineSplitIdx = wrappedLines.length > 1 ? wrappedLines[0].length : -1;

    const joinTokensWithWrap = (styledTokens: string[]) => {
      if (lineSplitIdx > 0 && lineSplitIdx < styledTokens.length) {
        return `${styledTokens.slice(0, lineSplitIdx).join(' ')}\\N${styledTokens
          .slice(lineSplitIdx)
          .join(' ')}`;
      }
      return styledTokens.join(' ');
    };

    const hasExactWordTimings =
      Boolean(cue.wordTimings && cue.wordTimings.length === tokens.length);

    if (resolvedStyle.animation === 'karaoke') {
      const styled = tokens.map((tok, idx) => {
        if (hasExactWordTimings) {
          const curStart = cue.wordTimings![idx].relStart;
          const nextStart =
            idx + 1 < tokens.length ? cue.wordTimings![idx + 1].relStart : cue.relEnd;
          const spanCs = Math.max(5, Math.round(Math.max(0.05, nextStart - curStart) * 100));
          return `{\\k${spanCs}}${escapeAssText(tok)}`;
        }
        const totalCs = Math.max(10, Math.round((cue.relEnd - cue.relStart) * 100));
        const perWordCs = Math.max(5, Math.floor(totalCs / Math.max(1, tokens.length)));
        return `{\\k${perWordCs}}${escapeAssText(tok)}`;
      });
      lines.push(
        `Dialogue: 1,${startTs},${endTs},Caption,,0,0,0,,${joinTokensWithWrap(styled)}`
      );
    } else if (resolvedStyle.animation === 'pop' && tokens.length >= 2) {
      // Emit sequential word-by-word active-word highlight matching Live Preview 1:1
      const cueDur = Math.max(0.25, cue.relEnd - cue.relStart);
      const step = cueDur / tokens.length;
      for (let activeIdx = 0; activeIdx < tokens.length; activeIdx += 1) {
        let wStart: number;
        let wEnd: number;
        if (hasExactWordTimings) {
          wStart = activeIdx === 0 ? cue.relStart : cue.wordTimings![activeIdx].relStart;
          wEnd =
            activeIdx === tokens.length - 1
              ? cue.relEnd
              : Math.max(wStart + 0.04, cue.wordTimings![activeIdx + 1].relStart);
        } else {
          wStart = cue.relStart + activeIdx * step;
          wEnd = activeIdx === tokens.length - 1 ? cue.relEnd : cue.relStart + (activeIdx + 1) * step;
        }
        if (wEnd <= wStart + 0.02) continue;
        const styled = tokens.map((tok, idx) =>
          idx === activeIdx
            ? `{\\c${highlightAss}}${escapeAssText(tok)}{\\c${secondaryAss}}`
            : escapeAssText(tok)
        );
        const prefix = activeIdx === 0 ? '{\\fscx95\\fscy95\\t(0,80,\\fscx100\\fscy100)}' : '';
        lines.push(
          `Dialogue: 1,${formatAssTimestamp(wStart)},${formatAssTimestamp(wEnd)},Caption,,0,0,0,,${prefix}${joinTokensWithWrap(styled)}`
        );
      }
    } else if (resolvedStyle.animation === 'fade') {
      const plain = joinTokensWithWrap(tokens.map(escapeAssText));
      lines.push(`Dialogue: 1,${startTs},${endTs},Caption,,0,0,0,,{\\fad(120,120)}${plain}`);
    } else {
      const plain = joinTokensWithWrap(tokens.map(escapeAssText));
      lines.push(`Dialogue: 1,${startTs},${endTs},Caption,,0,0,0,,${plain}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export interface ReframeFilterOptions {
  width: number;
  height: number;
  cropOffsetX: number;
  backgroundBlurFill: boolean;
  backgroundStyle?: BackgroundStyle;
  assFilePath?: string;
  autoZoom?: boolean;
}

export interface ClipRenderFilterOptions extends ReframeFilterOptions {
  keepSegments?: KeepSegment[];
  clipDurationSec?: number;
  includeVideo?: boolean;
  hasAudio?: boolean;
  hasSoundtrack?: boolean;
  soundtrackVolume?: number;
}

export interface ClipRenderFilterGraph {
  filterComplex: string;
  videoMap: string | null;
  audioMap: string | null;
}

function buildReframeSegment(
  inputLabel: string,
  options: ReframeFilterOptions
): string {
  const { width, height, backgroundBlurFill, assFilePath, autoZoom } = options;
  const resolvedBg: BackgroundStyle =
    options.backgroundStyle ?? (backgroundBlurFill ? 'blur_fill' : 'fill_crop');
  const xRatio = Math.max(0, Math.min(1, options.cropOffsetX / 100));
  const subtitleSuffix = assFilePath
    ? `,ass='${escapeFfmpegFilterPath(assFilePath)}'`
    : '';

  if (resolvedBg === 'blur_fill') {
    return (
      `${inputLabel}split=2[bg][fg];` +
      `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=24[bgb];` +
      `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[fgs];` +
      `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p${subtitleSuffix}[vout]`
    );
  }

  if (
    resolvedBg === 'dark_gradient' ||
    resolvedBg === 'midnight_neon' ||
    resolvedBg === 'warm_studio' ||
    resolvedBg === 'clean_cinema'
  ) {
    const bgOpt = getBackgroundStyleOption(resolvedBg);
    const hexColor = bgOpt.ffmpegColorHex.replace('#', '0x');
    const padRatio = resolvedBg === 'clean_cinema' ? 0.94 : 0.88;
    const fgMaxW = Math.max(64, Math.floor((width * padRatio) / 2) * 2);
    const fgMaxH = Math.max(64, Math.floor((height * padRatio) / 2) * 2);
    const accentFrame = bgOpt.ffmpegAccentHex
      ? `,drawbox=x=10:y=10:w=iw-20:h=ih-20:color=${bgOpt.ffmpegAccentHex.replace('#', '0x')}@0.45:t=3`
      : '';

    return (
      `color=c=${hexColor}:s=${width}x${height}[bgcanvas];` +
      `${inputLabel}scale=${fgMaxW}:${fgMaxH}:force_original_aspect_ratio=decrease[fgs];` +
      `[bgcanvas][fgs]overlay=(W-w)/2:(H-h)/2:shortest=1${accentFrame},setsar=1,format=yuv420p${subtitleSuffix}[vout]`
    );
  }

  // Full-bleed smart crop ('fill_crop')
  const scaleW = autoZoom ? Math.round((width * 1.08) / 2) * 2 : width;
  const scaleH = autoZoom ? Math.round((height * 1.08) / 2) * 2 : height;

  return (
    `${inputLabel}scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height}:'(iw-${width})*${xRatio.toFixed(4)}':'(ih-${height})/2',` +
    `setsar=1,format=yuv420p${subtitleSuffix}[vout]`
  );
}

/**
 * Constructs a deterministic FFmpeg filter_complex graph supporting
 * all 6 background styles, horizontal crop anchor reframing, optional
 * autoZoom punch-in, and optional libass burned-in subtitles.
 */
export function buildReframeFilterComplex(options: ReframeFilterOptions): string {
  return buildReframeSegment('[0:v]', options);
}

/**
 * Full clip render graph supporting silence/filler segment cutting + concat,
 * horizontal crop anchor, autoZoom, all 6 background styles, soundtrack amix,
 * and burned-in ASS subtitles (speech + detected sound events).
 */
export function buildClipRenderFilterGraph(
  options: ClipRenderFilterOptions
): ClipRenderFilterGraph {
  const {
    keepSegments,
    clipDurationSec = 0,
    includeVideo = true,
    hasAudio = true,
    hasSoundtrack = false,
    soundtrackVolume = 0.22,
  } = options;

  const needsConcat =
    Boolean(keepSegments && keepSegments.length > 0) &&
    (keepSegments!.length > 1 ||
      keepSegments![0].relStart > 0.05 ||
      (clipDurationSec > 0 && keepSegments![0].relEnd < clipDurationSec - 0.05));

  const effectiveOutDur =
    keepSegments && keepSegments.length > 0
      ? Math.max(
          0.5,
          keepSegments.reduce((acc, seg) => acc + Math.max(0, seg.relEnd - seg.relStart), 0)
        )
      : Math.max(0.5, clipDurationSec || 12);

  const clampedMusicVol = Math.max(0.02, Math.min(0.8, soundtrackVolume));
  const parts: string[] = [];
  let baseAudioLabel: string | null = null;

  if (!includeVideo) {
    if (!needsConcat) {
      if (hasAudio) {
        baseAudioLabel = hasSoundtrack ? '[0:a:0]' : '0:a:0?';
      }
    } else if (hasAudio) {
      const segs = keepSegments!;
      const concatInputs: string[] = [];
      segs.forEach((seg, idx) => {
        parts.push(
          `[0:a]atrim=start=${seg.relStart.toFixed(3)}:end=${seg.relEnd.toFixed(3)},asetpts=PTS-STARTPTS[as${idx}]`
        );
        concatInputs.push(`[as${idx}]`);
      });
      parts.push(`${concatInputs.join('')}concat=n=${segs.length}:v=0:a=1[aout]`);
      baseAudioLabel = '[aout]';
    }
  } else if (!needsConcat) {
    parts.push(buildReframeSegment('[0:v]', options));
    if (hasAudio) {
      baseAudioLabel = hasSoundtrack ? '[0:a:0]' : '0:a:0?';
    }
  } else {
    const segs = keepSegments!;
    const concatInputs: string[] = [];

    segs.forEach((seg, idx) => {
      parts.push(
        `[0:v]trim=start=${seg.relStart.toFixed(3)}:end=${seg.relEnd.toFixed(3)},setpts=PTS-STARTPTS[vs${idx}]`
      );
      if (hasAudio) {
        parts.push(
          `[0:a]atrim=start=${seg.relStart.toFixed(3)}:end=${seg.relEnd.toFixed(3)},asetpts=PTS-STARTPTS[as${idx}]`
        );
        concatInputs.push(`[vs${idx}][as${idx}]`);
      } else {
        concatInputs.push(`[vs${idx}]`);
      }
    });

    if (hasAudio) {
      parts.push(`${concatInputs.join('')}concat=n=${segs.length}:v=1:a=1[vcut][aout]`);
      baseAudioLabel = '[aout]';
    } else {
      parts.push(`${concatInputs.join('')}concat=n=${segs.length}:v=1:a=0[vcut]`);
    }

    parts.push(buildReframeSegment('[vcut]', options));
  }

  let finalAudioMap: string | null = baseAudioLabel;

  if (hasSoundtrack) {
    parts.push(
      `[1:a]aloop=loop=-1:size=2000000000,atrim=0:${effectiveOutDur.toFixed(3)},asetpts=PTS-STARTPTS,volume=${clampedMusicVol.toFixed(3)}[bgm]`
    );
    if (hasAudio && baseAudioLabel) {
      parts.push(
        `${baseAudioLabel}[bgm]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[amixout]`
      );
      finalAudioMap = '[amixout]';
    } else {
      finalAudioMap = '[bgm]';
    }
  }

  return {
    filterComplex: parts.join(';'),
    videoMap: includeVideo ? '[vout]' : null,
    audioMap: finalAudioMap,
  };
}

// --- Zero-dependency PKZIP Archive Builder (Deflate via Node zlib) ---

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  name: string;
  data: Buffer;
  /** Use method 0 (STORE) for already-compressed files like .mp4 */
  storeOnly?: boolean;
}

export function buildZipArchive(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const cleanName = entry.name.replace(/^\/+/, '');
    const nameBuf = Buffer.from(cleanName, 'utf8');
    const crc = computeCrc32(entry.data);
    const uncompressedSize = entry.data.length;

    const useStore = Boolean(entry.storeOnly) || uncompressedSize < 64;
    const payload = useStore ? entry.data : zlib.deflateRawSync(entry.data, { level: 6 });
    const compressionMethod = useStore ? 0 : 8;
    const compressedSize = payload.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
    localHeader.writeUInt16LE(20, 4); // Version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(0, 10); // Mod time
    localHeader.writeUInt16LE(0x5421, 12); // Mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // Extra field length

    localParts.push(localHeader, nameBuf, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
    centralHeader.writeUInt16LE(20, 4); // Version made by
    centralHeader.writeUInt16LE(20, 6); // Version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt16LE(0, 12); // Mod time
    centralHeader.writeUInt16LE(0x5421, 14); // Mod date
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // Extra len
    centralHeader.writeUInt16LE(0, 32); // Comment len
    centralHeader.writeUInt16LE(0, 34); // Disk number start
    centralHeader.writeUInt16LE(0, 36); // Internal attrs
    centralHeader.writeUInt32LE(0, 38); // External attrs
    centralHeader.writeUInt32LE(offset, 42); // Relative offset of local header

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralDirBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // End of central directory signature
  eocd.writeUInt16LE(0, 4); // Disk number
  eocd.writeUInt16LE(0, 6); // Central dir start disk
  eocd.writeUInt16LE(entries.length, 8); // Entries on disk
  eocd.writeUInt16LE(entries.length, 10); // Total entries
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // Comment length

  return Buffer.concat([...localParts, centralDirBuf, eocd]);
}
