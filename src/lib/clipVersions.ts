import type {
  AspectRatio,
  BackgroundStyle,
  CaptionStylePreset,
  Clip,
  ClipVersion,
  SoundEventCategory,
  SoundtrackId,
} from '../types/clipgenius';

export interface BackgroundStyleOption {
  id: BackgroundStyle;
  label: string;
  shortLabel: string;
  description: string;
  swatchCss: string;
  stageBgCss: string;
  frameBorderCss?: string;
  ffmpegColorHex: string;
  ffmpegAccentHex?: string;
  isFramed: boolean;
}

export const BACKGROUND_STYLE_OPTIONS: BackgroundStyleOption[] = [
  {
    id: 'fill_crop',
    label: 'Full-Bleed Crop',
    shortLabel: 'Full Crop',
    description: 'Edge-to-edge smart crop filling the entire canvas.',
    swatchCss: 'linear-gradient(135deg, #1E293B 0%, #0F172A 100%)',
    stageBgCss: '#050608',
    ffmpegColorHex: '#050608',
    isFramed: false,
  },
  {
    id: 'blur_fill',
    label: 'Blurred Video Fill',
    shortLabel: 'Blur Fill',
    description: 'Soft Gaussian-blurred motion backdrop behind the framed clip.',
    swatchCss: 'linear-gradient(135deg, #334155 0%, #1E1B4B 50%, #0F172A 100%)',
    stageBgCss: '#0B0D11',
    ffmpegColorHex: '#0B0D11',
    isFramed: true,
  },
  {
    id: 'dark_gradient',
    label: 'Studio Obsidian',
    shortLabel: 'Obsidian',
    description: 'Deep charcoal studio slate backdrop framing the video cleanly.',
    swatchCss: 'radial-gradient(circle at 30% 20%, #273244 0%, #0D1117 75%)',
    stageBgCss: 'radial-gradient(circle at 50% 25%, #232D3F 0%, #0C1017 78%)',
    frameBorderCss: '1px solid rgba(255,255,255,0.12)',
    ffmpegColorHex: '#121822',
    ffmpegAccentHex: '#334155',
    isFramed: true,
  },
  {
    id: 'midnight_neon',
    label: 'Midnight Indigo',
    shortLabel: 'Indigo Frame',
    description: 'Deep twilight indigo backdrop with subtle cyan accent framing.',
    swatchCss: 'linear-gradient(155deg, #1E1B4B 0%, #0F172A 55%, #082F49 100%)',
    stageBgCss: 'linear-gradient(160deg, #1B1642 0%, #0E1326 52%, #08263A 100%)',
    frameBorderCss: '1px solid rgba(56,189,248,0.45)',
    ffmpegColorHex: '#161336',
    ffmpegAccentHex: '#38BDF8',
    isFramed: true,
  },
  {
    id: 'warm_studio',
    label: 'Warm Editorial',
    shortLabel: 'Warm Studio',
    description: 'Rich espresso-amber studio backdrop tailored for podcasts and talks.',
    swatchCss: 'linear-gradient(155deg, #2C1E14 0%, #17120E 60%, #26180F 100%)',
    stageBgCss: 'linear-gradient(160deg, #2D1E13 0%, #15100C 55%, #23160D 100%)',
    frameBorderCss: '1px solid rgba(245,158,11,0.42)',
    ffmpegColorHex: '#241810',
    ffmpegAccentHex: '#F59E0B',
    isFramed: true,
  },
  {
    id: 'clean_cinema',
    label: 'Cinema Matte',
    shortLabel: 'Cinema Matte',
    description: 'Pure matte black widescreen letterbox framing with zero distractions.',
    swatchCss: 'linear-gradient(180deg, #050507 0%, #141418 50%, #050507 100%)',
    stageBgCss: '#040507',
    frameBorderCss: '1px solid rgba(255,255,255,0.08)',
    ffmpegColorHex: '#040507',
    isFramed: true,
  },
];

export interface SoundtrackOption {
  id: SoundtrackId;
  label: string;
  shortLabel: string;
  mood: string;
  bpm: number;
  description: string;
}

