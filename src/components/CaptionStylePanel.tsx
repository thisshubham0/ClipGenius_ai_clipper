import { useEffect, useState } from 'react';
import { Check, Globe, Layers, Loader2, Mic, Music2, Plus, RotateCcw } from 'lucide-react';
import { CAPTION_STYLES } from '../data/demoProject';
import { apiFetch } from '../lib/apiClient';
import {
  CAPTION_LANGUAGES,
  FEATURED_CAPTION_LANGUAGES,
  getCaptionLanguageOption,
  SECONDARY_CAPTION_LANGUAGES,
} from '../lib/captionLanguages';
import {
  BACKGROUND_STYLE_OPTIONS,
  resolveClipBackgroundStyle,
  SOUNDTRACK_OPTIONS,
} from '../lib/clipVersions';
import type { ResolvedCaptionStyle } from '../lib/captionStyles';
import type {
  CaptionCustomizations,
  CaptionStylePreset,
  Clip,
  Transcript,
  TranscriptWord,
  TranslatedSubtitleCue,
} from '../types/clipgenius';

const FONT_OPTIONS = [
  { label: 'Outfit (Display)', value: 'Outfit' },
  { label: 'Plus Jakarta Sans', value: 'Plus Jakarta Sans' },
  { label: 'DM Sans', value: 'DM Sans' },
  { label: 'JetBrains Mono', value: 'JetBrains Mono' },
];

export const SUBTITLE_LANGUAGES = CAPTION_LANGUAGES;

interface CaptionStylePanelProps {
  clip: Clip;
  resolvedStyle: ResolvedCaptionStyle;
  activeCrop: { xPct: number; zoom: number };
  silenceCountInClip: number;
  savedSec: number;
  onPatchClip: (patch: Partial<Clip>) => void;
  onTranscriptUpdated?: (transcript: Transcript) => void;
  onAddCropKeyframe: () => void;
  onResetCropKeyframes: () => void;
}

