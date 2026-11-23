import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const STORAGE_ROOT = path.resolve(process.cwd(), '.clipgenius-storage');
const CHUNKS_DIR = path.join(STORAGE_ROOT, 'chunks');
const MEDIA_DIR = path.join(STORAGE_ROOT, 'media');
const EXPORTS_DIR = path.join(STORAGE_ROOT, 'exports');
const SIGNING_SECRET_FILE = path.join(STORAGE_ROOT, '.signing-secret');

function loadOrCreateSigningSecret(): string {
  if (process.env.MEDIA_SIGNING_SECRET) {
    return process.env.MEDIA_SIGNING_SECRET;
  }
  try {
    fsSync.mkdirSync(STORAGE_ROOT, { recursive: true });
    if (fsSync.existsSync(SIGNING_SECRET_FILE)) {
      const existing = fsSync.readFileSync(SIGNING_SECRET_FILE, 'utf8').trim();
      if (existing.length >= 32) {
        return existing;
      }
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fsSync.writeFileSync(SIGNING_SECRET_FILE, generated, { mode: 0o600 });
    return generated;
  } catch {
    return crypto.randomBytes(32).toString('hex');
  }
}

const SIGNING_SECRET = loadOrCreateSigningSecret();

export interface ByteRange {
  start: number;
  end: number;
}

export function parseHttpRange(
  rangeHeader: string | undefined,
  totalBytes: number
): ByteRange | null {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=') || totalBytes <= 0) {
    return null;
  }
  const spec = rangeHeader.replace('bytes=', '').split(',')[0]?.trim();
  if (!spec) return null;

  const [startStr, endStr] = spec.split('-');
  if (startStr === '' && endStr) {
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const start = Math.max(0, totalBytes - suffix);
    return { start, end: totalBytes - 1 };
  }

  const start = Number(startStr);
  const end = endStr ? Number(endStr) : totalBytes - 1;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= totalBytes
  ) {
    return null;
  }

  return { start, end: Math.min(end, totalBytes - 1) };
}

export function sanitizeStorageKey(rawKey: string): string {
  return path.basename(rawKey).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function signMediaUrl(storageKey: string, ttlSeconds: number = 3600): string {
  const safeKey = sanitizeStorageKey(storageKey);
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(`${safeKey}:${exp}`)
    .digest('hex');
  return `/api/media/${encodeURIComponent(safeKey)}?exp=${exp}&sig=${sig}`;
}

export function verifyMediaSignature(
  storageKey: string,
  expStr: string | undefined,
  sig: string | undefined
): boolean {
  if (!expStr || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return false;
  }
  const safeKey = sanitizeStorageKey(storageKey);
  const expected = crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(`${safeKey}:${exp}`)
    .digest('hex');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

export function signExportDownloadUrl(
  jobId: string,
  ttlSeconds: number = 3600
): { url: string; expiresAt: string } {
  const safeId = sanitizeStorageKey(jobId);
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(`export:${safeId}:${exp}`)
    .digest('hex');
  return {
    url: `/api/exports/${encodeURIComponent(safeId)}/download?exp=${exp}&sig=${sig}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export function verifyExportSignature(
  jobId: string,
  expStr: string | undefined,
  sig: string | undefined
): boolean {
  if (!expStr || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return false;
  }
  const safeId = sanitizeStorageKey(jobId);
  const expected = crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(`export:${safeId}:${exp}`)
    .digest('hex');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

export function signClipPreviewParams(
  projectId: string,
  ttlSeconds: number = 7200
): string {
  const safeId = sanitizeStorageKey(projectId);
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(`clippreview:${safeId}:${exp}`)
    .digest('hex');
  return `exp=${exp}&sig=${sig}`;
}

export function verifyClipPreviewSignature(
  projectId: string,
  expStr: string | undefined,
  sig: string | undefined
): boolean {
  if (!expStr || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return false;
  }
  const safeId = sanitizeStorageKey(projectId);
  const expected = crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(`clippreview:${safeId}:${exp}`)
    .digest('hex');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

export async function ensureStorageDirs(): Promise<void> {
  await fs.mkdir(CHUNKS_DIR, { recursive: true });
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  await fs.mkdir(EXPORTS_DIR, { recursive: true });
}

export function getUploadChunksDir(uploadId: string): string {
  return path.join(CHUNKS_DIR, sanitizeStorageKey(uploadId));
}

export function getMediaFilePath(storageKey: string): string {
  return path.join(MEDIA_DIR, sanitizeStorageKey(storageKey));
}

export function getExportFilePath(filename: string): string {
  return path.join(EXPORTS_DIR, sanitizeStorageKey(filename));
}

export async function writeUploadChunk(
  uploadId: string,
  chunkIndex: number,
  data: Buffer
): Promise<void> {
  const dir = getUploadChunksDir(uploadId);
  await fs.mkdir(dir, { recursive: true });
  const chunkPath = path.join(dir, `part_${String(chunkIndex).padStart(6, '0')}`);
  await fs.writeFile(chunkPath, data);
}

export async function assembleUploadChunks(
  uploadId: string,
  totalChunks: number,
  destStorageKey: string
): Promise<string> {
  await ensureStorageDirs();
  const dir = getUploadChunksDir(uploadId);
  const destPath = getMediaFilePath(destStorageKey);

  const handle = await fs.open(destPath, 'w');
  try {
    for (let i = 0; i < totalChunks; i += 1) {
      const partPath = path.join(dir, `part_${String(i).padStart(6, '0')}`);
      const buf = await fs.readFile(partPath);
      await handle.write(buf);
    }
  } finally {
    await handle.close();
  }

  await fs.rm(dir, { recursive: true, force: true });
  return destPath;
}

export async function cleanupUploadChunks(uploadId: string): Promise<void> {
  const dir = getUploadChunksDir(uploadId);
  await fs.rm(dir, { recursive: true, force: true });
}
