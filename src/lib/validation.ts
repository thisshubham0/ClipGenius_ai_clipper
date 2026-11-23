export const ALLOWED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.mkv'] as const;

export const ALLOWED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'application/octet-stream', // some browsers emit this for .mkv
] as const;

export const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

export interface FileValidationInput {
  name: string;
  size: number;
  type: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  extension?: string;
}

export function extractFileExtension(filename: string): string {
  const trimmed = filename.trim().toLowerCase();
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === trimmed.length - 1) {
    return '';
  }
  return trimmed.slice(lastDot);
}

export function validateVideoFile(
  file: FileValidationInput,
  maxBytes: number = DEFAULT_MAX_UPLOAD_BYTES
): ValidationResult {
  if (!file.name || !file.name.trim()) {
    return { valid: false, error: 'File name is missing.' };
  }

  const ext = extractFileExtension(file.name);
  if (!ALLOWED_VIDEO_EXTENSIONS.includes(ext as (typeof ALLOWED_VIDEO_EXTENSIONS)[number])) {
    return {
      valid: false,
      error: `Unsupported file format "${ext || 'unknown'}". Upload MP4, MOV, WebM, or MKV.`,
      extension: ext,
    };
  }

  if (file.size <= 0) {
    return { valid: false, error: 'Selected file is empty (0 bytes).', extension: ext };
  }

  if (file.size > maxBytes) {
    const limitMb = Math.round(maxBytes / (1024 * 1024));
    return {
      valid: false,
      error: `File exceeds the ${limitMb} MB plan upload limit.`,
      extension: ext,
    };
  }

  if (
    file.type &&
    !ALLOWED_VIDEO_MIME_TYPES.includes(file.type.toLowerCase() as (typeof ALLOWED_VIDEO_MIME_TYPES)[number])
  ) {
    return {
      valid: false,
      error: `Unexpected MIME type "${file.type}". Expected MP4, MOV, WebM, or MKV video.`,
      extension: ext,
    };
  }

  return { valid: true, extension: ext };
}

export function validateImportUrl(rawUrl: string): ValidationResult {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { valid: false, error: 'Paste a video URL to continue.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Enter a valid https:// video URL.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, error: 'URL must begin with https:// or http://.' };
  }

  const host = parsed.hostname.toLowerCase();
  const isYouTube =
    host === 'youtube.com' ||
    host === 'www.youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'youtu.be';
  const isVimeo = host === 'vimeo.com' || host === 'www.vimeo.com' || host === 'player.vimeo.com';
  const pathLower = parsed.pathname.toLowerCase();
  const isDirectVideo = ALLOWED_VIDEO_EXTENSIONS.some((ext) => pathLower.endsWith(ext));

  if (!isYouTube && !isVimeo && !isDirectVideo) {
    return {
      valid: false,
      error: 'Supported sources: YouTube, Vimeo, or direct .mp4 / .mov / .webm / .mkv URLs.',
    };
  }

  return { valid: true };
}

export type AuthMode = 'signin' | 'signup' | 'reset';

export interface AuthFormInput {
  email: string;
  password?: string;
  name?: string;
}

export function validateAuthForm(mode: AuthMode, input: AuthFormInput): ValidationResult {
  const email = input.email.trim();
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailPattern.test(email)) {
    return { valid: false, error: 'Enter a valid email address.' };
  }

  if (mode === 'reset') {
    return { valid: true };
  }

  if (mode === 'signup' && (!input.name || input.name.trim().length < 2)) {
    return { valid: false, error: 'Enter your full name (at least 2 characters).' };
  }

  const password = input.password ?? '';
  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters.' };
  }

  return { valid: true };
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, idx);
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
}

export function isFirebasePopupPendingPromiseError(err: unknown): boolean {
  if (!err) return false;
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && 'message' in err && typeof (err as { message?: unknown }).message === 'string'
      ? (err as { message: string }).message
      : String(err);
  return (
    message.includes('Pending promise was never set') ||
    message.includes('INTERNAL ASSERTION FAILED')
  );
}

export function formatGoogleAuthError(err: unknown): {
  kind: 'info' | 'error';
  message: string;
} {
  const code =
    err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : undefined;

  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return {
      kind: 'info',
      message: 'Google sign-in popup was closed before completing. Click Continue with Google to try again.',
    };
  }
  if (code === 'auth/popup-blocked') {
    return {
      kind: 'error',
      message:
        'Your browser blocked the Google sign-in popup. Allow popups for this site and try again.',
    };
  }
  if (code === 'auth/unauthorized-domain') {
    return {
      kind: 'error',
      message:
        'This domain is not authorized for Google Sign-In yet. Open the app from its authorized URL or enter Sample Workspace.',
    };
  }
  if (isFirebasePopupPendingPromiseError(err)) {
    return {
      kind: 'info',
      message:
        'The Google sign-in window closed while completing verification. Please click Continue with Google once more.',
    };
  }
  return {
    kind: 'error',
    message:
      err instanceof Error && err.message
        ? err.message
        : 'Unable to complete Google sign-in right now. Please try again.',
  };
}