export function CaptionStylePanel({
  clip,
  resolvedStyle,
  activeCrop,
  silenceCountInClip,
  savedSec,
  onPatchClip,
  onTranscriptUpdated,
  onAddCropKeyframe,
  onResetCropKeyframes,
}: CaptionStylePanelProps) {
  const activeClipLang = clip.subtitleLanguage || 'original';
  const [secondaryLang, setSecondaryLang] = useState<string>(
    SECONDARY_CAPTION_LANGUAGES.some((l) => l.code === activeClipLang)
      ? activeClipLang
      : SECONDARY_CAPTION_LANGUAGES[0].code
  );
  const [translatingLang, setTranslatingLang] = useState<string | null>(null);
  const [detectingVoice, setDetectingVoice] = useState(false);
  const [translateFeedback, setTranslateFeedback] = useState<string | null>(null);

  useEffect(() => {
    setTranslateFeedback(null);
  }, [clip.id]);

  useEffect(() => {
    if (SECONDARY_CAPTION_LANGUAGES.some((l) => l.code === activeClipLang)) {
      setSecondaryLang(activeClipLang);
    }
  }, [clip.id, activeClipLang]);

  function updateOverrides(patch: Partial<CaptionCustomizations>) {
    onPatchClip({
      captionOverrides: {
        ...(clip.captionOverrides ?? {}),
        ...patch,
      },
    });
  }

  async function applyCaptionLanguage(targetLangCode: string, forceRetranslate = false) {
    setTranslateFeedback(null);
    const langOpt = getCaptionLanguageOption(targetLangCode);

    if (langOpt.code === 'original') {
      onPatchClip({ subtitleLanguage: 'original' });
      setTranslateFeedback('Switched captions back to original audio language.');
      return;
    }

    // If words[] are already natively detected in this language, switch immediately without re-translating
    if (!forceRetranslate && clip.wordsLanguage === langOpt.code && clip.words.length > 0) {
      onPatchClip({ subtitleLanguage: langOpt.code });
      setTranslateFeedback(`Active caption language: ${langOpt.label} (word-synced).`);
      return;
    }

    // Use cached translation immediately unless explicitly re-translating
    if (
      !forceRetranslate &&
      clip.translatedCues?.[langOpt.code] &&
      clip.translatedCues[langOpt.code].length > 0
    ) {
      onPatchClip({ subtitleLanguage: langOpt.code });
      setTranslateFeedback(`Active caption language: ${langOpt.label} (ready).`);
      return;
    }

    setTranslatingLang(langOpt.code);
    try {
      const res = await apiFetch(`/api/clips/${encodeURIComponent(clip.id)}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetLanguage: langOpt.code,
          targetLanguageLabel: langOpt.label,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        requiresConfiguration?: boolean;
        message?: string;
        error?: string;
        cues?: TranslatedSubtitleCue[];
      };

      if (data.requiresConfiguration) {
        setTranslateFeedback(
          data.message ?? 'Requires GEMINI_API_KEY in server Secrets to translate subtitles.'
        );
        return;
      }

      if (!res.ok || !data.cues) {
        setTranslateFeedback(data.error ?? 'Caption translation failed.');
        return;
      }

      onPatchClip({
        subtitleLanguage: langOpt.code,
        translatedCues: {
          ...(clip.translatedCues ?? {}),
          [langOpt.code]: data.cues,
        },
      });
      setTranslateFeedback(
        `${langOpt.shortLabel} captions ready (${data.cues.length} cues). Live preview, burned-in video & SRT/VTT updated.`
      );
    } catch {
      setTranslateFeedback('Unable to reach caption translation endpoint.');
    } finally {
      setTranslatingLang(null);
    }
  }

  async function handleDetectVoice(targetLang: 'en' | 'hinglish' = 'en') {
    setTranslateFeedback(null);
    setDetectingVoice(true);
    try {
      const res = await apiFetch(`/api/clips/${encodeURIComponent(clip.id)}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetLanguage: targetLang }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        requiresConfiguration?: boolean;
        message?: string;
        error?: string;
        language?: string;
        wordsLanguage?: string;
        words?: TranscriptWord[];
        cues?: TranslatedSubtitleCue[];
        captionText?: string;
        speechWordCount?: number;
        soundEventCount?: number;
        speakers?: string[];
        transcript?: Transcript;
      };

      if (data.requiresConfiguration) {
        setTranslateFeedback(
          data.message ?? 'Requires GEMINI_API_KEY in server Secrets to detect voices.'
        );
        return;
      }

      if (!res.ok || !data.words || !data.cues) {
        setTranslateFeedback(data.error ?? 'Unable to detect voice from this clip audio.');
        return;
      }

      const detectedLang = data.wordsLanguage || data.language || targetLang;
      onPatchClip({
        words: data.words,
        captionText: data.captionText ?? '',
        captionTextEdited: false,
        subtitleLanguage: detectedLang,
        wordsLanguage: detectedLang,
        speaker: data.speakers?.[0] || clip.speaker,
        translatedCues: {},
      });
      if (data.transcript && onTranscriptUpdated) {
        onTranscriptUpdated(data.transcript);
      }

      const spoken = data.speechWordCount ?? 0;
      const sounds = data.soundEventCount ?? 0;
      if (spoken > 0) {
        setTranslateFeedback(
          `Detected ${spoken} ${targetLang === 'hinglish' ? 'Hinglish' : 'English'} spoken word(s) across ${data.cues.length} synced subtitle cue(s).`
        );
      } else if (sounds > 0) {
        setTranslateFeedback(
          `No spoken words found in this clip — detected ${sounds} audio sound cue(s).`
        );
      } else {
        setTranslateFeedback('Scanned clip audio — no audible voice detected in this slice.');
      }
    } catch {
      setTranslateFeedback('Unable to reach clip voice detection endpoint.');
    } finally {
      setDetectingVoice(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Caption Presets */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium text-slate-300">Caption preset</p>
          {clip.captionOverrides && Object.keys(clip.captionOverrides).length > 0 && (
            <button
              type="button"
              onClick={() => onPatchClip({ captionOverrides: {} })}
              className="inline-flex items-center gap-1 text-[11px] text-amber-400 hover:text-amber-300 whitespace-nowrap"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              Reset custom style
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {CAPTION_STYLES.map((style) => (
            <button
              key={style.id}
              type="button"
              onClick={() =>
                onPatchClip({
                  captionStyle: style.preset as CaptionStylePreset,
                  captionOverrides: {},
                })
              }
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                clip.captionStyle === style.preset
                  ? 'bg-amber-500 text-slate-950 font-semibold'
                  : 'border border-white/10 bg-[#0B0D11] text-slate-300 hover:text-white'
              }`}
            >
              {style.label}
            </button>
          ))}
        </div>
      </div>

      {/* Caption Language (English, Hinglish & Multi-Language Subtitles) */}
      <div
        data-testid="caption-language-section"
        className="rounded-lg border border-white/10 bg-[#0B0D11] p-3.5 space-y-2.5"
      >
        <div className="flex items-center justify-between gap-2">
          <p className="inline-flex items-center gap-1.5 text-xs font-medium text-white">
            <Globe className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
            Caption Language
          </p>
          <span
            data-testid="active-caption-language-label"
            className="font-mono text-[10px] text-amber-400"
          >
            {getCaptionLanguageOption(activeClipLang).shortLabel}
          </span>
        </div>

        <div
          role="group"
          aria-label="Primary caption language selector"
          className="grid grid-cols-3 gap-1.5"
        >
          {FEATURED_CAPTION_LANGUAGES.map((lang) => {
            const isActive = activeClipLang === lang.code;
            const isBusy = translatingLang === lang.code;
            const isCached = Boolean(
              lang.code !== 'original' &&
                (clip.wordsLanguage === lang.code || clip.translatedCues?.[lang.code]?.length)
            );
            return (
              <button
                key={lang.code}
                type="button"
                data-testid={`caption-lang-${lang.code}`}
                disabled={translatingLang !== null}
                onClick={() => void applyCaptionLanguage(lang.code)}
                className={`rounded-md border px-2.5 py-2 text-left transition-colors disabled:opacity-60 ${
                  isActive
                    ? 'border-amber-500 bg-amber-500/15 text-white'
                    : 'border-white/10 bg-[#131720] text-slate-300 hover:border-white/25 hover:text-white'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="text-xs font-semibold truncate">{lang.shortLabel}</span>
                  {isBusy ? (
                    <Loader2 className="h-3 w-3 animate-spin text-amber-400 shrink-0" aria-hidden="true" />
                  ) : isActive || isCached ? (
                    <Check
                      className={`h-3 w-3 shrink-0 ${isActive ? 'text-amber-400' : 'text-emerald-400'}`}
                      aria-hidden="true"
                    />
                  ) : null}
                </div>
                <p className="text-[10px] text-slate-400 truncate mt-0.5">
                  {lang.code === 'original'
                    ? 'Auto audio'
                    : lang.code === 'en'
                      ? 'Natural English'
                      : 'Roman Hindi+Eng'}
                </p>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 pt-1">
          <label htmlFor="subtitle-language-select" className="sr-only">
            More subtitle languages
          </label>
          <select
            id="subtitle-language-select"
            value={secondaryLang}
            onChange={(e) => setSecondaryLang(e.target.value)}
            className="flex-1 rounded-md border border-white/15 bg-[#131720] px-2.5 py-1.5 text-xs text-white focus:border-amber-500 focus:outline-none"
          >
            {SECONDARY_CAPTION_LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.label}
                {clip.translatedCues?.[lang.code] ? ' (Ready)' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={translatingLang !== null}
            onClick={() => void applyCaptionLanguage(secondaryLang)}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-white/10 disabled:opacity-60 whitespace-nowrap"
          >
            {translatingLang === secondaryLang ? (
              <Loader2 className="h-3 w-3 animate-spin text-amber-400" aria-hidden="true" />
            ) : (
              <Globe className="h-3 w-3 text-amber-400" aria-hidden="true" />
            )}
            {translatingLang === secondaryLang ? 'Translating...' : 'Apply'}
          </button>
        </div>

        <div className="pt-1 border-t border-white/10 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] text-slate-400">
            Voice missing or quiet in this clip?
          </span>
          <button
            type="button"
            data-testid="detect-voice-english-btn"
            disabled={detectingVoice || translatingLang !== null}
            onClick={() => void handleDetectVoice('en')}
            className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/15 px-2.5 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/25 disabled:opacity-60 whitespace-nowrap"
          >
            {detectingVoice ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" aria-hidden="true" />
            ) : (
              <Mic className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
            )}
            {detectingVoice ? 'Detecting English voice...' : 'Detect Voice (English)'}
          </button>
        </div>

        {translateFeedback && (
          <p
            role="status"
            data-testid="caption-translate-feedback"
            className="text-[11px] text-amber-200 bg-amber-500/10 border border-amber-500/25 rounded-md px-2.5 py-1.5"
          >
            {translateFeedback}
          </p>
        )}
      </div>

      {/* Custom Typography, Colors, Position & Animation */}
      <div className="rounded-lg border border-white/10 bg-[#0B0D11] p-3.5 space-y-3.5">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="caption-font-select" className="block text-[11px] text-slate-400 mb-1">
              Font family
            </label>
            <select
              id="caption-font-select"
              value={resolvedStyle.fontFamily}
              onChange={(e) => updateOverrides({ fontFamily: e.target.value })}
              className="w-full rounded border border-white/15 bg-[#131720] px-2.5 py-1.5 text-xs text-white focus:border-amber-500 focus:outline-none"
            >
              {FONT_OPTIONS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex justify-between text-[11px] text-slate-400 mb-1 tabular-nums">
              <label htmlFor="caption-size-slider">Font size</label>
              <span className="font-mono text-slate-200">{resolvedStyle.fontSizePx}px</span>
            </div>
            <input
              id="caption-size-slider"
              type="range"
              min={14}
              max={32}
              value={resolvedStyle.fontSizePx}
              onChange={(e) => updateOverrides({ fontSizePx: Number(e.target.value) })}
              className="w-full accent-amber-500 mt-1"
            />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2.5">
          <label className="text-[11px] text-slate-400 space-y-1 block">
            <span>Text</span>
            <div className="flex items-center gap-1.5 rounded border border-white/15 bg-[#131720] px-2 py-1">
              <input
                type="color"
                aria-label="Caption primary color"
                value={resolvedStyle.primaryColor}
                onChange={(e) => updateOverrides({ primaryColor: e.target.value })}
                className="h-4 w-5 cursor-pointer bg-transparent border-0 p-0"
              />
              <span className="font-mono text-[10px] text-slate-300 uppercase">
                {resolvedStyle.primaryColor}
              </span>
            </div>
          </label>

          <label className="text-[11px] text-slate-400 space-y-1 block">
            <span>Highlight</span>
            <div className="flex items-center gap-1.5 rounded border border-white/15 bg-[#131720] px-2 py-1">
              <input
                type="color"
                aria-label="Caption highlight color"
                value={resolvedStyle.highlightColor}
                onChange={(e) => updateOverrides({ highlightColor: e.target.value })}
                className="h-4 w-5 cursor-pointer bg-transparent border-0 p-0"
              />
              <span className="font-mono text-[10px] text-slate-300 uppercase">
                {resolvedStyle.highlightColor}
              </span>
            </div>
          </label>

          <label className="text-[11px] text-slate-400 space-y-1 block">
            <span>Stroke</span>
            <div className="flex items-center gap-1.5 rounded border border-white/15 bg-[#131720] px-2 py-1">
              <input
                type="color"
                aria-label="Caption stroke color"
                value={resolvedStyle.strokeColor}
                onChange={(e) => updateOverrides({ strokeColor: e.target.value })}
                className="h-4 w-5 cursor-pointer bg-transparent border-0 p-0"
              />
              <span className="font-mono text-[10px] text-slate-300 uppercase">
                {resolvedStyle.strokeColor}
              </span>
            </div>
          </label>
        </div>

        {/* Weight & Stroke Width */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className="block text-[11px] text-slate-400 mb-1">Font weight</span>
            <div
              role="group"
              aria-label="Caption font weight"
              className="grid grid-cols-4 rounded border border-white/10 bg-[#131720] p-0.5 text-[10px]"
            >
              {(
                [
                  [500, 'Med'],
                  [600, 'Semi'],
                  [700, 'Bold'],
                  [800, 'Black'],
                ] as const
              ).map(([weightVal, label]) => (
                <button
                  key={weightVal}
                  type="button"
                  onClick={() => updateOverrides({ fontWeight: weightVal })}
                  className={`rounded py-1 transition-colors ${
                    resolvedStyle.fontWeight === weightVal
                      ? 'bg-amber-500 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex justify-between text-[11px] text-slate-400 mb-1 tabular-nums">
              <label htmlFor="caption-stroke-width-slider">Outline</label>
              <span className="font-mono text-slate-200">{resolvedStyle.strokeWidthPx}px</span>
            </div>
            <input
              id="caption-stroke-width-slider"
              type="range"
              min={0}
              max={4}
              step={0.5}
              value={resolvedStyle.strokeWidthPx}
              onChange={(e) => updateOverrides({ strokeWidthPx: Number(e.target.value) })}
              className="w-full accent-amber-500 mt-1"
            />
          </div>
        </div>

        {/* Caption Background Box Color & Opacity */}
        <div className="grid grid-cols-2 gap-3">
          <label className="text-[11px] text-slate-400 space-y-1 block">
            <span>Caption box</span>
            <div className="flex items-center gap-1.5 rounded border border-white/15 bg-[#131720] px-2 py-1">
              <input
                type="color"
                aria-label="Caption background color"
                value={resolvedStyle.backgroundColor}
                onChange={(e) => updateOverrides({ backgroundColor: e.target.value })}
                className="h-4 w-5 cursor-pointer bg-transparent border-0 p-0"
              />
              <span className="font-mono text-[10px] text-slate-300 uppercase">
                {resolvedStyle.backgroundColor}
              </span>
            </div>
          </label>

          <div>
            <div className="flex justify-between text-[11px] text-slate-400 mb-1 tabular-nums">
              <label htmlFor="caption-bg-opacity-slider">Box opacity</label>
              <span className="font-mono text-slate-200">
                {Math.round(resolvedStyle.backgroundOpacity * 100)}%
              </span>
            </div>
            <input
              id="caption-bg-opacity-slider"
              type="range"
              min={0}
              max={95}
              step={5}
              value={Math.round(resolvedStyle.backgroundOpacity * 100)}
              onChange={(e) =>
                updateOverrides({
                  backgroundOpacity: Number((Number(e.target.value) / 100).toFixed(2)),
                })
              }
              className="w-full accent-amber-500 mt-1"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className="block text-[11px] text-slate-400 mb-1">Position</span>
            <div
              role="group"
              aria-label="Caption vertical position"
              className="grid grid-cols-3 rounded border border-white/10 bg-[#131720] p-0.5 text-[11px]"
            >
              {(['top', 'center', 'bottom'] as const).map((pos) => (
                <button
                  key={pos}
                  type="button"
                  onClick={() => updateOverrides({ position: pos })}
                  className={`rounded py-1 capitalize transition-colors ${
                    resolvedStyle.position === pos
                      ? 'bg-amber-500 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {pos}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="block text-[11px] text-slate-400 mb-1">Alignment</span>
            <div
              role="group"
              aria-label="Caption text alignment"
              className="grid grid-cols-3 rounded border border-white/10 bg-[#131720] p-0.5 text-[11px]"
            >
              {(['left', 'center', 'right'] as const).map((align) => (
                <button
                  key={align}
                  type="button"
                  onClick={() => updateOverrides({ textAlign: align })}
                  className={`rounded py-1 capitalize transition-colors ${
                    resolvedStyle.textAlign === align
                      ? 'bg-amber-500 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {align}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className="block text-[11px] text-slate-400 mb-1">Animation</span>
            <div
              role="group"
              aria-label="Caption animation style"
              className="grid grid-cols-4 rounded border border-white/10 bg-[#131720] p-0.5 text-[10px]"
            >
              {(['pop', 'karaoke', 'fade', 'none'] as const).map((anim) => (
                <button
                  key={anim}
                  type="button"
                  onClick={() => updateOverrides({ animation: anim })}
                  className={`rounded py-1 capitalize transition-colors ${
                    resolvedStyle.animation === anim
                      ? 'bg-amber-500 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {anim}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex justify-between text-[11px] text-slate-400 mb-1 tabular-nums">
              <label htmlFor="caption-words-per-line-slider">Words / line</label>
              <span className="font-mono text-slate-200">{resolvedStyle.maxWordsPerLine}</span>
            </div>
            <input
              id="caption-words-per-line-slider"
              type="range"
              min={3}
              max={7}
              step={1}
              value={resolvedStyle.maxWordsPerLine}
              onChange={(e) => updateOverrides({ maxWordsPerLine: Number(e.target.value) })}
              className="w-full accent-amber-500 mt-1"
            />
          </div>
        </div>

        <label className="flex items-center justify-between text-xs text-slate-300 cursor-pointer pt-1">
          <span>All-caps caption text</span>
          <input
            type="checkbox"
            checked={resolvedStyle.uppercase}
            onChange={(e) => updateOverrides({ uppercase: e.target.checked })}
            className="h-4 w-4 rounded border-white/20 bg-[#131720] accent-amber-500"
          />
        </label>
      </div>

      {/* Background Style Selector (persists into active edit version & FFmpeg render) */}
      <div className="border-t border-white/10 pt-4 space-y-2.5">
        <div className="flex items-center justify-between">
          <p className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-300">
            <Layers className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
            Background Style
          </p>
          <span className="text-[11px] text-slate-400">
            {
              BACKGROUND_STYLE_OPTIONS.find(
                (opt) => opt.id === resolveClipBackgroundStyle(clip)
              )?.label
            }
          </span>
        </div>
        <div
          role="group"
          aria-label="Background style selector"
          className="grid grid-cols-2 sm:grid-cols-3 gap-2"
        >
          {BACKGROUND_STYLE_OPTIONS.map((bg) => {
            const selected = resolveClipBackgroundStyle(clip) === bg.id;
            return (
              <button
                key={bg.id}
                type="button"
                data-testid={`bg-style-${bg.id}`}
                onClick={() =>
                  onPatchClip({
                    backgroundStyle: bg.id,
                    backgroundBlurFill: bg.id === 'blur_fill',
                  })
                }
                className={`rounded-lg border p-2 text-left transition-colors ${
                  selected
                    ? 'border-amber-500 bg-amber-500/10'
                    : 'border-white/10 bg-[#0B0D11] hover:border-white/25'
                }`}
              >
                <div
                  aria-hidden="true"
                  style={{
                    background: bg.swatchCss,
                    border: bg.frameBorderCss ?? '1px solid rgba(255,255,255,0.1)',
                  }}
                  className="h-7 w-full rounded mb-1.5 flex items-center justify-center"
                >
                  {bg.isFramed && (
                    <span className="h-3.5 w-6 rounded-[2px] bg-white/25 border border-white/30" />
                  )}
                </div>
                <p className="text-[11px] font-medium text-white truncate">{bg.shortLabel}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Soundtrack & Audio Mix Selector */}
      <div className="border-t border-white/10 pt-4 space-y-2.5">
        <div className="flex items-center justify-between">
          <p className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-300">
            <Music2 className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
            Soundtrack &amp; Music Bed
          </p>
          <span className="text-[11px] font-mono text-slate-400 tabular-nums">
            {(clip.soundtrackId ?? 'none') === 'none'
              ? 'Native Audio'
              : `${Math.round((clip.soundtrackVolume ?? 0.22) * 100)}% mix`}
          </span>
        </div>

        <div
          role="group"
          aria-label="Soundtrack selector"
          className="grid grid-cols-1 sm:grid-cols-2 gap-1.5"
        >
          {SOUNDTRACK_OPTIONS.map((track) => {
            const activeTrackId = clip.soundtrackId ?? 'none';
            const selected = activeTrackId === track.id;
            return (
              <button
                key={track.id}
                type="button"
                data-testid={`soundtrack-${track.id}`}
                onClick={() =>
                  onPatchClip({
                    soundtrackId: track.id,
                    soundtrackVolume:
                      track.id === 'none'
                        ? 0
                        : clip.soundtrackVolume && clip.soundtrackVolume > 0
                        ? clip.soundtrackVolume
                        : 0.22,
                  })
                }
                className={`rounded-lg border px-2.5 py-2 text-left transition-colors ${
                  selected
                    ? 'border-amber-500 bg-amber-500/10 text-white'
                    : 'border-white/10 bg-[#0B0D11] text-slate-300 hover:border-white/25 hover:text-white'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium truncate">{track.shortLabel}</span>
                  {track.bpm > 0 && (
                    <span className="font-mono text-[10px] text-slate-400 shrink-0">
                      {track.bpm} BPM
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-slate-400 truncate mt-0.5">{track.mood}</p>
              </button>
            );
          })}
        </div>

        {(clip.soundtrackId ?? 'none') !== 'none' && (
          <div className="rounded-lg border border-white/10 bg-[#0B0D11] px-3 py-2.5">
            <div className="flex justify-between text-[11px] text-slate-400 mb-1 tabular-nums">
              <label htmlFor="soundtrack-volume-slider">Background soundtrack volume</label>
              <span className="font-mono text-slate-200">
                {Math.round((clip.soundtrackVolume ?? 0.22) * 100)}%
              </span>
            </div>
            <input
              id="soundtrack-volume-slider"
              type="range"
              min={5}
              max={60}
              value={Math.round((clip.soundtrackVolume ?? 0.22) * 100)}
              onChange={(e) =>
                onPatchClip({
                  soundtrackVolume: Number((Number(e.target.value) / 100).toFixed(2)),
                })
              }
              className="w-full accent-amber-500"
            />
          </div>
        )}
      </div>

      {/* Optional Manual Caption Text Override (defaults to real audio speech & sound captions) */}
      <div className="border-t border-white/10 pt-4">
        <div className="flex items-center justify-between mb-1.5">
          <label
            htmlFor="caption-text-editor"
            className="block text-xs font-medium text-slate-300"
          >
            Manual caption text override (optional)
          </label>
          {clip.captionTextEdited && (
            <button
              type="button"
              onClick={() => onPatchClip({ captionText: '', captionTextEdited: false })}
              className="text-[11px] font-medium text-amber-400 hover:text-amber-300"
            >
              Use audio captions
            </button>
          )}
        </div>
        <textarea
          id="caption-text-editor"
          rows={2}
          value={clip.captionTextEdited ? clip.captionText : ''}
          placeholder={
            clip.words.length > 0
              ? 'Synced to detected speech & sound events from video audio. Type here only to override.'
              : 'Captions appear automatically once AI analyzes the video audio (speech + laughing, singing, humming, crying...).'
          }
          onChange={(e) => {
            const val = e.target.value;
            onPatchClip({
              captionText: val,
              captionTextEdited: val.trim().length > 0,
            });
          }}
          className="w-full rounded-lg border border-white/15 bg-[#0B0D11] p-2.5 text-xs text-white placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
        />
      </div>

      {/* Pacing Cleanup: Silence & Filler Removal */}
      <div className="border-t border-white/10 pt-4 space-y-2.5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-slate-300">Pacing &amp; Silence Cleanup</p>
          {savedSec > 0 && (
            <span className="text-[11px] font-mono text-emerald-400 tabular-nums">
              -{savedSec.toFixed(1)}s removed
            </span>
          )}
        </div>

        <label className="flex items-center justify-between text-xs text-slate-300 cursor-pointer">
          <span>
            Auto-skip silences ({silenceCountInClip} detected in clip)
          </span>
          <input
            type="checkbox"
            checked={Boolean(clip.removeSilences)}
            onChange={(e) => onPatchClip({ removeSilences: e.target.checked })}
            className="h-4 w-4 rounded border-white/20 bg-[#0B0D11] accent-amber-500"
          />
        </label>

        <label className="flex items-center justify-between text-xs text-slate-300 cursor-pointer">
          <span>Remove filler words (um, uh, erm)</span>
          <input
            type="checkbox"
            checked={Boolean(clip.removeFillers)}
            onChange={(e) => onPatchClip({ removeFillers: e.target.checked })}
            className="h-4 w-4 rounded border-white/20 bg-[#0B0D11] accent-amber-500"
          />
        </label>
      </div>

      {/* AI Voice Dubbing Notice */}
      <div className="border-t border-white/10 pt-4">
        <div className="flex items-center justify-between rounded-md border border-white/10 bg-[#0B0D11] px-3 py-2 text-xs">
          <span className="text-slate-400">AI Voice Dubbing (TTS provider-gated)</span>
          <button
            type="button"
            disabled
            className="rounded border border-white/10 px-2 py-0.5 text-[11px] text-slate-500 cursor-not-allowed whitespace-nowrap"
          >
            Coming soon
          </button>
        </div>
      </div>

      {/* Reframe & Smoothed Crop Controls */}
      <div className="border-t border-white/10 pt-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-slate-300">Reframe &amp; Active Speaker</p>
          <span className="font-mono text-[11px] text-slate-400 tabular-nums">
            X {activeCrop.xPct.toFixed(0)}% · {activeCrop.zoom.toFixed(2)}x
          </span>
        </div>

        <label className="flex items-center justify-between text-xs text-slate-300 cursor-pointer">
          <span>Active-speaker face tracking (smoothed)</span>
          <input
            type="checkbox"
            checked={clip.autoSpeakerTracking}
            onChange={(e) => onPatchClip({ autoSpeakerTracking: e.target.checked })}
            className="h-4 w-4 rounded border-white/20 bg-[#0B0D11] accent-amber-500"
          />
        </label>

        <label className="flex items-center justify-between text-xs text-slate-300 cursor-pointer">
          <span>Auto-zoom on speaker turns</span>
          <input
            type="checkbox"
            checked={Boolean(clip.autoZoom)}
            onChange={(e) => onPatchClip({ autoZoom: e.target.checked })}
            className="h-4 w-4 rounded border-white/20 bg-[#0B0D11] accent-amber-500"
          />
        </label>

        <label className="flex items-center justify-between text-xs text-slate-300 cursor-pointer">
          <span>Background blur fill</span>
          <input
            type="checkbox"
            checked={resolveClipBackgroundStyle(clip) === 'blur_fill'}
            onChange={(e) =>
              onPatchClip({
                backgroundBlurFill: e.target.checked,
                backgroundStyle: e.target.checked ? 'blur_fill' : 'fill_crop',
              })
            }
            className="h-4 w-4 rounded border-white/20 bg-[#0B0D11] accent-amber-500"
          />
        </label>

        <div>
          <div className="flex justify-between text-xs text-slate-400 mb-1 tabular-nums">
            <span>Manual horizontal crop anchor</span>
            <span className="font-mono text-slate-200">{clip.cropOffsetX}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={clip.cropOffsetX}
            onChange={(e) =>
              onPatchClip({
                cropOffsetX: Number(e.target.value),
                autoSpeakerTracking: false,
                cropKeyframes: [],
              })
            }
            aria-label="Horizontal crop anchor"
            className="w-full accent-amber-500"
          />
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={onAddCropKeyframe}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-white/10 whitespace-nowrap"
          >
            <Plus className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
            Add Crop Keyframe
          </button>
          {clip.cropKeyframes && clip.cropKeyframes.length > 0 && (
            <button
              type="button"
              onClick={onResetCropKeyframes}
              className="rounded-md border border-white/10 px-2.5 py-1.5 text-xs text-slate-400 hover:text-white whitespace-nowrap"
            >
              Reset Auto Curve
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
