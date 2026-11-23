import { CAPTION_STYLES } from '../data/demoProject';
import type {
  AspectRatio,
  CaptionAnimationStyle,
  CaptionStyle,
  CaptionStylePreset,
  Clip,
} from '../types/clipgenius';

export interface ResolvedCaptionStyle extends CaptionStyle {
  fontWeight: 500 | 600 | 700 | 800;
  strokeWidthPx: number;
  backgroundColor: string;
  backgroundOpacity: number;
  textAlign: 'left' | 'center' | 'right';
  maxWordsPerLine: number;
  animation: CaptionAnimationStyle;
}

const PRESET_DEFAULTS: Record<
  CaptionStylePreset,
  {
    fontWeight: 500 | 600 | 700 | 800;
    strokeWidthPx: number;
    backgroundColor: string;
    backgroundOpacity: number;
    textAlign: 'left' | 'center' | 'right';
    maxWordsPerLine: number;
    animation: CaptionAnimationStyle;
  }
> = {
  modern_animated: {
    fontWeight: 700,
    strokeWidthPx: 2,
    backgroundColor: '#0B0D11',
    backgroundOpacity: 0.58,
    textAlign: 'center',
    maxWordsPerLine: 5,
    animation: 'pop',
  },
  bold_viral: {
    fontWeight: 800,
    strokeWidthPx: 3,
    backgroundColor: '#000000',
    backgroundOpacity: 0,
    textAlign: 'center',
    maxWordsPerLine: 4,
    animation: 'pop',
  },
  minimal: {
    fontWeight: 500,
    strokeWidthPx: 1,
    backgroundColor: '#0B0D11',
    backgroundOpacity: 0.72,
    textAlign: 'center',
    maxWordsPerLine: 6,
    animation: 'fade',
  },
  word_highlight: {
    fontWeight: 700,
    strokeWidthPx: 2,
    backgroundColor: '#09090B',
    backgroundOpacity: 0.65,
    textAlign: 'center',
    maxWordsPerLine: 5,
    animation: 'pop',
  },
  karaoke: {
    fontWeight: 800,
    strokeWidthPx: 2.5,
    backgroundColor: '#09090B',
    backgroundOpacity: 0.45,
    textAlign: 'center',
    maxWordsPerLine: 4,
    animation: 'karaoke',
  },
};

function clampNumber(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, val));
}

/**
 * Single source of truth for resolving a clip's active caption style across
 * the Captions tab, Live Preview overlay, and FFmpeg ASS burned-in export.
 */
export function resolveCaptionStyle(
  clip?: Pick<Clip, 'captionStyle' | 'captionOverrides'> | null
): ResolvedCaptionStyle {
  const base =
    CAPTION_STYLES.find((s) => s.preset === clip?.captionStyle) ?? CAPTION_STYLES[0];
  const presetDef = PRESET_DEFAULTS[base.preset] ?? PRESET_DEFAULTS.modern_animated;
  const ov = clip?.captionOverrides ?? {};

  const validWeights = [500, 600, 700, 800] as const;
  const rawWeight = ov.fontWeight ?? base.fontWeight ?? presetDef.fontWeight;
  const fontWeight = validWeights.includes(rawWeight as (typeof validWeights)[number])
    ? (rawWeight as 500 | 600 | 700 | 800)
    : presetDef.fontWeight;

  const rawAlign = ov.textAlign ?? base.textAlign ?? presetDef.textAlign;
  const textAlign =
    rawAlign === 'left' || rawAlign === 'right' || rawAlign === 'center'
      ? rawAlign
      : 'center';

  const rawAnim = ov.animation ?? presetDef.animation;
  const animation: CaptionAnimationStyle =
    rawAnim === 'none' || rawAnim === 'pop' || rawAnim === 'karaoke' || rawAnim === 'fade'
      ? rawAnim
      : presetDef.animation;

  return {
    ...base,
    fontFamily: ov.fontFamily ?? base.fontFamily,
    fontSizePx: Math.round(clampNumber(ov.fontSizePx ?? base.fontSizePx, 14, 34)),
    fontWeight,
    primaryColor: ov.primaryColor ?? base.primaryColor,
    highlightColor: ov.highlightColor ?? base.highlightColor,
    strokeColor: ov.strokeColor ?? base.strokeColor,
    strokeWidthPx: Number(
      clampNumber(ov.strokeWidthPx ?? base.strokeWidthPx ?? presetDef.strokeWidthPx, 0, 4).toFixed(1)
    ),
    backgroundColor: ov.backgroundColor ?? base.backgroundColor ?? presetDef.backgroundColor,
    backgroundOpacity: Number(
      clampNumber(
        ov.backgroundOpacity ?? base.backgroundOpacity ?? presetDef.backgroundOpacity,
        0,
        0.95
      ).toFixed(2)
    ),
    textAlign,
    maxWordsPerLine: Math.round(
      clampNumber(ov.maxWordsPerLine ?? base.maxWordsPerLine ?? presetDef.maxWordsPerLine, 3, 7)
    ),
    position: ov.position ?? base.position,
    uppercase: ov.uppercase ?? base.uppercase,
    animation,
  };
}