export const SOUNDTRACK_OPTIONS: SoundtrackOption[] = [
  {
    id: 'none',
    label: 'Original Audio Only',
    shortLabel: 'Original Audio',
    mood: 'Clean',
    bpm: 0,
    description: 'Keep only the video’s native speech and sounds with no music bed.',
  },
  {
    id: 'upbeat_lofi',
    label: 'Upbeat Lo-Fi Pulse',
    shortLabel: 'Upbeat Lo-Fi',
    mood: 'Creator · Warm',
    bpm: 96,
    description: 'Warm mellow Rhodes chord progression with subtle lo-fi bounce.',
  },
  {
    id: 'cinematic_ambient',
    label: 'Cinematic Ambient Pad',
    shortLabel: 'Ambient Cinema',
    mood: 'Story · Deep',
    bpm: 72,
    description: 'Wide atmospheric harmonic pad ideal for storytelling and insights.',
  },
  {
    id: 'energetic_synth',
    label: 'Energetic Synth Drive',
    shortLabel: 'Synth Drive',
    mood: 'Viral · High Energy',
    bpm: 118,
    description: 'Crisp rhythmic synth pulse built for fast-paced hooks and reels.',
  },
  {
    id: 'soft_acoustic',
    label: 'Soft Acoustic Groove',
    shortLabel: 'Soft Acoustic',
    mood: 'Podcast · Friendly',
    bpm: 86,
    description: 'Gentle plucked harmonic warmth that sits cleanly under voices.',
  },
  {
    id: 'dramatic_pulse',
    label: 'Dramatic Tension Pulse',
    shortLabel: 'Dramatic Pulse',
    mood: 'Bold · Suspense',
    bpm: 104,
    description: 'Deep minor bass pulse for contrarian takes and emotional moments.',
  },
];

export function getBackgroundStyleOption(style?: BackgroundStyle): BackgroundStyleOption {
  return (
    BACKGROUND_STYLE_OPTIONS.find((b) => b.id === style) ?? BACKGROUND_STYLE_OPTIONS[0]
  );
}

export function getSoundtrackOption(trackId?: SoundtrackId): SoundtrackOption {
  return SOUNDTRACK_OPTIONS.find((t) => t.id === trackId) ?? SOUNDTRACK_OPTIONS[0];
}

export function resolveClipBackgroundStyle(clip: Pick<Clip, 'backgroundStyle' | 'backgroundBlurFill'>): BackgroundStyle {
  if (clip.backgroundStyle) return clip.backgroundStyle;
  return clip.backgroundBlurFill ? 'blur_fill' : 'fill_crop';
}

export function buildDefaultClipVersions(options?: {
  aspectRatio?: AspectRatio;
  preferFramedBackground?: boolean;
}): ClipVersion[] {
  const ratio = options?.aspectRatio ?? '9:16';
  const primaryBg: BackgroundStyle = options?.preferFramedBackground ? 'blur_fill' : 'fill_crop';

  return [
    {
      id: 'ver_1',
      label: 'Ver-1',
      name: 'Viral Punch',
      description: 'Bold Viral captions · Blurred backdrop · Upbeat Lo-Fi bed',
      captionStyle: 'bold_viral',
      captionOverrides: {
        position: 'center',
        animation: 'pop',
      },
      backgroundStyle: primaryBg,
      soundtrackId: 'upbeat_lofi',
      soundtrackVolume: 0.22,
      aspectRatio: ratio,
      autoZoom: true,
      removeSilences: false,
      removeFillers: false,
    },
    {
      id: 'ver_2',
      label: 'Ver-2',
      name: 'Cinematic Clean',
      description: 'Minimal Clean captions · Studio Obsidian backdrop · Ambient Cinema',
      captionStyle: 'minimal',
      captionOverrides: {
        position: 'bottom',
        animation: 'fade',
      },
      backgroundStyle: 'dark_gradient',
      soundtrackId: 'cinematic_ambient',
      soundtrackVolume: 0.2,
      aspectRatio: ratio,
      autoZoom: false,
      removeSilences: false,
      removeFillers: false,
    },
    {
      id: 'ver_3',
      label: 'Ver-3',
      name: 'Neon Karaoke',
      description: 'Karaoke Fill captions · Midnight Indigo frame · Energetic Synth',
      captionStyle: 'karaoke',
      captionOverrides: {
        position: 'center',
        animation: 'karaoke',
      },
      backgroundStyle: 'midnight_neon',
      soundtrackId: 'energetic_synth',
      soundtrackVolume: 0.24,
      aspectRatio: ratio,
      autoZoom: true,
      removeSilences: false,
      removeFillers: false,
    },
    {
      id: 'ver_4',
      label: 'Ver-4',
      name: 'Warm Studio',
      description: 'Modern Animated captions · Warm Editorial frame · Soft Acoustic',
      captionStyle: 'modern_animated',
      captionOverrides: {
        position: 'bottom',
        animation: 'pop',
      },
      backgroundStyle: 'warm_studio',
      soundtrackId: 'soft_acoustic',
      soundtrackVolume: 0.18,
      aspectRatio: ratio,
      autoZoom: false,
      removeSilences: false,
      removeFillers: false,
    },
  ];
}

