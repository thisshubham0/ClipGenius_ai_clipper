import type { TranslatedSubtitleCue } from '../types/clipgenius';

export interface CaptionLanguageOption {
  code: string;
  label: string;
  shortLabel: string;
  description: string;
  featured: boolean;
}

export const CAPTION_LANGUAGES: readonly CaptionLanguageOption[] = [
  {
    code: 'original',
    label: 'Original Audio',
    shortLabel: 'Original',
    description: 'Keep the original detected audio language',
    featured: true,
  },
  {
    code: 'en',
    label: 'English',
    shortLabel: 'English',
    description: 'Clean natural English captions (translates Hindi/Hinglish/other audio)',
    featured: true,
  },
  {
    code: 'hinglish',
    label: 'Hinglish',
    shortLabel: 'Hinglish',
    description: 'Conversational Hindi + English in Roman script (A–Z)',
    featured: true,
  },
  {
    code: 'hi',
    label: 'Hindi (हिन्दी)',
    shortLabel: 'Hindi',
    description: 'Devanagari Hindi captions',
    featured: false,
  },
  {
    code: 'es',
    label: 'Spanish',
    shortLabel: 'Spanish',
    description: 'Natural Spanish captions',
    featured: false,
  },
  {
    code: 'fr',
    label: 'French',
    shortLabel: 'French',
    description: 'Natural French captions',
    featured: false,
  },
  {
    code: 'de',
    label: 'German',
    shortLabel: 'German',
    description: 'Natural German captions',
    featured: false,
  },
  {
    code: 'ja',
    label: 'Japanese',
    shortLabel: 'Japanese',
    description: 'Natural Japanese captions',
    featured: false,
  },
  {
    code: 'pt',
    label: 'Portuguese',
    shortLabel: 'Portuguese',
    description: 'Natural Portuguese captions',
    featured: false,
  },
] as const;

export const FEATURED_CAPTION_LANGUAGES = CAPTION_LANGUAGES.filter((l) => l.featured);
export const SECONDARY_CAPTION_LANGUAGES = CAPTION_LANGUAGES.filter((l) => !l.featured);

export function normalizeCaptionLanguageCode(input?: string | null): string {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw || raw === 'auto' || raw === 'original') return 'original';
  if (raw === 'en' || raw === 'english' || raw.startsWith('en-')) return 'en';
  if (
    raw === 'hinglish' ||
    raw === 'hi-latn' ||
    raw === 'hi-en' ||
    raw === 'roman-hindi' ||
    raw === 'hindi-english'
  ) {
    return 'hinglish';
  }
  const exact = CAPTION_LANGUAGES.find((l) => l.code === raw);
  if (exact) return exact.code;
  return raw;
}

export function getCaptionLanguageOption(code?: string | null): CaptionLanguageOption {
  const norm = normalizeCaptionLanguageCode(code);
  return (
    CAPTION_LANGUAGES.find((l) => l.code === norm) ?? {
      code: norm,
      label: norm.toUpperCase(),
      shortLabel: norm.toUpperCase(),
      description: `Subtitles in ${norm}`,
      featured: false,
    }
  );
}

export function getCaptionLanguageLabel(code?: string | null): string {
  return getCaptionLanguageOption(code).shortLabel;
}

/**
 * Returns true if a caption cue represents a detected non-speech acoustic event
 * such as [Laughing], [Singing], [Humming], [Crying], [Sighing], [Applause].
 */
export function isSoundEventCaptionText(text: string): boolean {
  const trimmed = text.trim();
  return /^\[[^[\]]{2,48}\]$/.test(trimmed);
}

/**
 * Builds targeted Gemini prompt instructions for translating subtitle cues
 * into English, Hinglish (Roman script), or other languages while preserving
 * exact cue timing and acoustic sound-event tags.
 */