export function hexToRgba(hex: string, alpha: number): string {
  const safeAlpha = clampNumber(alpha, 0, 1);
  if (safeAlpha <= 0.005 || hex === 'transparent') {
    return 'transparent';
  }
  const cleaned = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return `rgba(11, 13, 17, ${safeAlpha.toFixed(2)})`;
  }
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${safeAlpha.toFixed(2)})`;
}

/**
 * Generates a crisp multi-directional CSS text-shadow matching libass Outline + Shadow
 * so Stroke color & width updates are immediately visible in Live Preview.
 */
export function buildCaptionTextOutlineShadow(
  strokeColor: string,
  strokeWidthPx: number
): string {
  const w = clampNumber(strokeWidthPx, 0, 4);
  const color = strokeColor?.trim() || '#000000';
  if (w <= 0.1) {
    return '0 2px 6px rgba(0, 0, 0, 0.55)';
  }
  const s = Number(Math.max(0.75, w * 0.72).toFixed(2));
  const diag = Number((s * 0.75).toFixed(2));
  return [
    `${-s}px 0 0 ${color}`,
    `${s}px 0 0 ${color}`,
    `0 ${-s}px 0 ${color}`,
    `0 ${s}px 0 ${color}`,
    `${-diag}px ${-diag}px 0 ${color}`,
    `${diag}px ${-diag}px 0 ${color}`,
    `${-diag}px ${diag}px 0 ${color}`,
    `${diag}px ${diag}px 0 ${color}`,
    `0 ${Number((s + 1.5).toFixed(1))}px ${Number((s * 2.4 + 2).toFixed(1))}px rgba(0, 0, 0, 0.72)`,
  ].join(', ');
}

export interface SafeCaptionLayoutMetrics {
  previewFontSizePx: number;
  horizontalSafePct: number;
  verticalSafePct: number;
  maxLines: number;
  effectiveWordsPerCue: number;
}

/**
 * Computes consistent safe-area margins and proportional font sizes for Live Preview
 * so captions never overflow, clip, or collide with crops in 9:16, 16:9, 1:1, or 4:5.
 */
export function getSafeCaptionLayoutMetrics(
  aspectRatio: AspectRatio,
  style: ResolvedCaptionStyle
): SafeCaptionLayoutMetrics {
  // Stage box widths in EditorPreviewView:
  // 9:16 = 270x480, 4:5 = 310x388, 1:1 = 360x360, 16:9 = 540x304
  // Export ASS uses scaledFontSize = fontSizePx * 1.9 * (min(w, h) / 720) -> relative to min(w,h):
  //   At 720p (minDim=720), ASS fontSize / minDim = (fontSizePx * 1.9) / 720 = fontSizePx * 0.00264
  //   For preview minDim:
  //     9:16 minDim = 270 -> 270 * 0.00264 = 0.713x (clamped cleanly so 32px still fits inside 270px!)
  //     16:9 minDim = 304 -> 304 * 0.00264 = 0.802x
  //     1:1  minDim = 360 -> 360 * 0.00264 = 0.950x
  //     4:5  minDim = 310 -> 310 * 0.00264 = 0.818x
  let previewScale = 0.68;
  let maxPreviewPx = 22;
  let horizontalSafePct = 7;
  let verticalSafePct = 10;

  if (aspectRatio === '9:16') {
    previewScale = 0.64;
    maxPreviewPx = 21;
    horizontalSafePct = 7;
    verticalSafePct = style.position === 'top' ? 11 : 10;
  } else if (aspectRatio === '16:9') {
    previewScale = 0.76;
    maxPreviewPx = 24;
    horizontalSafePct = 8;
    verticalSafePct = style.position === 'top' ? 10 : 9;
  } else if (aspectRatio === '1:1') {
    previewScale = 0.74;
    maxPreviewPx = 23;
    horizontalSafePct = 8;
    verticalSafePct = 9;
  } else {
    // 4:5
    previewScale = 0.7;
    maxPreviewPx = 22;
    horizontalSafePct = 8;
    verticalSafePct = 9;
  }

  const previewFontSizePx = Math.round(
    clampNumber(style.fontSizePx * previewScale, 11, maxPreviewPx)
  );

  // In narrow portrait 9:16, cap words per cue smoothly so text wraps cleanly into <= 2 lines
  const effectiveWordsPerCue =
    aspectRatio === '9:16'
      ? Math.min(style.maxWordsPerLine, 5)
      : style.maxWordsPerLine;

  return {
    previewFontSizePx,
    horizontalSafePct,
    verticalSafePct,
    maxLines: 2,
    effectiveWordsPerCue,
  };
}

/**
 * Splits a cue's words into at most `maxLines` balanced lines so preview and ASS
 * wrap cleanly without single-word orphans or overflow.
 */
export function wrapCaptionWords(
  words: string[],
  maxWordsPerLine: number = 4,
  maxLines: number = 2
): string[][] {
  const clean = words.filter((w) => w.trim().length > 0);
  if (clean.length === 0) return [];
  const perLine = Math.max(2, Math.min(7, Math.round(maxWordsPerLine)));
  const totalChars = clean.join(' ').length;
  const singleLineCharBudget = Math.max(16, perLine * 5);

  if (maxLines <= 1 || clean.length <= 1 || (clean.length <= perLine && totalChars <= singleLineCharBudget)) {
    return [clean];
  }

  // Pick the split point that minimizes the longer line's character length while keeping each line <= perLine when possible
  let bestSplit = Math.min(perLine, Math.ceil(clean.length / 2));
  let bestScore = Number.POSITIVE_INFINITY;
  const minSplit = Math.max(1, clean.length - perLine);
  const maxSplit = Math.min(clean.length - 1, perLine);

  for (let i = minSplit; i <= maxSplit; i += 1) {
    const leftLen = clean.slice(0, i).join(' ').length;
    const rightLen = clean.slice(i).join(' ').length;
    const score = Math.max(leftLen, rightLen) + Math.abs(leftLen - rightLen) * 0.25;
    if (score < bestScore) {
      bestScore = score;
      bestSplit = i;
    }
  }

  return [clean.slice(0, bestSplit), clean.slice(bestSplit)];
}

/**
 * Maps browser caption font families to real installed Linux fonts for libass/FFmpeg
 * so exported burned-in videos reflect the selected typography accurately.
 */
export function mapFontFamilyToAss(fontFamily: string): string {
  const normalized = fontFamily.toLowerCase().trim();
  if (normalized.includes('jetbrains') || normalized.includes('mono')) {
    return 'JetBrains Mono';
  }
  if (normalized.includes('plus jakarta')) {
    return 'Liberation Sans';
  }
  if (normalized.includes('dm sans')) {
    return 'DejaVu Sans';
  }
  // Outfit (default geometric sans) -> Noto Sans (installed on container)
  return 'Noto Sans';
}

/**
 * Returns the ASS Numpad alignment code (1-9) matching both vertical position and horizontal alignment.
 * Bottom: 1=left, 2=center, 3=right
 * Middle: 4=left, 5=center, 6=right
 * Top:    7=left, 8=center, 9=right
 */
export function getAssAlignment(
  position: 'bottom' | 'center' | 'top',
  textAlign: 'left' | 'center' | 'right'
): number {
  const rowBase = position === 'top' ? 7 : position === 'center' ? 4 : 1;
  const colOffset = textAlign === 'left' ? 0 : textAlign === 'right' ? 2 : 1;
  return rowBase + colOffset;
}