export function ensureClipVersions(clip: Clip): {
  versions: ClipVersion[];
  activeVersionId: string;
} {
  if (clip.versions && clip.versions.length > 0) {
    const activeExists = clip.versions.some((v) => v.id === clip.activeVersionId);
    return {
      versions: clip.versions,
      activeVersionId: activeExists ? clip.activeVersionId! : clip.versions[0].id,
    };
  }

  const defaults = buildDefaultClipVersions({
    aspectRatio: clip.aspectRatio,
    preferFramedBackground: clip.backgroundBlurFill,
  });

  // Align Ver-1 with the clip's existing active look so legacy clips stay consistent
  defaults[0] = {
    ...defaults[0],
    captionStyle: clip.captionStyle,
    captionOverrides: clip.captionOverrides ? { ...clip.captionOverrides } : defaults[0].captionOverrides,
    backgroundStyle: resolveClipBackgroundStyle(clip),
    soundtrackId: clip.soundtrackId ?? defaults[0].soundtrackId,
    soundtrackVolume: clip.soundtrackVolume ?? defaults[0].soundtrackVolume,
    aspectRatio: clip.aspectRatio,
    autoZoom: Boolean(clip.autoZoom),
    removeSilences: Boolean(clip.removeSilences),
    removeFillers: Boolean(clip.removeFillers),
  };

  return {
    versions: defaults,
    activeVersionId: defaults[0].id,
  };
}

export function applyVersionPatchToClip(clip: Clip, versionId: string): Partial<Clip> | null {
  const { versions } = ensureClipVersions(clip);
  const target = versions.find((v) => v.id === versionId);
  if (!target) return null;

  return {
    versions,
    activeVersionId: target.id,
    captionStyle: target.captionStyle,
    captionOverrides: target.captionOverrides ? { ...target.captionOverrides } : {},
    backgroundStyle: target.backgroundStyle,
    backgroundBlurFill: target.backgroundStyle === 'blur_fill',
    soundtrackId: target.soundtrackId,
    soundtrackVolume: target.soundtrackVolume,
    aspectRatio: target.aspectRatio,
    autoZoom: Boolean(target.autoZoom),
    removeSilences: Boolean(target.removeSilences),
    removeFillers: Boolean(target.removeFillers),
  };
}

export function syncPatchIntoActiveVersion(clip: Clip, patch: Partial<Clip>): Partial<Clip> {
  if (patch.versions !== undefined && patch.activeVersionId !== undefined) {
    return patch;
  }

  const { versions, activeVersionId } = ensureClipVersions(clip);
  const targetId = patch.activeVersionId ?? activeVersionId;

  const nextBackgroundStyle: BackgroundStyle =
    patch.backgroundStyle !== undefined
      ? patch.backgroundStyle
      : patch.backgroundBlurFill !== undefined
      ? patch.backgroundBlurFill
        ? 'blur_fill'
        : clip.backgroundStyle === 'blur_fill'
        ? 'fill_crop'
        : clip.backgroundStyle ?? 'fill_crop'
      : resolveClipBackgroundStyle(clip);

  const nextVersions = versions.map((v) => {
    if (v.id !== targetId) return v;
    return {
      ...v,
      captionStyle: (patch.captionStyle ?? v.captionStyle) as CaptionStylePreset,
      captionOverrides:
        patch.captionOverrides !== undefined ? { ...patch.captionOverrides } : v.captionOverrides,
      backgroundStyle: nextBackgroundStyle,
      soundtrackId: patch.soundtrackId ?? v.soundtrackId,
      soundtrackVolume: patch.soundtrackVolume ?? v.soundtrackVolume,
      aspectRatio: patch.aspectRatio ?? v.aspectRatio,
      autoZoom: patch.autoZoom !== undefined ? patch.autoZoom : v.autoZoom,
      removeSilences:
        patch.removeSilences !== undefined ? patch.removeSilences : v.removeSilences,
      removeFillers:
        patch.removeFillers !== undefined ? patch.removeFillers : v.removeFillers,
    };
  });

  return {
    ...patch,
    backgroundStyle: nextBackgroundStyle,
    backgroundBlurFill: nextBackgroundStyle === 'blur_fill',
    versions: nextVersions,
    activeVersionId: targetId,
  };
}