export function buildCaptionTranslationPrompt(params: {
  langCode: string;
  langLabel?: string;
  cues: TranslatedSubtitleCue[];
}): { systemInstruction: string; userPrompt: string } {
  const normCode = normalizeCaptionLanguageCode(params.langCode);
  const opt = getCaptionLanguageOption(normCode);
  const label = params.langLabel?.trim() || opt.label;

  const baseRules =
    'Rules:\n' +
    '- Return the EXACT same number of cues in the exact same order.\n' +
    '- Preserve every cue’s exact startSec and endSec numbers.\n' +
    '- Keep bracketed acoustic sound-event tags like [Laughing], [Crying], [Singing], [Humming], [Sighing], [Applause], [Music playing] UNCHANGED verbatim.\n' +
    '- Keep each caption short, punchy, and natural for vertical Reels/Shorts/YouTube captions.\n';

  if (normCode === 'hinglish') {
    return {
      systemInstruction:
        'You are an expert Indian short-form video caption writer specializing in natural Hinglish written strictly in Roman/Latin script (A-Z). Never output Devanagari characters.',
      userPrompt:
        'Convert each spoken subtitle cue into natural, conversational Indian Hinglish written STRICTLY in Roman/Latin alphabet (A-Z, NO Devanagari script like हिंदी).\n' +
        'Style guidelines for Hinglish:\n' +
        '- Blend everyday conversational Hindi words in Roman script (e.g., "bhai", "dekho", "samjho", "kyunki", "lekin", "pehle", "seedha", "bilkul", "mein", "kar dete hain") with natural English words creators actually say (e.g., "onboarding", "users", "result", "design", "video", "system", "flow").\n' +
        '- Make it sound authentic, energetic, and easy to read on screen — never stiff textbook translation.\n' +
        `${baseRules}\nCues:\n${JSON.stringify(params.cues)}`,
    };
  }

  if (normCode === 'en') {
    return {
      systemInstruction:
        'You are an expert short-form video subtitle editor producing crisp, idiomatic English captions.',
      userPrompt:
        'Translate each spoken subtitle cue into crisp, natural, idiomatic English for short-form social video captions. If a cue is in Hindi, Hinglish, or another language, translate its full meaning cleanly into natural English. If a cue is already in English, polish casing/punctuation cleanly while keeping the exact spoken meaning and rhythm.\n' +
        `${baseRules}\nCues:\n${JSON.stringify(params.cues)}`,
    };
  }

  return {
    systemInstruction:
      'You are a concise subtitle translator. Keep captions natural, punchy, and tightly aligned to the original cue timings.',
    userPrompt:
      `Translate each spoken subtitle cue naturally into ${label} (${normCode}) for short-form social video captions.\n` +
      `${baseRules}\nCues:\n${JSON.stringify(params.cues)}`,
  };
}

/**
 * Instruction snippet appended to the AI audio diarization/transcription stage
 * when the user selects English or Hinglish upfront during upload/analysis.
 */
export function buildDiarizationLanguageInstruction(captionLanguage?: string | null): string {
  const norm = normalizeCaptionLanguageCode(captionLanguage);
  if (norm === 'hinglish') {
    return (
      'CAPTION LANGUAGE REQUIREMENT (HINGLISH): Write all spoken speech segments (kind="speech") in natural, conversational Indian Hinglish using STRICTLY Roman/Latin script (A-Z, NEVER Devanagari). Keep English terms natural and render Hindi words in clean Romanized Hinglish. Keep non-speech sound events as English bracketed tags like "[Laughing]", "[Singing]", "[Humming]", "[Crying]". Set language="hinglish".\n'
    );
  }
  if (norm === 'en') {
    return (
      'CAPTION LANGUAGE REQUIREMENT (ENGLISH): Write all spoken speech segments (kind="speech") in crisp, natural English (if the speaker speaks Hindi, Hinglish, or another language, translate their spoken words accurately into natural English captions synced to their speech timing). Keep non-speech sound events as bracketed tags like "[Laughing]", "[Singing]", "[Humming]", "[Crying]". Set language="en".\n'
    );
  }
  return '';
}

/**
 * Aligns translated model cues back onto base cue timings and guarantees
 * bracketed audio sound events (e.g. [Laughing]) stay untouched verbatim.
 */
export function mergeTranslatedCuesWithTimings(
  baseCues: TranslatedSubtitleCue[],
  modelCues: TranslatedSubtitleCue[]
): TranslatedSubtitleCue[] {
  if (baseCues.length === 0) return [];
  const merged: TranslatedSubtitleCue[] = [];

  for (let i = 0; i < baseCues.length; i += 1) {
    const base = baseCues[i];
    if (isSoundEventCaptionText(base.text)) {
      merged.push({
        startSec: base.startSec,
        endSec: base.endSec,
        text: base.text.trim(),
      });
      continue;
    }

    const candidate = modelCues[i]?.text?.trim();
    merged.push({
      startSec: base.startSec,
      endSec: base.endSec,
      text: candidate && candidate.length > 0 ? candidate : base.text.trim(),
    });
  }

  return merged;
}
