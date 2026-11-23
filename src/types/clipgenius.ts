export type AspectRatio = '9:16' | '16:9' | '1:1' | '4:5';

export type CaptionStylePreset =
  | 'modern_animated'
  | 'bold_viral'
  | 'minimal'
  | 'word_highlight'
  | 'karaoke';

export type ClipDurationPreset = 15 | 30 | 45 | 60 | 90;

export type PipelineStage =
  | 'audio_extract'
  | 'transcription'
  | 'diarization'
  | 'scene_detection'
  | 'topic_segmentation'
  | 'highlight_detection'
  | 'clip_ranking';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'requires_configuration';

export interface User {
  id: string;
  email: string;
  name: string;
  plan: 'starter' | 'creator' | 'studio';
  role?: 'creator' | 'admin';
  createdAt: string;
}

export interface Video {
  id: string;
  projectId: string;
  sourceType: 'upload' | 'url';
  sourceUrl?: string;
  filename: string;
  mimeType: string;
  fileSizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  thumbnailUrl: string;
  previewVideoUrl?: string;
  waveformPeaks?: number[];
  ffprobeVerified?: boolean;
  storageKey?: string;
  rawStorageKey?: string;
  pixelFormat?: string;
  browserPlayable?: boolean;
  mediaUnavailable?: boolean;
  previewAuthQuery?: string;
}

export type SoundEventCategory =
  | 'laughing'
  | 'crying'
  | 'singing'
  | 'humming'
  | 'applause'
  | 'cheering'
  | 'sighing'
  | 'gasping'
  | 'whispering'
  | 'music'
  | 'screaming'
  | 'coughing'
  | 'ambient'
  | 'other';

export interface TranscriptWord {
  word: string;
  startSec: number;
  endSec: number;
  speaker: string;
  confidence: number;
  kind?: 'speech' | 'sound_event';
  soundCategory?: SoundEventCategory;
}

export interface Transcript {
  id: string;
  videoId: string;
  language: string;
  speakers: string[];
  words: TranscriptWord[];
}

export interface ScoreCriterion {
  key:
    | 'hookStrength'
    | 'emotionalImpact'
    | 'informationValue'
    | 'audienceInterest'
    | 'storyCompleteness'
    | 'shareability';
  label: string;
  weight: number;
  score: number;
  rationale: string;
}

export interface ClipScore {
  id: string;
  clipId: string;
  overallEstimate: number;
  disclaimer: string;
  summary: string;
  criteria: ScoreCriterion[];
}

export interface CaptionStyle {
  id: string;
  preset: CaptionStylePreset;
  label: string;
  fontFamily: string;
  fontSizePx: number;
  fontWeight?: 500 | 600 | 700 | 800;
  primaryColor: string;
  highlightColor: string;
  strokeColor: string;
  strokeWidthPx?: number;
  backgroundColor?: string;
  backgroundOpacity?: number;
  textAlign?: 'left' | 'center' | 'right';
  maxWordsPerLine?: number;
  position: 'bottom' | 'center' | 'top';
  uppercase: boolean;
}

export interface SocialCopyPack {
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
}

export interface SilenceInterval {
  startSec: number;
  endSec: number;
  durationSec: number;
}

export interface CropKeyframe {
  timeSec: number;
  xPct: number;
  zoom: number;
  speaker?: string;
}

export type CaptionAnimationStyle = 'none' | 'pop' | 'karaoke' | 'fade';

export type BackgroundStyle =
  | 'fill_crop'
  | 'blur_fill'
  | 'dark_gradient'
  | 'midnight_neon'
  | 'warm_studio'
  | 'clean_cinema';

export type SoundtrackId =
  | 'none'
  | 'upbeat_lofi'
  | 'cinematic_ambient'
  | 'energetic_synth'
  | 'soft_acoustic'
  | 'dramatic_pulse';

export interface CaptionCustomizations {
  fontFamily?: string;
  fontSizePx?: number;
  fontWeight?: 500 | 600 | 700 | 800;
  primaryColor?: string;
  highlightColor?: string;
  strokeColor?: string;
  strokeWidthPx?: number;
  backgroundColor?: string;
  backgroundOpacity?: number;
  textAlign?: 'left' | 'center' | 'right';
  maxWordsPerLine?: number;
  position?: 'bottom' | 'center' | 'top';
  uppercase?: boolean;
  animation?: CaptionAnimationStyle;
}