const EXTRA_VERSION_RECIPES: Omit<ClipVersion, 'id' | 'label' | 'aspectRatio'>[] = [
  {
    name: 'Drama Hook',
    description: 'Word Highlight captions · Cinema Matte · Dramatic Pulse',
    captionStyle: 'word_highlight',
    captionOverrides: { position: 'bottom', animation: 'pop' },
    backgroundStyle: 'clean_cinema',
    soundtrackId: 'dramatic_pulse',
    soundtrackVolume: 0.25,
    autoZoom: true,
    removeSilences: true,
    removeFillers: true,
  },
  {
    name: 'Raw Original',
    description: 'Minimal Clean captions · Full-Bleed Crop · Original Audio Only',
    captionStyle: 'minimal',
    captionOverrides: { position: 'bottom', animation: 'none' },
    backgroundStyle: 'fill_crop',
    soundtrackId: 'none',
    soundtrackVolume: 0,
    autoZoom: false,
    removeSilences: false,
    removeFillers: false,
  },
  {
    name: 'Studio Spotlight',
    description: 'Bold Viral captions · Midnight Indigo · Upbeat Lo-Fi',
    captionStyle: 'bold_viral',
    captionOverrides: { position: 'top', animation: 'pop' },
    backgroundStyle: 'midnight_neon',
    soundtrackId: 'upbeat_lofi',
    soundtrackVolume: 0.2,
    autoZoom: true,
    removeSilences: false,
    removeFillers: false,
  },
];

export function createNextClipVersionPatch(clip: Clip): Partial<Clip> {
  const { versions } = ensureClipVersions(clip);
  const nextNum = versions.length + 1;
  const recipe = EXTRA_VERSION_RECIPES[(nextNum - 5 + EXTRA_VERSION_RECIPES.length) % EXTRA_VERSION_RECIPES.length];

  const created: ClipVersion = {
    id: `ver_${nextNum}_${Date.now().toString(36).slice(-4)}`,
    label: `Ver-${nextNum}`,
    name: recipe.name,
    description: recipe.description,
    captionStyle: recipe.captionStyle,
    captionOverrides: recipe.captionOverrides ? { ...recipe.captionOverrides } : {},
    backgroundStyle: recipe.backgroundStyle,
    soundtrackId: recipe.soundtrackId,
    soundtrackVolume: recipe.soundtrackVolume,
    aspectRatio: clip.aspectRatio,
    autoZoom: recipe.autoZoom,
    removeSilences: recipe.removeSilences,
    removeFillers: recipe.removeFillers,
  };

  return {
    versions: [...versions, created],
    activeVersionId: created.id,
    captionStyle: created.captionStyle,
    captionOverrides: created.captionOverrides ? { ...created.captionOverrides } : {},
    backgroundStyle: created.backgroundStyle,
    backgroundBlurFill: created.backgroundStyle === 'blur_fill',
    soundtrackId: created.soundtrackId,
    soundtrackVolume: created.soundtrackVolume,
    autoZoom: Boolean(created.autoZoom),
    removeSilences: Boolean(created.removeSilences),
    removeFillers: Boolean(created.removeFillers),
  };
}

const SOUND_CATEGORY_LABELS: Record<SoundEventCategory, string> = {
  laughing: 'Laughing',
  crying: 'Crying',
  singing: 'Singing',
  humming: 'Humming',
  applause: 'Applause',
  cheering: 'Cheering',
  sighing: 'Sighing',
  gasping: 'Gasping',
  whispering: 'Whispering',
  music: 'Music playing',
  screaming: 'Screaming',
  coughing: 'Coughing',
  ambient: 'Ambient sound',
  other: 'Sound',
};

export function normalizeSoundCategory(raw?: string): SoundEventCategory {
  const lower = (raw ?? '').toLowerCase().trim();
  if (/laugh|giggle|chuckle|snicker|haha/.test(lower)) return 'laughing';
  if (/cry|sob|weep|tear|whimper/.test(lower)) return 'crying';
  if (/sing|vocaliz|melody|croon/.test(lower)) return 'singing';
  if (/hum|humm/.test(lower)) return 'humming';
  if (/applau|clap/.test(lower)) return 'applause';
  if (/cheer|whoop|woo/.test(lower)) return 'cheering';
  if (/sigh|exhale/.test(lower)) return 'sighing';
  if (/gasp|inhale/.test(lower)) return 'gasping';
  if (/whisper/.test(lower)) return 'whispering';
  if (/music|guitar|piano|drum|beat|instrument|song/.test(lower)) return 'music';
  if (/scream|shout|yell/.test(lower)) return 'screaming';
  if (/cough|sneeze|throat/.test(lower)) return 'coughing';
  if (/ambient|wind|rain|crowd|footstep|noise/.test(lower)) return 'ambient';
  return 'other';
}

export function formatSoundEventLabel(
  category?: SoundEventCategory,
  rawLabel?: string
): string {
  const cleanedRaw = (rawLabel ?? '').replace(/^\[+|\]+$/g, '').trim();
  const base =
    cleanedRaw.length > 0 && cleanedRaw.length <= 42
      ? cleanedRaw.charAt(0).toUpperCase() + cleanedRaw.slice(1)
      : SOUND_CATEGORY_LABELS[category ?? 'other'] ?? 'Sound';
  return `[${base}]`;
}
