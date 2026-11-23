import type { ExportContainerFormat, ExportQuality } from '../types/clipgenius';

export interface ExportFormatOption {
  id: ExportContainerFormat;
  label: string;
  shortTag: string;
  codecSummary: string;
  extension: string;
  mimeType: string;
  supportsResolution: boolean;
  supportsBurnCaptions: boolean;
  supportsInlineVideoPreview: boolean;
  isAudioOnly: boolean;
  recommended?: boolean;
}

export const EXPORT_FORMAT_OPTIONS: ExportFormatOption[] = [
  {
    id: 'mp4',
    label: 'MP4',
    shortTag: 'Universal',
    codecSummary: 'H.264 + AAC · Plays everywhere',
    extension: 'mp4',
    mimeType: 'video/mp4',
    supportsResolution: true,
    supportsBurnCaptions: true,
    supportsInlineVideoPreview: true,
    isAudioOnly: false,
    recommended: true,
  },
  {
    id: 'mov',
    label: 'MOV',
    shortTag: 'QuickTime',
    codecSummary: 'H.264 + AAC · Apple & NLE',
    extension: 'mov',
    mimeType: 'video/quicktime',
    supportsResolution: true,
    supportsBurnCaptions: true,
    supportsInlineVideoPreview: true,
    isAudioOnly: false,
  },
  {
    id: 'webm',
    label: 'WebM',
    shortTag: 'Web HD',
    codecSummary: 'VP9 + Opus · Light web video',
    extension: 'webm',
    mimeType: 'video/webm',
    supportsResolution: true,
    supportsBurnCaptions: true,
    supportsInlineVideoPreview: true,
    isAudioOnly: false,
  },
  {
    id: 'mkv',
    label: 'MKV',
    shortTag: 'Matroska',
    codecSummary: 'H.264 + AAC · Desktop & VLC',
    extension: 'mkv',
    mimeType: 'video/x-matroska',
    supportsResolution: true,
    supportsBurnCaptions: true,
    supportsInlineVideoPreview: false,
    isAudioOnly: false,
  },
  {
    id: 'gif',
    label: 'GIF',
    shortTag: 'Animated',
    codecSummary: 'Palette GIF · 12fps loop',
    extension: 'gif',
    mimeType: 'image/gif',
    supportsResolution: false,
    supportsBurnCaptions: true,
    supportsInlineVideoPreview: false,
    isAudioOnly: false,
  },
  {
    id: 'mp3',
    label: 'MP3',
    shortTag: 'Audio Only',
    codecSummary: '192kbps Stereo · Cuts + BGM',
    extension: 'mp3',
    mimeType: 'audio/mpeg',
    supportsResolution: false,
    supportsBurnCaptions: false,
    supportsInlineVideoPreview: false,
    isAudioOnly: true,
  },
];

export const EXPORT_QUALITY_OPTIONS: ExportQuality[] = ['480p', '720p', '1080p'];

export function normalizeExportContainerFormat(raw: unknown): ExportContainerFormat {
  const val = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (
    val === 'mp4' ||
    val === 'mov' ||
    val === 'webm' ||
    val === 'mkv' ||
    val === 'gif' ||
    val === 'mp3'
  ) {
    return val;
  }
  return 'mp4';
}

export function normalizeExportQuality(raw: unknown): ExportQuality {
  if (raw === '480p' || raw === '720p' || raw === '1080p') {
    return raw;
  }
  return '720p';
}

export function getExportFormatOption(
  format?: ExportContainerFormat | string
): ExportFormatOption {
  const normalized = normalizeExportContainerFormat(format);
  return (
    EXPORT_FORMAT_OPTIONS.find((opt) => opt.id === normalized) ?? EXPORT_FORMAT_OPTIONS[0]
  );
}

/**
 * Validates that an HTTP download response actually returned a playable media/archive
 * payload rather than an HTML redirect page or JSON error response.
 */
export function isPlayableDownloadContentType(
  contentTypeHeader: string | null | undefined,
  kind: 'mp4' | 'batch_zip',
  containerFormat: ExportContainerFormat = 'mp4'
): boolean {
  const ct = (contentTypeHeader || '').split(';')[0].trim().toLowerCase();
  if (!ct) return false;
  if (ct.startsWith('text/') || ct === 'application/json' || ct.includes('html')) {
    return false;
  }
  if (kind === 'batch_zip') {
    return ct === 'application/zip' || ct === 'application/octet-stream';
  }
  if (containerFormat === 'gif') {
    return ct === 'image/gif' || ct === 'application/octet-stream';
  }
  if (containerFormat === 'mp3') {
    return ct.startsWith('audio/') || ct === 'application/octet-stream';
  }
  return ct.startsWith('video/') || ct === 'application/octet-stream';
}