export interface ClipVersion {
  id: string;
  label: string;
  name: string;
  description: string;
  captionStyle: CaptionStylePreset;
  captionOverrides?: CaptionCustomizations;
  backgroundStyle: BackgroundStyle;
  soundtrackId: SoundtrackId;
  soundtrackVolume: number;
  aspectRatio: AspectRatio;
  autoZoom?: boolean;
  removeSilences?: boolean;
  removeFillers?: boolean;
}

export interface TranslatedSubtitleCue {
  startSec: number;
  endSec: number;
  text: string;
}

export interface Clip {
  id: string;
  projectId: string;
  title: string;
  startSec: number;
  endSec: number;
  aspectRatio: AspectRatio;
  cropOffsetX: number;
  autoSpeakerTracking: boolean;
  autoZoom?: boolean;
  cropKeyframes?: CropKeyframe[];
  backgroundBlurFill: boolean;
  backgroundStyle?: BackgroundStyle;
  soundtrackId?: SoundtrackId;
  soundtrackVolume?: number;
  versions?: ClipVersion[];
  activeVersionId?: string;
  isAiRecommended?: boolean;
  recommendationReason?: string;
  removeSilences?: boolean;
  removeFillers?: boolean;
  captionStyle: CaptionStylePreset;
  captionOverrides?: CaptionCustomizations;
  captionText: string;
  captionTextEdited?: boolean;
  subtitleLanguage?: string;
  wordsLanguage?: string;
  translatedCues?: Record<string, TranslatedSubtitleCue[]>;
  thumbnailUrl: string;
  speaker: string;
  score: ClipScore;
  metadata: SocialCopyPack;
  words: TranscriptWord[];
}

export interface BrandKit {
  id: string;
  name: string;
  primaryColor: string;
  accentColor: string;
  fontDisplay: string;
  defaultCaptionPreset: CaptionStylePreset;
  watermarkPosition: 'top_right' | 'top_left' | 'bottom_right' | 'none';
  watermarkText: string;
}

export interface ProcessingJob {
  id: string;
  projectId: string;
  stage: PipelineStage;
  status: JobStatus;
  progressPct: number;
  message: string;
  updatedAt: string;
}

export type SocialExportPreset = 'tiktok' | 'reels' | 'shorts' | 'linkedin' | 'custom';

export type ExportContainerFormat = 'mp4' | 'mov' | 'webm' | 'mkv' | 'gif' | 'mp3';

export type ExportQuality = '480p' | '720p' | '1080p';

export interface ExportJob {
  id: string;
  projectId: string;
  clipId: string;
  clipIds?: string[];
  clipTitle: string;
  kind: 'mp4' | 'batch_zip';
  containerFormat?: ExportContainerFormat;
  format: string;
  quality: ExportQuality;
  aspectRatio: AspectRatio;
  platformPreset: SocialExportPreset;
  burnCaptions: boolean;
  subtitleLanguage?: string;
  status: JobStatus;
  progressPct: number;
  message?: string;
  filename?: string;
  fileSizeBytes?: number;
  downloadUrl?: string;
  previewUrl?: string;
  expiresAt?: string;
  attempt: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UsageRecord {
  periodLabel: string;
  minutesAnalyzed: number;
  minutesLimit: number;
  clipsGenerated: number;
  exportsCompleted: number;
  exportsLimit: number;
}

export interface Project {
  id: string;
  ownerId: string;
  title: string;
  createdAt: string;
  status: 'ready' | 'processing' | 'queued_phase2' | 'error';
  isDemo: boolean;
  demoNotice?: string;
  video: Video;
  transcript?: Transcript;
  sceneCutsSec?: number[];
  silenceCount?: number;
  silences?: SilenceInterval[];
  processingStages: ProcessingJob[];
  clips: Clip[];
}

export interface UploadQueueItem {
  id: string;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  progressPct: number;
  status: 'validating' | 'uploading' | 'paused' | 'queued_phase2' | 'error';
  durationSec?: number;
  resolution?: string;
  previewObjectUrl?: string;
  errorMessage?: string;
}

export interface SystemConfigStatus {
  environment: string;
  geminiConfigured: boolean;
  ffmpegAvailable: boolean;
  objectStorageConfigured: boolean;
  databaseConfigured: boolean;
  redisQueueConfigured: boolean;
  googleOAuthConfigured: boolean;
  activePhase: string;
}

export interface AnalysisTriggerResult {
  ok?: boolean;
  started?: boolean;
  requiresConfiguration?: boolean;
  isDemo?: boolean;
  message?: string;
  error?: string;
  project?: Project;
}
