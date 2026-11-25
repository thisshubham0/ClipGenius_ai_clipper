import express, { Router } from 'express';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { SAMPLE_DEMO_PROJECT } from '../../src/data/demoProject';
import { buildDefaultClipVersions } from '../../src/lib/clipVersions';
import { buildCaptionTrackCues } from '../../src/lib/editorEngine';
import { SCORE_DISCLAIMER } from '../../src/lib/scoring';
import {
  ALLOWED_VIDEO_EXTENSIONS,
  DEFAULT_MAX_UPLOAD_BYTES,
  extractFileExtension,
  validateAuthForm,
  validateImportUrl,
  validateVideoFile,
} from '../../src/lib/validation';
import type {
  AspectRatio,
  BrandKit,
  Clip,
  ClipDurationPreset,
  Project,
  SocialExportPreset,
  SystemConfigStatus,
} from '../../src/types/clipgenius';
import { isSqlConfigured } from '../../src/db/index.ts';
import {
  countCompletedExportsForOwner,
  createEmailPasswordUser,
  deleteProjectForOwner,
  findUserByEmail,
  getBrandKitForOwner,
  listProjectsForOwner,
  saveBrandKitForOwner,
  upsertClipForOwner,
  upsertExportJobForOwner,
  upsertProjectWithClips,
} from '../../src/db/repository.ts';
import {
  optionalAuth,
  requireAuth,
  type AuthRequest,
} from '../../src/middleware/auth.ts';
import {
  hashPassword,
  signAppSessionToken,
  verifyPassword,
} from '../auth/passwordSession';
import {
  extractAudioWaveformPeaks,
  generateDemoClipMp4,
  generateVideoThumbnail,
  renderClipSegmentSourceMp4,
  transcodePreviewIfNeeded,
} from '../media/ffmpegThumb';
import { isBrowserNativeVideo, probeVideoFile } from '../media/ffprobe';
import {
  buildCaptionTranslationPrompt,
  getCaptionLanguageLabel,
  mergeTranslatedCuesWithTimings,
  normalizeCaptionLanguageCode,
} from '../../src/lib/captionLanguages';
import {
  normalizeExportContainerFormat,
  normalizeExportQuality,
} from '../../src/lib/exportFormats';
import {
  enqueueBatchZipExport,
  enqueueSingleClipExport,
  getExportRecord,
  listExportJobs,
  renderClipToMp4,
  resolveExportArtifactFromDisk,
  retryExportJob,
} from '../media/renderQueue';
import { ensureSoundtrackFile, isValidSoundtrackId } from '../media/soundtracks';
import {
  canAccessWorkspaceResource,
  createRateLimitMiddleware,
} from '../middleware/security';
import {
  clearPipelineCache,
  detectClipSpeechAndSubtitles,
  getRawVideoPathForProject,
  runProjectAnalysisPipeline,
  subscribeProjectUpdates,
} from '../pipeline/analyzer';
import {
  assembleUploadChunks,
  cleanupUploadChunks,
  ensureStorageDirs,
  getMediaFilePath,
  parseHttpRange,
  sanitizeStorageKey,
  signClipPreviewParams,
  signMediaUrl,
  verifyClipPreviewSignature,
  verifyExportSignature,
  verifyMediaSignature,
  writeUploadChunk,
} from '../storage/storageAdapter';

const execFileAsync = promisify(execFile);

let cachedFfmpegAvailable: boolean | null = null;
let cachedYtDlpAvailable: boolean | null = null;

async function checkFfmpegAvailable(): Promise<boolean> {
  if (cachedFfmpegAvailable !== null) {
    return cachedFfmpegAvailable;
  }
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 1500 });
    cachedFfmpegAvailable = true;
  } catch {
    cachedFfmpegAvailable = false;
  }
  return cachedFfmpegAvailable;
}

async function checkYtDlpAvailable(): Promise<boolean> {
  if (cachedYtDlpAvailable !== null) {
    return cachedYtDlpAvailable;
  }
  try {
    await execFileAsync('yt-dlp', ['--version'], { timeout: 1500 });
    cachedYtDlpAvailable = true;
  } catch {
    cachedYtDlpAvailable = false;
  }
  return cachedYtDlpAvailable;
}

export function createGeminiServerClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

interface UploadSession {
  uploadId: string;
  filename: string;
  extension: string;
  mimeType: string;
  fileSizeBytes: number;
  chunkSizeBytes: number;
  totalChunks: number;
  receivedChunks: Set<number>;
  createdAt: number;
}

const CHUNK_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB chunks
const uploadSessions = new Map<string, UploadSession>();
const projectsStore: Project[] = [
  {
    ...SAMPLE_DEMO_PROJECT,
    clips: SAMPLE_DEMO_PROJECT.clips.map((c) => ({ ...c })),
  },
];

const DEMO_IMAGE_MAP: Record<string, string> = {
  demo_clip_1: 'src/assets/images/clip_podcast_founder_1794996401712.jpg',
  demo_clip_2: 'src/assets/images/clip_creator_keynote_1794996401709.jpg',
  demo_clip_3: 'src/assets/images/clip_studio_interview_1794996403009.jpg',
};

const CLIP_PATCH_ALLOWED_FIELDS = [
  'title',
  'startSec',
  'endSec',
  'aspectRatio',
  'cropOffsetX',
  'autoSpeakerTracking',
  'autoZoom',
  'cropKeyframes',
  'backgroundBlurFill',
  'backgroundStyle',
  'soundtrackId',
  'soundtrackVolume',
  'versions',
  'activeVersionId',
  'isAiRecommended',
  'recommendationReason',
  'removeSilences',
  'removeFillers',
  'captionStyle',
  'captionOverrides',
  'captionText',
  'captionTextEdited',
  'subtitleLanguage',
  'wordsLanguage',
  'translatedCues',
  'words',
] as const;

const inFlightPreviewRenders = new Map<string, Promise<string>>();

async function fileExistsNonEmpty(filePath: string): Promise<boolean> {
  try {
    const st = await fs.stat(filePath);
    return st.size > 0;
  } catch {
    return false;
  }
}

/**
 * Re-signs local media URLs with the active server secret (surviving restarts),
 * verifies whether the source media file still exists on local container storage,
 * and computes browserPlayable so x265 10-bit / MKV files automatically route
 * through our on-demand H.264 clip segment transcoder.
 */
async function hydrateProjectMedia(project: Project): Promise<Project> {
  if (project.isDemo) {
    return project;
  }

  const video = project.video;
  const candidateKeys = [video.storageKey, video.rawStorageKey].filter(
    (k): k is string => Boolean(k && k.trim())
  );

  let activeKey: string | undefined;
  for (const key of candidateKeys) {
    const abs = getMediaFilePath(key);
    if (await fileExistsNonEmpty(abs)) {
      activeKey = key;
      break;
    }
  }

  const hasVideoFile = Boolean(activeKey);
  video.mediaUnavailable = !hasVideoFile;
  video.previewAuthQuery = signClipPreviewParams(project.id, 7200);

  if (activeKey) {
    video.storageKey = activeKey;
    video.previewVideoUrl = signMediaUrl(activeKey, 7200);
    const isProxy = activeKey.startsWith('proxy_');
    video.browserPlayable =
      isProxy ||
      isBrowserNativeVideo({
        ext: path.extname(activeKey),
        codec: video.codec,
        pixelFormat: video.pixelFormat,
      });
  } else {
    video.browserPlayable = false;
  }

  // Re-sign thumbnail if it exists on disk
  const baseMatch = (video.rawStorageKey || video.storageKey || '').match(
    /^(?:raw|proxy|url)_(.+?)\.[^.]+$/
  );
  if (baseMatch?.[1]) {
    const thumbKey = sanitizeStorageKey(`thumb_${baseMatch[1]}.jpg`);
    if (await fileExistsNonEmpty(getMediaFilePath(thumbKey))) {
      const freshThumb = signMediaUrl(thumbKey, 7200);
      video.thumbnailUrl = freshThumb;
      for (const clip of project.clips) {
        if (!clip.thumbnailUrl || clip.thumbnailUrl.includes(thumbKey)) {
          clip.thumbnailUrl = freshThumb;
        }
      }
    }
  }

  return project;
}

async function streamFileWithRange(
  req: express.Request,
  res: express.Response,
  filePath: string,
  contentType: string,
  options?: { cacheControl?: string; contentDisposition?: string }
): Promise<void> {
  const stat = await fs.stat(filePath);
  const total = stat.size;
  const range = parseHttpRange(req.headers.range, total);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', options?.cacheControl ?? 'private, max-age=3600');
  if (options?.contentDisposition) {
    res.setHeader('Content-Disposition', options.contentDisposition);
  }

  if (range) {
    const chunkSize = range.end - range.start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${total}`);
    res.setHeader('Content-Length', String(chunkSize));
    createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
    return;
  }

  res.setHeader('Content-Length', String(total));
  createReadStream(filePath).pipe(res);
}

function buildInitialEditableClip(params: {
  projectId: string;
  title: string;
  durationSec: number;
  thumbnailUrl: string;
  width: number;
  height: number;
}): Clip {
  const safeDuration = Math.max(5, Math.min(45, Math.round(params.durationSec || 30)));
  const defaultAspect: AspectRatio = '9:16';
  const versions = buildDefaultClipVersions({
    aspectRatio: defaultAspect,
    preferFramedBackground: params.width > params.height,
  });
  const v1 = versions[0];
  return {
    id: `clip_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    projectId: params.projectId,
    title: `${params.title} (Analyzing Best Moments...)`,
    startSec: 0,
    endSec: safeDuration,
    aspectRatio: v1.aspectRatio,
    cropOffsetX: 50,
    autoSpeakerTracking: false,
    autoZoom: Boolean(v1.autoZoom),
    backgroundBlurFill: v1.backgroundStyle === 'blur_fill',
    backgroundStyle: v1.backgroundStyle,
    soundtrackId: v1.soundtrackId,
    soundtrackVolume: v1.soundtrackVolume,
    versions,
    activeVersionId: v1.id,
    isAiRecommended: false,
    recommendationReason:
      'Temporary preview while AI scans the full video audio to recommend your best moments.',
    captionStyle: v1.captionStyle,
    captionOverrides: v1.captionOverrides ? { ...v1.captionOverrides } : {},
    captionText: '',
    captionTextEdited: false,
    thumbnailUrl: params.thumbnailUrl,
    speaker: 'Original Audio',
    score: {
      id: `score_${Date.now()}`,
      clipId: '',
      overallEstimate: 0,
      disclaimer: SCORE_DISCLAIMER,
      summary:
        'AI analysis scans the entire video audio (speech + laughing, singing, humming, crying & ambient sounds) to pick distinct best moments and recommend ranked clips.',
      criteria: [],
    },
    metadata: {
      primaryTitle: params.title,
      alternativeTitles: [
        'AI analysis will generate ranked title alternatives',
      ],
      description: 'Uploaded source master verified via FFprobe.',
      hooks: ['AI analysis will extract top hooks from the video audio'],
      hashtags: ['#ShortVideo'],
      platformCaptions: {
        tiktok: 'Run AI Highlight Analysis for TikTok copy.',
        reels: 'Run AI Highlight Analysis for Reels copy.',
        shorts: 'Run AI Highlight Analysis for Shorts copy.',
        linkedin: 'Run AI Highlight Analysis for LinkedIn copy.',
      },
    },
    words: [],
  };
}

function getMimeTypeForKey(storageKey: string): string {
  const ext = path.extname(storageKey).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.mkv') return 'video/x-matroska';
  return 'video/mp4';
}

export function createApiRouter(): Router {
  const router = Router();
  const computeRateLimiter = createRateLimitMiddleware({
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: 'compute',
  });
  const authRateLimiter = createRateLimitMiddleware({
    windowMs: 60_000,
    maxRequests: 20,
    keyPrefix: 'auth',
  });

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'clipgenius-api',
      phase: 'Phase 6 — Production Persistence, Google Auth & Security Hardening',
      timestamp: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()),
    });
  });

  router.get('/config/status', async (_req, res) => {
    const ffmpegAvailable = await checkFfmpegAvailable();
    const geminiConfigured = Boolean(
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
    );

    const status: SystemConfigStatus = {
      environment: process.env.NODE_ENV || 'development',
      geminiConfigured,
      ffmpegAvailable,
      objectStorageConfigured: true,
      databaseConfigured: isSqlConfigured(),
      redisQueueConfigured: Boolean(process.env.REDIS_URL),
      googleOAuthConfigured: true,
      activePhase: 'Phase 6 — Production Persistence, Google Auth & Security Hardening',
    };

    res.json(status);
  });

  // Phase 6: Authenticated profile, Brand Kit & usage sync
  router.get('/me', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      const [brandKit, persistedExportsCount] = await Promise.all([
        getBrandKitForOwner(uid),
        countCompletedExportsForOwner(uid),
      ]);
      const memCompleted = listExportJobs().filter((j) => j.status === 'completed').length;
      res.json({
        user: req.dbUser,
        brandKit,
        exportsCompleted: Math.max(persistedExportsCount, memCompleted),
      });
    } catch (error) {
      console.error('Error loading authenticated profile:', error);
      res.status(500).json({ error: 'Unable to load workspace profile right now.' });
    }
  });

  router.get('/brand-kit', requireAuth, async (req: AuthRequest, res) => {
    try {
      const brandKit = await getBrandKitForOwner(req.user!.uid);
      res.json({ brandKit });
    } catch (error) {
      console.error('Error loading Brand Kit:', error);
      res.status(500).json({ error: 'Unable to load Brand Kit settings.' });
    }
  });

  router.put('/brand-kit', requireAuth, async (req: AuthRequest, res) => {
    const body = (req.body ?? {}) as Partial<BrandKit>;
    if (!body.name || typeof body.name !== 'string') {
      res.status(400).json({ error: 'Brand Kit name is required.' });
      return;
    }

    const kitToSave: BrandKit = {
      id: body.id || 'bk_user',
      name: body.name.trim().slice(0, 80),
      primaryColor: String(body.primaryColor || '#0B0D11'),
      accentColor: String(body.accentColor || '#F59E0B'),
      fontDisplay: String(body.fontDisplay || 'Outfit'),
      defaultCaptionPreset: (body.defaultCaptionPreset || 'modern_animated') as BrandKit['defaultCaptionPreset'],
      watermarkPosition: (body.watermarkPosition || 'top_right') as BrandKit['watermarkPosition'],
      watermarkText: String(body.watermarkText || '').trim().slice(0, 48),
    };

    try {
      const saved = await saveBrandKitForOwner(req.user!.uid, kitToSave);
      res.json({ ok: true, brandKit: saved });
    } catch (error) {
      console.error('Error saving Brand Kit:', error);
      res.status(500).json({ error: 'Unable to persist Brand Kit settings.' });
    }
  });

  router.get('/projects', optionalAuth, async (req: AuthRequest, res) => {
    const actorUid = req.user?.uid;
    const demoProjects = projectsStore.filter((p) => p.isDemo);

    if (!actorUid) {
      const guestLocal = projectsStore.filter(
        (p) => !p.isDemo && p.ownerId === 'session_preview_user'
      );
      const hydrated = await Promise.all([...guestLocal, ...demoProjects].map(hydrateProjectMedia));
      res.json({ projects: hydrated });
      return;
    }

    try {
      const persisted = await listProjectsForOwner(actorUid);
      // Merge persisted DB projects into in-memory lookup store for fast editor/SSE/render access
      for (const proj of persisted) {
        if (!projectsStore.some((existing) => existing.id === proj.id)) {
          projectsStore.unshift(proj);
        }
      }
      const inMemoryOwned = projectsStore.filter(
        (p) => !p.isDemo && p.ownerId === actorUid && !persisted.some((d) => d.id === p.id)
      );
      const combined = [...inMemoryOwned, ...persisted, ...demoProjects];
      const hydrated = await Promise.all(combined.map(hydrateProjectMedia));
      res.json({
        projects: hydrated,
      });
    } catch (error) {
      console.error('Failed to query projects from PostgreSQL:', error);
      const fallbackOwned = projectsStore.filter(
        (p) => p.isDemo || p.ownerId === actorUid
      );
      const hydrated = await Promise.all(fallbackOwned.map(hydrateProjectMedia));
      res.json({ projects: hydrated });
    }
  });

  router.get('/projects/:id', optionalAuth, async (req: AuthRequest, res) => {
    const found = projectsStore.find((p) => p.id === req.params.id);
    if (!found) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const allowed =
      found.isDemo ||
      found.ownerId === 'session_preview_user' ||
      canAccessWorkspaceResource({
        resourceOwnerUid: found.ownerId,
        actorUid: req.user?.uid,
        actorRole: req.dbUser?.role,
        isDemo: found.isDemo,
      });
    if (!allowed) {
      res.status(403).json({ error: 'Forbidden: You do not have access to this project.' });
      return;
    }
    await hydrateProjectMedia(found);
    res.json({ project: found });
  });

  router.delete('/projects/:id', optionalAuth, async (req: AuthRequest, res) => {
    const idx = projectsStore.findIndex((p) => p.id === req.params.id);
    const project = idx >= 0 ? projectsStore[idx] : undefined;

    if (project?.isDemo) {
      res.status(400).json({ error: 'Cannot delete the Sample Demo Project.' });
      return;
    }

    if (project) {
      const allowed =
        project.ownerId === 'session_preview_user' ||
        canAccessWorkspaceResource({
          resourceOwnerUid: project.ownerId,
          actorUid: req.user?.uid,
          actorRole: req.dbUser?.role,
        });
      if (!allowed) {
        res.status(403).json({ error: 'Forbidden: Cannot delete another user’s project.' });
        return;
      }
      projectsStore.splice(idx, 1);
    }

    clearPipelineCache(req.params.id);

    if (req.user?.uid) {
      try {
        await deleteProjectForOwner(req.user.uid, req.params.id);
      } catch (error) {
        console.error('Error deleting project from PostgreSQL:', error);
      }
    }

    if (!project && !req.user?.uid) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    res.json({ ok: true });
  });

  router.post('/auth/register', authRateLimiter, async (req, res) => {
    const body = (req.body ?? {}) as {
      name?: unknown;
      email?: unknown;
      password?: unknown;
      confirmPassword?: unknown;
    };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const confirmPassword =
      typeof body.confirmPassword === 'string' ? body.confirmPassword : undefined;

    const check = validateAuthForm('signup', { email, password, name });
    if (!check.valid) {
      res.status(400).json({ error: check.error });
      return;
    }

    if (password.length > 128) {
      res.status(400).json({ error: 'Password must be 128 characters or fewer.' });
      return;
    }

    if (confirmPassword !== undefined && confirmPassword !== password) {
      res.status(400).json({ error: 'Passwords do not match.' });
      return;
    }

    if (!isSqlConfigured()) {
      res.status(503).json({
        error: 'Account registration is temporarily unavailable. Please try again shortly.',
      });
      return;
    }

    try {
      const existing = await findUserByEmail(email);
      if (existing) {
        if (existing.authProvider === 'google' && !existing.passwordHash) {
          res.status(409).json({
            code: 'GOOGLE_ACCOUNT_EXISTS',
            error:
              'An account with this email already exists via Google Sign-In. Please continue with Google.',
          });
          return;
        }
        res.status(409).json({
          code: 'ACCOUNT_EXISTS',
          error: 'An account with this email already exists. Please sign in instead.',
        });
        return;
      }

      const passwordHash = await hashPassword(password);
      const createdUser = await createEmailPasswordUser({
        email,
        name: name.slice(0, 80),
        passwordHash,
      });

      const token = signAppSessionToken({
        uid: createdUser.id,
        email: createdUser.email,
        name: createdUser.name,
        role: createdUser.role ?? 'creator',
      });

      res.status(201).json({
        ok: true,
        token,
        user: createdUser,
        brandKit: null,
        exportsCompleted: 0,
      });
    } catch (error) {
      console.error('Error registering email/password account:', error);
      res.status(500).json({ error: 'Unable to create your account right now. Please try again.' });
    }
  });

  router.post('/auth/login', authRateLimiter, async (req, res) => {
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const check = validateAuthForm('signin', { email, password });
    if (!check.valid) {
      res.status(400).json({ error: check.error });
      return;
    }

    if (!isSqlConfigured()) {
      res.status(503).json({
        error: 'Sign-in is temporarily unavailable. Please try again shortly.',
      });
      return;
    }

    try {
      const existing = await findUserByEmail(email);
      if (!existing) {
        res.status(401).json({ error: 'Invalid email or password.' });
        return;
      }

      if (!existing.passwordHash) {
        res.status(401).json({
          code: 'GOOGLE_ACCOUNT_ONLY',
          error:
            'This email is registered with Google Sign-In. Please click "Continue with Google" to sign in.',
        });
        return;
      }

      const passwordMatches = await verifyPassword(password, existing.passwordHash);
      if (!passwordMatches) {
        res.status(401).json({ error: 'Invalid email or password.' });
        return;
      }

      const token = signAppSessionToken({
        uid: existing.user.id,
        email: existing.user.email,
        name: existing.user.name,
        role: existing.user.role ?? 'creator',
      });

      const [brandKit, persistedExportsCount] = await Promise.all([
        getBrandKitForOwner(existing.user.id),
        countCompletedExportsForOwner(existing.user.id),
      ]);

      res.json({
        ok: true,
        token,
        user: existing.user,
        brandKit,
        exportsCompleted: persistedExportsCount,
      });
    } catch (error) {
      console.error('Error signing in with email/password:', error);
      res.status(500).json({ error: 'Unable to sign in right now. Please try again.' });
    }
  });

  // Phase 2: Initialize chunked/resumable upload
  router.post('/uploads/init', async (req, res) => {
    const { filename = '', fileSizeBytes = 0, mimeType = '' } = req.body ?? {};
    const check = validateVideoFile(
      {
        name: String(filename),
        size: Number(fileSizeBytes),
        type: String(mimeType),
      },
      DEFAULT_MAX_UPLOAD_BYTES
    );

    if (!check.valid) {
      res.status(400).json({ error: check.error });
      return;
    }

    await ensureStorageDirs();
    const uploadId = `upl_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const totalChunks = Math.max(1, Math.ceil(Number(fileSizeBytes) / CHUNK_SIZE_BYTES));

    uploadSessions.set(uploadId, {
      uploadId,
      filename: String(filename),
      extension: check.extension || '.mp4',
      mimeType: String(mimeType || 'video/mp4'),
      fileSizeBytes: Number(fileSizeBytes),
      chunkSizeBytes: CHUNK_SIZE_BYTES,
      totalChunks,
      receivedChunks: new Set<number>(),
      createdAt: Date.now(),
    });

    res.json({
      uploadId,
      chunkSizeBytes: CHUNK_SIZE_BYTES,
      totalChunks,
    });
  });

  // Phase 2: Receive binary chunk
  router.put(
    '/uploads/:uploadId/chunk/:index',
    express.raw({ type: 'application/octet-stream', limit: '12mb' }),
    async (req, res) => {
      const session = uploadSessions.get(req.params.uploadId);
      if (!session) {
        res.status(404).json({ error: 'Upload session not found or expired.' });
        return;
      }

      const chunkIndex = Number(req.params.index);
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= session.totalChunks) {
        res.status(400).json({ error: 'Invalid chunk index.' });
        return;
      }

      const buf = req.body as Buffer;
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        res.status(400).json({ error: 'Empty chunk payload.' });
        return;
      }

      await writeUploadChunk(session.uploadId, chunkIndex, buf);
      session.receivedChunks.add(chunkIndex);

      res.json({
        ok: true,
        chunkIndex,
        receivedCount: session.receivedChunks.size,
        totalChunks: session.totalChunks,
      });
    }
  );

  // Phase 2: Cancel & cleanup chunked upload
  router.delete('/uploads/:uploadId', async (req, res) => {
    const uploadId = req.params.uploadId;
    uploadSessions.delete(uploadId);
    await cleanupUploadChunks(uploadId);
    res.json({ ok: true });
  });

  // Phase 2/6: Complete upload -> assemble -> FFprobe -> thumbnail -> proxy -> persist Project
  router.post('/uploads/:uploadId/complete', optionalAuth, async (req: AuthRequest, res) => {
    const session = uploadSessions.get(req.params.uploadId);
    if (!session) {
      res.status(404).json({ error: 'Upload session not found.' });
      return;
    }

    if (session.receivedChunks.size < session.totalChunks) {
      res.status(400).json({
        error: `Upload incomplete (${session.receivedChunks.size}/${session.totalChunks} chunks received).`,
      });
      return;
    }

    const baseId = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const rawKey = sanitizeStorageKey(`raw_${baseId}${session.extension}`);

    let rawFilePath: string;
    try {
      rawFilePath = await assembleUploadChunks(session.uploadId, session.totalChunks, rawKey);
    } catch {
      res.status(500).json({ error: 'Failed to assemble uploaded file chunks.' });
      return;
    } finally {
      uploadSessions.delete(session.uploadId);
    }

    const probe = await probeVideoFile(rawFilePath, session.fileSizeBytes);
    if (!probe.valid) {
      await fs.rm(rawFilePath, { force: true });
      res.status(400).json({
        error: probe.error ?? 'FFprobe rejected file: no valid video stream found.',
      });
      return;
    }

    const thumbKey = sanitizeStorageKey(`thumb_${baseId}.jpg`);
    const thumbPath = getMediaFilePath(thumbKey);
    const thumbOk = await generateVideoThumbnail(rawFilePath, thumbPath, probe.durationSec);

    const proxyKey = sanitizeStorageKey(`proxy_${baseId}.mp4`);
    const proxyPath = getMediaFilePath(proxyKey);
    const createdProxy = await transcodePreviewIfNeeded(
      rawFilePath,
      proxyPath,
      session.extension,
      probe.codec,
      probe.pixelFormat,
      probe.audioCodec,
      probe.durationSec
    );

    const waveformPeaks = await extractAudioWaveformPeaks(rawFilePath, 48);

    const previewKey = createdProxy ? proxyKey : rawKey;
    const browserPlayable =
      createdProxy ||
      isBrowserNativeVideo({
        ext: session.extension,
        codec: probe.codec,
        pixelFormat: probe.pixelFormat,
        audioCodec: probe.audioCodec,
      });
    const previewVideoUrl = signMediaUrl(previewKey, 7200);
    const thumbnailUrl = thumbOk ? signMediaUrl(thumbKey, 7200) : '';

    const projectId = `proj_${baseId}`;
    const cleanTitle = session.filename.replace(/\.[^.]+$/, '');
    const ownerUid = req.user?.uid ?? 'session_preview_user';
    const initialClip = buildInitialEditableClip({
      projectId,
      title: cleanTitle,
      durationSec: probe.durationSec,
      thumbnailUrl,
      width: probe.width,
      height: probe.height,
    });

    const geminiClient = createGeminiServerClient();
    const bodyObj = (req.body ?? {}) as { autoAnalyze?: boolean; targetDuration?: number };
    const shouldAutoAnalyze = Boolean(geminiClient) && bodyObj.autoAnalyze !== false;
    const requestedTargetDur = ([15, 30, 45, 60, 90] as const).includes(
      Number(bodyObj.targetDuration) as ClipDurationPreset
    )
      ? (Number(bodyObj.targetDuration) as ClipDurationPreset)
      : 30;

    const project: Project = {
      id: projectId,
      ownerId: ownerUid,
      title: cleanTitle,
      createdAt: new Date().toISOString(),
      status: shouldAutoAnalyze ? 'processing' : 'ready',
      isDemo: false,
      video: {
        id: `vid_${baseId}`,
        projectId,
        sourceType: 'upload',
        filename: session.filename,
        mimeType: session.mimeType,
        fileSizeBytes: probe.fileSizeBytes || session.fileSizeBytes,
        durationSec: probe.durationSec,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        codec: probe.codec,
        pixelFormat: probe.pixelFormat,
        browserPlayable,
        mediaUnavailable: false,
        previewAuthQuery: signClipPreviewParams(projectId, 7200),
        thumbnailUrl,
        previewVideoUrl,
        waveformPeaks,
        ffprobeVerified: true,
        storageKey: previewKey,
        rawStorageKey: rawKey,
      },
      processingStages: [
        {
          id: `stg_probe_${baseId}`,
          projectId,
          stage: 'audio_extract',
          status: shouldAutoAnalyze ? 'running' : 'queued',
          progressPct: shouldAutoAnalyze ? 15 : 0,
          message: shouldAutoAnalyze
            ? 'Analyzing full video audio to detect speech, sounds & best moments...'
            : `FFprobe verified ${probe.width}x${probe.height} @ ${probe.fps}fps (${probe.codec}) · Ready for AI analysis`,
          updatedAt: new Date().toISOString(),
        },
        {
          id: `stg_transcribe_${baseId}`,
          projectId,
          stage: 'transcription',
          status: geminiClient ? 'queued' : 'requires_configuration',
          progressPct: 0,
          message: geminiClient
            ? 'Queued — transcribing speech & classifying laughing, singing, humming, crying & ambient sounds'
            : 'Requires GEMINI_API_KEY in server environment to run audio analysis',
          updatedAt: new Date().toISOString(),
        },
      ],
      clips: [initialClip],
    };

    projectsStore.unshift(project);
    const persistOwnerUid = req.user?.uid;
    if (persistOwnerUid) {
      try {
        await upsertProjectWithClips(persistOwnerUid, project);
      } catch (error) {
        console.error('Failed to persist uploaded project:', error);
      }
    }

    const requestedCaptionLang = normalizeCaptionLanguageCode(
      req.body?.captionLanguage ?? 'en'
    );

    if (shouldAutoAnalyze && geminiClient) {
      void runProjectAnalysisPipeline({
        project,
        rawVideoPath: rawFilePath,
        aiClient: geminiClient,
        targetClipDurationSec: requestedTargetDur,
        captionLanguage: requestedCaptionLang,
        resume: false,
      }).finally(() => {
        if (persistOwnerUid) {
          void upsertProjectWithClips(persistOwnerUid, project).catch((err) => {
            console.error('Failed to persist auto-analyzed project to PostgreSQL:', err);
          });
        }
      });
    }

    res.json({ project, analysisStarted: shouldAutoAnalyze });
  });

  // Phase 2/6: Direct URL import (or honest yt-dlp configuration notice for YouTube/Vimeo)
  router.post('/uploads/import-url', optionalAuth, async (req: AuthRequest, res) => {
    const { sourceUrl = '', rightsConfirmed = false } = req.body ?? {};
    if (!rightsConfirmed) {
      res.status(400).json({
        error: 'Confirm content rights authorization before importing an external URL.',
      });
      return;
    }

    const urlStr = String(sourceUrl).trim();
    const check = validateImportUrl(urlStr);
    if (!check.valid) {
      res.status(400).json({ error: check.error });
      return;
    }

    const parsed = new URL(urlStr);
    const pathLower = parsed.pathname.toLowerCase();
    const isDirectFile = ALLOWED_VIDEO_EXTENSIONS.some((ext) => pathLower.endsWith(ext));

    if (!isDirectFile) {
      const hasYtDlp = await checkYtDlpAvailable();
      if (!hasYtDlp) {
        res.json({
          requiresConfiguration: true,
          message:
            'YouTube/Vimeo extraction requires yt-dlp installed on the worker host. Direct .mp4 / .mov / .webm / .mkv URLs are supported immediately.',
        });
        return;
      }
    }

    // Download direct video URL safely up to 250 MB
    await ensureStorageDirs();
    const baseId = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const ext = extractFileExtension(parsed.pathname) || '.mp4';
    const rawKey = sanitizeStorageKey(`url_${baseId}${ext}`);
    const rawFilePath = getMediaFilePath(rawKey);

    try {
      const response = await fetch(urlStr, { signal: AbortSignal.timeout(30000) });
      if (!response.ok || !response.body) {
        res.status(400).json({ error: `Remote server returned HTTP ${response.status}.` });
        return;
      }

      const contentLen = Number(response.headers.get('content-length') ?? 0);
      if (contentLen > 250 * 1024 * 1024) {
        res.status(400).json({ error: 'Remote direct URL exceeds 250 MB stream cap.' });
        return;
      }

      await pipeline(
        Readable.fromWeb(response.body as never),
        createWriteStream(rawFilePath)
      );
    } catch {
      await fs.rm(rawFilePath, { force: true });
      res.status(400).json({ error: 'Failed to download media from the provided URL.' });
      return;
    }

    const stat = await fs.stat(rawFilePath);
    const probe = await probeVideoFile(rawFilePath, stat.size);
    if (!probe.valid) {
      await fs.rm(rawFilePath, { force: true });
      res.status(400).json({
        error: probe.error ?? 'Downloaded URL did not contain a valid video stream.',
      });
      return;
    }

    const thumbKey = sanitizeStorageKey(`thumb_${baseId}.jpg`);
    const thumbOk = await generateVideoThumbnail(
      rawFilePath,
      getMediaFilePath(thumbKey),
      probe.durationSec
    );
    const proxyKey = sanitizeStorageKey(`proxy_${baseId}.mp4`);
    const createdProxy = await transcodePreviewIfNeeded(
      rawFilePath,
      getMediaFilePath(proxyKey),
      ext,
      probe.codec,
      probe.pixelFormat,
      probe.audioCodec,
      probe.durationSec
    );
    const waveformPeaks = await extractAudioWaveformPeaks(rawFilePath, 48);

    const previewKey = createdProxy ? proxyKey : rawKey;
    const browserPlayable =
      createdProxy ||
      isBrowserNativeVideo({
        ext,
        codec: probe.codec,
        pixelFormat: probe.pixelFormat,
        audioCodec: probe.audioCodec,
      });
    const previewVideoUrl = signMediaUrl(previewKey, 7200);
    const thumbnailUrl = thumbOk ? signMediaUrl(thumbKey, 7200) : '';
    const projectId = `proj_${baseId}`;
    const filename = path.basename(parsed.pathname) || `remote-video${ext}`;
    const cleanTitle = filename.replace(/\.[^.]+$/, '');
    const ownerUid = req.user?.uid ?? 'session_preview_user';

    const geminiClient = createGeminiServerClient();
    const urlBody = (req.body ?? {}) as { autoAnalyze?: boolean; targetDuration?: number };
    const shouldAutoAnalyze = Boolean(geminiClient) && urlBody.autoAnalyze !== false;
    const requestedTargetDur = ([15, 30, 45, 60, 90] as const).includes(
      Number(urlBody.targetDuration) as ClipDurationPreset
    )
      ? (Number(urlBody.targetDuration) as ClipDurationPreset)
      : 30;

    const project: Project = {
      id: projectId,
      ownerId: ownerUid,
      title: cleanTitle,
      createdAt: new Date().toISOString(),
      status: shouldAutoAnalyze ? 'processing' : 'ready',
      isDemo: false,
      video: {
        id: `vid_${baseId}`,
        projectId,
        sourceType: 'url',
        sourceUrl: urlStr,
        filename,
        mimeType: getMimeTypeForKey(previewKey),
        fileSizeBytes: probe.fileSizeBytes || stat.size,
        durationSec: probe.durationSec,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        codec: probe.codec,
        pixelFormat: probe.pixelFormat,
        browserPlayable,
        mediaUnavailable: false,
        previewAuthQuery: signClipPreviewParams(projectId, 7200),
        thumbnailUrl,
        previewVideoUrl,
        waveformPeaks,
        ffprobeVerified: true,
        storageKey: previewKey,
        rawStorageKey: rawKey,
      },
      processingStages: [
        {
          id: `stg_url_${baseId}`,
          projectId,
          stage: 'audio_extract',
          status: shouldAutoAnalyze ? 'running' : 'queued',
          progressPct: shouldAutoAnalyze ? 15 : 0,
          message: shouldAutoAnalyze
            ? 'Analyzing full video audio to detect speech, sounds & best moments...'
            : `Downloaded & FFprobe verified ${probe.width}x${probe.height} @ ${probe.fps}fps · Ready for AI analysis`,
          updatedAt: new Date().toISOString(),
        },
        {
          id: `stg_url_tr_${baseId}`,
          projectId,
          stage: 'transcription',
          status: geminiClient ? 'queued' : 'requires_configuration',
          progressPct: 0,
          message: geminiClient
            ? 'Queued — transcribing speech & classifying laughing, singing, humming, crying & ambient sounds'
            : 'Requires GEMINI_API_KEY in server environment to run transcription',
          updatedAt: new Date().toISOString(),
        },
      ],
      clips: [
        buildInitialEditableClip({
          projectId,
          title: cleanTitle,
          durationSec: probe.durationSec,
          thumbnailUrl,
          width: probe.width,
          height: probe.height,
        }),
      ],
    };

    projectsStore.unshift(project);
    const persistOwnerUid = req.user?.uid;
    if (persistOwnerUid) {
      try {
        await upsertProjectWithClips(persistOwnerUid, project);
      } catch (error) {
        console.error('Failed to persist imported URL project:', error);
      }
    }

    const requestedCaptionLang = normalizeCaptionLanguageCode(
      req.body?.captionLanguage ?? 'en'
    );

    if (shouldAutoAnalyze && geminiClient) {
      void runProjectAnalysisPipeline({
        project,
        rawVideoPath: rawFilePath,
        aiClient: geminiClient,
        targetClipDurationSec: requestedTargetDur,
        captionLanguage: requestedCaptionLang,
        resume: false,
      }).finally(() => {
        if (persistOwnerUid) {
          void upsertProjectWithClips(persistOwnerUid, project).catch((err) => {
            console.error('Failed to persist auto-analyzed URL project:', err);
          });
        }
      });
    }

    res.json({ project, analysisStarted: shouldAutoAnalyze });
  });

  // Backwards-compatible validation route
  router.post('/uploads/validate', (req, res) => {
    const { sourceType, filename, fileSizeBytes, mimeType, sourceUrl, rightsConfirmed } =
      req.body ?? {};

    if (sourceType === 'url') {
      if (!rightsConfirmed) {
        res.status(400).json({
          error: 'Confirm content rights authorization before importing an external URL.',
        });
        return;
      }
      const check = validateImportUrl(String(sourceUrl ?? ''));
      if (!check.valid) {
        res.status(400).json({ error: check.error });
        return;
      }
      res.json({ valid: true });
      return;
    }

    const check = validateVideoFile(
      {
        name: String(filename ?? ''),
        size: Number(fileSizeBytes ?? 0),
        type: String(mimeType ?? ''),
      },
      DEFAULT_MAX_UPLOAD_BYTES
    );

    if (!check.valid) {
      res.status(400).json({ error: check.error });
      return;
    }

    res.json({ valid: true, extension: check.extension });
  });

  // Phase 2: Signed media streaming with HTTP 206 Byte-Range support
  router.get('/media/:storageKey', async (req, res) => {
    const { storageKey } = req.params;
    const exp = typeof req.query.exp === 'string' ? req.query.exp : undefined;
    const sig = typeof req.query.sig === 'string' ? req.query.sig : undefined;

    if (!verifyMediaSignature(storageKey, exp, sig)) {
      res.status(403).json({ error: 'Invalid or expired media signature.' });
      return;
    }

    const filePath = getMediaFilePath(storageKey);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(filePath);
    } catch {
      res.status(404).json({ error: 'Media object not found.' });
      return;
    }

    const mimeType = getMimeTypeForKey(storageKey);
    const total = stat.size;
    const range = parseHttpRange(req.headers.range, total);

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');

    if (range) {
      const chunkSize = range.end - range.start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${total}`);
      res.setHeader('Content-Length', String(chunkSize));
      createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
      return;
    }

    res.setHeader('Content-Length', String(total));
    createReadStream(filePath).pipe(res);
  });

  // Playable MP4 preview stream for Sample Demo Project clips via FFmpeg
  router.get('/demo/video/:clipId', async (req, res) => {
    const relImage = DEMO_IMAGE_MAP[req.params.clipId];
    if (!relImage) {
      res.status(404).json({ error: 'Demo clip not found.' });
      return;
    }

    const imageAbs = path.resolve(process.cwd(), relImage);
    const outPath = getMediaFilePath(`${sanitizeStorageKey(req.params.clipId)}_preview.mp4`);
    const ok = await generateDemoClipMp4(imageAbs, outPath, 12);
    if (!ok) {
      res.status(404).json({ error: 'Demo video preview unavailable.' });
      return;
    }

    await streamFileWithRange(req, res, outPath, 'video/mp4', {
      cacheControl: 'public, max-age=86400',
    });
  });

  // Royalty-free synthesized studio soundtrack streaming (used by Live Edit <audio> & FFmpeg mixing)
  router.get('/soundtracks/:trackId', async (req, res) => {
    const trackId = String(req.params.trackId ?? '');
    if (!isValidSoundtrackId(trackId)) {
      res.status(404).json({ error: 'Soundtrack not found.' });
      return;
    }

    const outPath = await ensureSoundtrackFile(trackId);
    if (!outPath) {
      res.status(500).json({ error: 'Unable to synthesize studio soundtrack.' });
      return;
    }

    await streamFileWithRange(req, res, outPath, 'audio/mpeg', {
      cacheControl: 'public, max-age=86400',
    });
  });

  // On-demand browser-playable clip preview stream:
  //   ?mode=source -> fast H.264 yuv420p + stereo AAC transcode of [clip.startSec, clip.endSec]
  //                   (makes 10-bit x265 / HEVC / MKV / MOV clips play immediately in <video>)
  //   ?mode=edited -> actual FFmpeg-edited clip MP4 (trimmed, silence/filler-cut, aspect-reframed,
  //                   cropOffsetX, autoZoom, backgroundBlurFill, burned-in captions & watermark)
  router.get('/clips/:id/preview', optionalAuth, async (req: AuthRequest, res) => {
    const clipId = req.params.id;
    const mode = req.query.mode === 'edited' ? 'edited' : 'source';

    let foundProject: Project | undefined;
    let foundClip: Clip | undefined;
    for (const proj of projectsStore) {
      const c = proj.clips.find((item) => item.id === clipId);
      if (c) {
        foundProject = proj;
        foundClip = c;
        break;
      }
    }

    if (!foundProject || !foundClip) {
      res.status(404).json({ error: 'Clip not found.' });
      return;
    }

    const exp = typeof req.query.exp === 'string' ? req.query.exp : undefined;
    const sig = typeof req.query.sig === 'string' ? req.query.sig : undefined;
    const signedPreviewOk = verifyClipPreviewSignature(foundProject.id, exp, sig);

    const allowed =
      foundProject.isDemo ||
      foundProject.ownerId === 'session_preview_user' ||
      signedPreviewOk ||
      canAccessWorkspaceResource({
        resourceOwnerUid: foundProject.ownerId,
        actorUid: req.user?.uid,
        actorRole: req.dbUser?.role,
        isDemo: foundProject.isDemo,
      });
    if (!allowed) {
      res.status(403).json({ error: 'Forbidden: Cannot access another user’s clip preview.' });
      return;
    }

    await ensureStorageDirs();

    if (mode === 'source') {
      if (foundProject.isDemo) {
        const relImage = DEMO_IMAGE_MAP[foundClip.id] ?? DEMO_IMAGE_MAP.demo_clip_1;
        const imageAbs = path.resolve(process.cwd(), relImage);
        const outPath = getMediaFilePath(`${sanitizeStorageKey(foundClip.id)}_preview.mp4`);
        const ok = await generateDemoClipMp4(imageAbs, outPath, 12);
        if (!ok) {
          res.status(500).json({ error: 'Demo video preview unavailable.' });
          return;
        }
        await streamFileWithRange(req, res, outPath, 'video/mp4', {
          cacheControl: 'public, max-age=3600',
        });
        return;
      }

      const rawPath = getRawVideoPathForProject(foundProject);
      if (!rawPath || !(await fileExistsNonEmpty(rawPath))) {
        foundProject.video.mediaUnavailable = true;
        res.status(404).json({
          error: 'Source video file is no longer on temporary server disk. Please re-upload the video.',
          mediaUnavailable: true,
        });
        return;
      }

      const qStart = Number(req.query.s);
      const qEnd = Number(req.query.e);
      const startSec = Number.isFinite(qStart) && qStart >= 0 ? qStart : foundClip.startSec;
      const endSec =
        Number.isFinite(qEnd) && qEnd > startSec ? qEnd : foundClip.endSec;
      const durationSec = Math.max(2, Math.min(180, Number((endSec - startSec).toFixed(2))));

      const segHash = crypto
        .createHash('sha1')
        .update(`${foundProject.id}:${foundClip.id}:${startSec.toFixed(2)}:${durationSec.toFixed(2)}`)
        .digest('hex')
        .slice(0, 12);
      const outPath = getMediaFilePath(sanitizeStorageKey(`clipsrc_${segHash}.mp4`));

      try {
        let pending = inFlightPreviewRenders.get(outPath);
        if (!pending) {
          pending = (async () => {
            const ok = await renderClipSegmentSourceMp4({
              inputPath: rawPath,
              outputMp4Path: outPath,
              startSec,
              durationSec,
            });
            if (!ok) {
              throw new Error('FFmpeg could not transcode this clip segment for playback.');
            }
            return outPath;
          })();
          inFlightPreviewRenders.set(outPath, pending);
          void pending.finally(() => {
            inFlightPreviewRenders.delete(outPath);
          });
        }
        const readyPath = await pending;
        await streamFileWithRange(req, res, readyPath, 'video/mp4', {
          cacheControl: 'private, max-age=1800',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unable to prepare playable clip stream.';
        res.status(500).json({ error: msg });
      }
      return;
    }

    // mode === 'edited': render real FFmpeg-edited clip preview (trimmed, silence/filler cut,
    // aspect-reframed, cropped, autoZoom, blur fill, and burned-in captions/watermark)
    if (!foundProject.isDemo) {
      const rawPath = getRawVideoPathForProject(foundProject);
      if (!rawPath || !(await fileExistsNonEmpty(rawPath))) {
        foundProject.video.mediaUnavailable = true;
        res.status(404).json({
          error: 'Source video file is no longer on temporary server disk. Please re-upload the video.',
          mediaUnavailable: true,
        });
        return;
      }
    }

    const watermarkText =
      typeof req.query.wmText === 'string' ? req.query.wmText.slice(0, 48) : '';
    const watermarkPosition =
      req.query.wmPos === 'top_left' ||
      req.query.wmPos === 'top_right' ||
      req.query.wmPos === 'bottom_right' ||
      req.query.wmPos === 'none'
        ? req.query.wmPos
        : 'none';
    const burnCaptions = req.query.burn !== '0';

    const editSignature = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          projectId: foundProject.id,
          clipId: foundClip.id,
          activeVersionId: foundClip.activeVersionId ?? 'ver_1',
          startSec: foundClip.startSec,
          endSec: foundClip.endSec,
          aspectRatio: foundClip.aspectRatio,
          cropOffsetX: foundClip.cropOffsetX,
          autoZoom: Boolean(foundClip.autoZoom),
          backgroundBlurFill: foundClip.backgroundBlurFill,
          backgroundStyle: foundClip.backgroundStyle ?? (foundClip.backgroundBlurFill ? 'blur_fill' : 'fill_crop'),
          soundtrackId: foundClip.soundtrackId ?? 'none',
          soundtrackVolume: Number((foundClip.soundtrackVolume ?? 0.22).toFixed(2)),
          removeSilences: Boolean(foundClip.removeSilences),
          removeFillers: Boolean(foundClip.removeFillers),
          captionStyle: foundClip.captionStyle,
          captionOverrides: foundClip.captionOverrides ?? {},
          captionText: foundClip.captionText,
          captionTextEdited: Boolean(foundClip.captionTextEdited),
          subtitleLanguage: foundClip.subtitleLanguage ?? 'original',
          burnCaptions,
          watermarkText,
          watermarkPosition,
        })
      )
      .digest('hex')
      .slice(0, 16);

    const outPath = getMediaFilePath(sanitizeStorageKey(`edited_${editSignature}.mp4`));

    try {
      if (!(await fileExistsNonEmpty(outPath))) {
        let pending = inFlightPreviewRenders.get(outPath);
        if (!pending) {
          const projectRef = foundProject;
          const clipSnapshot: Clip = { ...foundClip };
          pending = (async () => {
            await renderClipToMp4({
              project: projectRef,
              clip: clipSnapshot,
              quality: '720p',
              aspectRatio: clipSnapshot.aspectRatio,
              burnCaptions,
              outputMp4Path: outPath,
              fastPreview: true,
              brandKit:
                watermarkPosition !== 'none' && watermarkText
                  ? { watermarkPosition, watermarkText }
                  : undefined,
            });
            return outPath;
          })();
          inFlightPreviewRenders.set(outPath, pending);
          void pending.finally(() => {
            inFlightPreviewRenders.delete(outPath);
          });
        }
        await pending;
      }

      await streamFileWithRange(req, res, outPath, 'video/mp4', {
        cacheControl: 'private, max-age=1800',
      });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Unable to render edited clip preview.';
      res.status(500).json({ error: msg });
    }
  });

  // Persist editor clip changes in workspace store + PostgreSQL
  router.patch('/clips/:id', optionalAuth, async (req: AuthRequest, res) => {
    const clipId = req.params.id;
    const patch = req.body ?? {};

    for (const proj of projectsStore) {
      const clip = proj.clips.find((c) => c.id === clipId);
      if (clip) {
        const allowed =
          proj.isDemo ||
          proj.ownerId === 'session_preview_user' ||
          canAccessWorkspaceResource({
            resourceOwnerUid: proj.ownerId,
            actorUid: req.user?.uid,
            actorRole: req.dbUser?.role,
            isDemo: proj.isDemo,
          });
        if (!allowed) {
          res.status(403).json({ error: 'Forbidden: Cannot edit another user’s clip.' });
          return;
        }
        for (const field of CLIP_PATCH_ALLOWED_FIELDS) {
          if (patch[field] !== undefined) {
            (clip as unknown as Record<string, unknown>)[field] = patch[field];
          }
        }
        if (req.user?.uid && !proj.isDemo) {
          try {
            await upsertClipForOwner(req.user.uid, clip);
          } catch (error) {
            console.error('Failed to persist clip edit to PostgreSQL:', error);
          }
        }
        res.json({ ok: true, clip });
        return;
      }
    }

    res.status(404).json({ error: 'Clip not found.' });
  });

  // Phase 4: Real server-side subtitle translation via Gemini (English, Hinglish, Hindi, & more)
  router.post('/clips/:id/translate', computeRateLimiter, optionalAuth, async (req: AuthRequest, res) => {
    const clipId = req.params.id;
    const { targetLanguage = 'hinglish', targetLanguageLabel } = req.body ?? {};

    let targetProject: Project | undefined;
    let targetClip: Clip | undefined;
    for (const proj of projectsStore) {
      const found = proj.clips.find((c) => c.id === clipId);
      if (found) {
        targetProject = proj;
        targetClip = found;
        break;
      }
    }

    if (!targetProject || !targetClip) {
      res.status(404).json({ error: 'Clip not found.' });
      return;
    }

    const allowed =
      targetProject.isDemo ||
      targetProject.ownerId === 'session_preview_user' ||
      canAccessWorkspaceResource({
        resourceOwnerUid: targetProject.ownerId,
        actorUid: req.user?.uid,
        actorRole: req.dbUser?.role,
        isDemo: targetProject.isDemo,
      });
    if (!allowed) {
      res.status(403).json({ error: 'Forbidden: Cannot translate another user’s clip.' });
      return;
    }

    const langCode = normalizeCaptionLanguageCode(targetLanguage);
    const langLabel =
      (typeof targetLanguageLabel === 'string' && targetLanguageLabel.trim()) ||
      getCaptionLanguageLabel(langCode);

    if (langCode === 'original') {
      targetClip.subtitleLanguage = 'original';
      if (req.user?.uid && !targetProject.isDemo) {
        await upsertClipForOwner(req.user.uid, targetClip).catch(() => {});
      }
      res.json({ ok: true, language: 'original', cues: [], clip: targetClip });
      return;
    }

    const geminiClient = createGeminiServerClient();
    if (!geminiClient) {
      res.json({
        requiresConfiguration: true,
        message:
          'Subtitle translation requires GEMINI_API_KEY configured in the server environment (Settings > Secrets).',
      });
      return;
    }

    const baseCues =
      targetClip.words.length > 0
        ? buildCaptionTrackCues({
            words: targetClip.words,
            startSec: targetClip.startSec,
            endSec: targetClip.endSec,
            wordsPerCue: 5,
          }).map((c) => ({ startSec: c.startSec, endSec: c.endSec, text: c.text }))
        : targetClip.captionText.trim().length > 0
          ? [
              {
                startSec: targetClip.startSec,
                endSec: Math.min(targetClip.endSec, targetClip.startSec + 6),
                text: targetClip.captionText.trim(),
              },
            ]
          : [];

    if (baseCues.length === 0) {
      res.status(400).json({ error: 'No subtitle cues available to translate.' });
      return;
    }

    const { systemInstruction, userPrompt } = buildCaptionTranslationPrompt({
      langCode,
      langLabel,
      cues: baseCues,
    });

    const modelsToTry = ['gemini-3.8-flash', 'gemini-3.1-flash-lite'];
    let lastError: unknown;

    for (const model of modelsToTry) {
      try {
        const response = await geminiClient.models.generateContent({
          model,
          contents: userPrompt,
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              required: ['cues'],
              properties: {
                cues: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    required: ['startSec', 'endSec', 'text'],
                    properties: {
                      startSec: { type: Type.NUMBER },
                      endSec: { type: Type.NUMBER },
                      text: { type: Type.STRING },
                    },
                  },
                },
              },
            },
          },
        });

        const parsed = JSON.parse((response.text ?? '{}').trim()) as {
          cues?: { startSec: number; endSec: number; text: string }[];
        };
        const modelCues = (parsed.cues ?? []).filter((c) => c.text && c.text.trim().length > 0);
        if (modelCues.length === 0) {
          throw new Error('Model returned empty translated cues.');
        }

        const translated = mergeTranslatedCuesWithTimings(baseCues, modelCues);

        targetClip.translatedCues = {
          ...(targetClip.translatedCues ?? {}),
          [langCode]: translated,
        };
        targetClip.subtitleLanguage = langCode;

        if (req.user?.uid && !targetProject.isDemo) {
          await upsertClipForOwner(req.user.uid, targetClip).catch((err) => {
            console.error('Failed to persist translated clip to PostgreSQL:', err);
          });
        }

        res.json({
          ok: true,
          language: langCode,
          cues: translated,
          clip: targetClip,
        });
        return;
      } catch (err) {
        lastError = err;
      }
    }

    const message = lastError instanceof Error ? lastError.message : 'Subtitle translation failed.';
    res.status(502).json({ error: message });
  });

  // On-demand vocal-enhanced voice detection & English (or Hinglish) subtitle sync for any clip
  router.post(
    '/clips/:id/transcribe',
    computeRateLimiter,
    optionalAuth,
    async (req: AuthRequest, res) => {
      const clipId = req.params.id;
      const requestedLang = normalizeCaptionLanguageCode(req.body?.targetLanguage ?? 'en');
      const targetLang = requestedLang === 'original' ? 'en' : requestedLang;

      let targetProject: Project | undefined;
      let targetClip: Clip | undefined;
      for (const proj of projectsStore) {
        const found = proj.clips.find((c) => c.id === clipId);
        if (found) {
          targetProject = proj;
          targetClip = found;
          break;
        }
      }

      if (!targetProject || !targetClip) {
        res.status(404).json({ error: 'Clip not found.' });
        return;
      }

      const allowed =
        targetProject.isDemo ||
        targetProject.ownerId === 'session_preview_user' ||
        canAccessWorkspaceResource({
          resourceOwnerUid: targetProject.ownerId,
          actorUid: req.user?.uid,
          actorRole: req.dbUser?.role,
          isDemo: targetProject.isDemo,
        });
      if (!allowed) {
        res.status(403).json({ error: 'Forbidden: Cannot transcribe another user’s clip.' });
        return;
      }

      // Demo project already includes synced English voice words
      if (targetProject.isDemo) {
        const cues = buildCaptionTrackCues({
          words: targetClip.words,
          startSec: targetClip.startSec,
          endSec: targetClip.endSec,
          wordsPerCue: 5,
        }).map((c) => ({ startSec: c.startSec, endSec: c.endSec, text: c.text }));

        targetClip.subtitleLanguage = targetLang;
        targetClip.wordsLanguage = targetLang;
        targetClip.translatedCues = {};
        res.json({
          ok: true,
          isDemo: true,
          language: targetLang,
          wordsLanguage: targetLang,
          words: targetClip.words,
          cues,
          captionText: targetClip.captionText,
          speechWordCount: targetClip.words.filter((w) => w.kind !== 'sound_event').length,
          soundEventCount: targetClip.words.filter((w) => w.kind === 'sound_event').length,
          clip: targetClip,
        });
        return;
      }

      const geminiClient = createGeminiServerClient();
      if (!geminiClient) {
        res.json({
          requiresConfiguration: true,
          message:
            'Voice detection requires GEMINI_API_KEY configured in the server environment (Settings > Secrets).',
        });
        return;
      }

      const rawVideoPath = getRawVideoPathForProject(targetProject);
      if (!rawVideoPath) {
        res.status(400).json({ error: 'No source video storage key found for this project.' });
        return;
      }

      try {
        await fs.access(rawVideoPath);
      } catch {
        res.status(400).json({
          error: 'Source video file is missing from local storage. Please re-upload the video.',
        });
        return;
      }

      try {
        const result = await detectClipSpeechAndSubtitles({
          project: targetProject,
          clip: targetClip,
          rawVideoPath,
          aiClient: geminiClient,
          targetLanguage: targetLang,
        });

        targetClip.words = result.words;
        targetClip.captionText = result.captionText;
        targetClip.captionTextEdited = false;
        targetClip.subtitleLanguage = result.language;
        targetClip.wordsLanguage = result.language;
        targetClip.speaker = result.speakers[0] || targetClip.speaker || 'Speaker 1';
        // Clear stale cached translations so exact word-level timestamps drive captions
        // and respond dynamically to Words / line & style changes.
        targetClip.translatedCues = {};

        // Replace words in this clip's [startSec, endSec] range and consolidate stale speakers
        const prevWordsOutsideClip = (targetProject.transcript?.words ?? []).filter(
          (w) => w.endSec <= targetClip.startSec || w.startSec >= targetClip.endSec
        );
        const mergedTranscriptWords = [...prevWordsOutsideClip, ...result.words].sort(
          (a, b) => a.startSec - b.startSec
        );
        targetProject.transcript = {
          id: targetProject.transcript?.id ?? `tr_${targetProject.id}`,
          videoId: targetProject.video.id,
          language: result.language,
          speakers: result.speakers,
          words: mergedTranscriptWords,
        };

        if (req.user?.uid && !targetProject.isDemo) {
          await upsertProjectWithClips(req.user.uid, targetProject).catch((err) => {
            console.error('Failed to persist transcribed project to PostgreSQL:', err);
          });
        }

        res.json({
          ok: true,
          language: result.language,
          wordsLanguage: result.language,
          words: result.words,
          cues: result.cues,
          captionText: result.captionText,
          speakers: result.speakers,
          speechWordCount: result.speechWordCount,
          soundEventCount: result.soundEventCount,
          clip: targetClip,
          transcript: targetProject.transcript,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unable to detect voice in this clip.';
        res.status(502).json({ error: message });
      }
    }
  );

  // Phase 3/6: Trigger idempotent, resumable 7-stage AI analysis pipeline + PostgreSQL sync
  router.post('/projects/:id/analyze', computeRateLimiter, optionalAuth, async (req: AuthRequest, res) => {
    const project = projectsStore.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    const allowed =
      project.isDemo ||
      project.ownerId === 'session_preview_user' ||
      canAccessWorkspaceResource({
        resourceOwnerUid: project.ownerId,
        actorUid: req.user?.uid,
        actorRole: req.dbUser?.role,
        isDemo: project.isDemo,
      });
    if (!allowed) {
      res.status(403).json({ error: 'Forbidden: Cannot analyze another user’s project.' });
      return;
    }

    if (project.isDemo) {
      res.json({
        requiresConfiguration: false,
        isDemo: true,
        message:
          'Sample Demo Project already contains illustrative clips and scores. Upload a real video in Create Clips to run the live 7-stage AI pipeline.',
      });
      return;
    }

    const geminiClient = createGeminiServerClient();
    if (!geminiClient) {
      res.json({
        requiresConfiguration: true,
        geminiConfigured: false,
        phase: 'Phase 3',
        message:
          'GEMINI_API_KEY is not configured in the server environment. Configure GEMINI_API_KEY in Secrets to enable transcription, speaker diarization, and highlight scoring.',
      });
      return;
    }

    const rawVideoPath = getRawVideoPathForProject(project);
    if (!rawVideoPath) {
      res.status(400).json({ error: 'No source video storage key found for this project.' });
      return;
    }

    try {
      await fs.access(rawVideoPath);
    } catch {
      res.status(400).json({
        error: 'Source video file is missing from local storage. Please re-upload the video.',
      });
      return;
    }

    const body = req.body ?? {};
    const requestedDur = Number(body.targetClipDurationSec ?? 30);
    const allowedDurations: readonly ClipDurationPreset[] = [15, 30, 45, 60, 90];
    const targetClipDurationSec: ClipDurationPreset = allowedDurations.includes(
      requestedDur as ClipDurationPreset
    )
      ? (requestedDur as ClipDurationPreset)
      : 30;
    const resume = body.resume !== false;
    const requestedCaptionLang = normalizeCaptionLanguageCode(
      body.captionLanguage ?? 'en'
    );
    const ownerUid = req.user?.uid;

    void runProjectAnalysisPipeline({
      project,
      rawVideoPath,
      aiClient: geminiClient,
      targetClipDurationSec,
      captionLanguage: requestedCaptionLang,
      resume,
    }).then(() => {
      if (ownerUid) {
        void upsertProjectWithClips(ownerUid, project).catch((err) => {
          console.error('Failed to sync analyzed project to PostgreSQL:', err);
        });
      }
    });

    res.json({
      ok: true,
      started: true,
      project,
    });
  });

  // Phase 3: Server-Sent Events stream for real-time project pipeline progress
  router.get('/projects/:id/events', (req, res) => {
    const project = projectsStore.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendSnapshot = (proj: Project) => {
      res.write(`event: project\ndata: ${JSON.stringify(proj)}\n\n`);
    };

    sendSnapshot(project);

    const unsubscribe = subscribeProjectUpdates(project.id, sendSnapshot);
    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);

    req.on('close', () => {
      unsubscribe();
      clearInterval(keepalive);
    });
  });

  // Phase 5/6: Enqueue single clip FFmpeg MP4 render with burned-in ASS captions & reframing
  router.post('/clips/:id/export', computeRateLimiter, optionalAuth, async (req: AuthRequest, res) => {
    const ffmpegAvailable = await checkFfmpegAvailable();
    if (!ffmpegAvailable) {
      res.json({
        requiresConfiguration: true,
        ffmpegAvailable: false,
        phase: 'Phase 5',
        message:
          'FFmpeg binary is not available on this server host. Install ffmpeg to enable MP4 rendering.',
      });
      return;
    }

    const clipId = req.params.id;
    let foundProject: Project | undefined;
    let foundClip: Clip | undefined;
    for (const proj of projectsStore) {
      const c = proj.clips.find((item) => item.id === clipId);
      if (c) {
        foundProject = proj;
        foundClip = c;
        break;
      }
    }

    if (!foundProject || !foundClip) {
      res.status(404).json({ error: 'Clip not found.' });
      return;
    }

    const allowed =
      foundProject.isDemo ||
      foundProject.ownerId === 'session_preview_user' ||
      canAccessWorkspaceResource({
        resourceOwnerUid: foundProject.ownerId,
        actorUid: req.user?.uid,
        actorRole: req.dbUser?.role,
        isDemo: foundProject.isDemo,
      });
    if (!allowed) {
      res.status(403).json({ error: 'Forbidden: Cannot export another user’s clip.' });
      return;
    }

    const body = req.body ?? {};

    // Apply any latest unsaved clip edits directly before rendering (prevents PATCH debounce races)
    if (body.clipPatch && typeof body.clipPatch === 'object') {
      const clipPatch = body.clipPatch as Record<string, unknown>;
      for (const field of CLIP_PATCH_ALLOWED_FIELDS) {
        if (clipPatch[field] !== undefined) {
          (foundClip as unknown as Record<string, unknown>)[field] = clipPatch[field];
        }
      }
      if (req.user?.uid && !foundProject.isDemo) {
        void upsertClipForOwner(req.user.uid, foundClip).catch(() => {});
      }
    }

    const quality = normalizeExportQuality(body.quality ?? '1080p');
    const containerFormat = normalizeExportContainerFormat(body.containerFormat);
    const burnCaptions = body.burnCaptions !== false;
    const allowedAspects: readonly AspectRatio[] = ['9:16', '16:9', '1:1', '4:5'];
    const aspectRatio: AspectRatio = allowedAspects.includes(body.aspectRatio)
      ? body.aspectRatio
      : foundClip.aspectRatio;
    const allowedPresets: readonly SocialExportPreset[] = [
      'tiktok',
      'reels',
      'shorts',
      'linkedin',
      'custom',
    ];
    const platformPreset: SocialExportPreset = allowedPresets.includes(body.platformPreset)
      ? body.platformPreset
      : 'custom';
    const ownerUid = req.user?.uid;

    const job = enqueueSingleClipExport({
      project: foundProject,
      clip: foundClip,
      quality,
      containerFormat,
      aspectRatio,
      burnCaptions,
      platformPreset,
      brandKit: body.brandKit,
      ownerUid,
      onJobUpdated: ownerUid
        ? (updatedJob) => {
            void upsertExportJobForOwner(ownerUid, updatedJob);
          }
        : undefined,
    });

    res.status(202).json({
      ok: true,
      job,
    });
  });

  // Phase 5/6: Enqueue batch ZIP export (MP4 + SRT + VTT + social copy for selected/all project clips)
  router.post('/projects/:id/export-batch', computeRateLimiter, optionalAuth, async (req: AuthRequest, res) => {
    const ffmpegAvailable = await checkFfmpegAvailable();
    if (!ffmpegAvailable) {
      res.json({
        requiresConfiguration: true,
        ffmpegAvailable: false,
        phase: 'Phase 5',
        message:
          'FFmpeg binary is not available on this server host. Install ffmpeg to enable batch ZIP rendering.',
      });
      return;
    }

    const project = projectsStore.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    const allowed =
      project.isDemo ||
      project.ownerId === 'session_preview_user' ||
      canAccessWorkspaceResource({
        resourceOwnerUid: project.ownerId,
        actorUid: req.user?.uid,
        actorRole: req.dbUser?.role,
        isDemo: project.isDemo,
      });
    if (!allowed) {
      res.status(403).json({ error: 'Forbidden: Cannot export another user’s project.' });
      return;
    }

    if (project.clips.length === 0) {
      res.status(400).json({ error: 'Project has no clips ready to export.' });
      return;
    }

    const body = req.body ?? {};
    const quality = normalizeExportQuality(body.quality ?? '720p');
    const containerFormat = normalizeExportContainerFormat(body.containerFormat);
    const burnCaptions = body.burnCaptions !== false;
    const clipIds = Array.isArray(body.clipIds)
      ? body.clipIds.map((x: unknown) => String(x))
      : undefined;
    const ownerUid = req.user?.uid;

    const job = enqueueBatchZipExport({
      project,
      clipIds,
      quality,
      containerFormat,
      burnCaptions,
      brandKit: body.brandKit,
      ownerUid,
      onJobUpdated: ownerUid
        ? (updatedJob) => {
            void upsertExportJobForOwner(ownerUid, updatedJob);
          }
        : undefined,
    });

    res.status(202).json({
      ok: true,
      job,
    });
  });

  // Phase 5: List export jobs
  router.get('/exports', (req, res) => {
    const projectId =
      typeof req.query.projectId === 'string' && req.query.projectId.trim()
        ? req.query.projectId.trim()
        : undefined;
    const clipId =
      typeof req.query.clipId === 'string' && req.query.clipId.trim()
        ? req.query.clipId.trim()
        : undefined;

    res.json({
      jobs: listExportJobs({ projectId, clipId }),
    });
  });

  // Phase 5: Single export job status
  router.get('/exports/:jobId', (req, res) => {
    const rec = getExportRecord(req.params.jobId);
    if (!rec) {
      res.status(404).json({ error: 'Export job not found.' });
      return;
    }
    res.json({ job: rec.job });
  });

  // Phase 5: Retry a failed export job
  router.post('/exports/:jobId/retry', (req, res) => {
    const retried = retryExportJob(req.params.jobId);
    if (!retried) {
      res.status(404).json({ error: 'Export job not found.' });
      return;
    }
    res.status(202).json({ ok: true, job: retried });
  });

  // Phase 5+: Signed, expiring export download endpoint (.mp4, .mov, .webm, .mkv, .gif, .mp3, .zip)
  router.get('/exports/:jobId/download', async (req, res) => {
    const { jobId } = req.params;
    const exp = typeof req.query.exp === 'string' ? req.query.exp : undefined;
    const sig = typeof req.query.sig === 'string' ? req.query.sig : undefined;

    if (!verifyExportSignature(jobId, exp, sig)) {
      res.status(403).json({ error: 'Invalid or expired export download link. Click Re-render to generate a fresh link.' });
      return;
    }

    const rec = getExportRecord(jobId);
    let outputFilePath: string | undefined;
    let contentType = 'video/mp4';
    let downloadFilename = `${jobId}.mp4`;

    if (rec && rec.outputFilePath && rec.job.status === 'completed') {
      outputFilePath = rec.outputFilePath;
      contentType = rec.contentType;
      downloadFilename =
        rec.job.filename || `${jobId}.${rec.job.kind === 'batch_zip' ? 'zip' : 'mp4'}`;
    } else {
      const diskArtifact = await resolveExportArtifactFromDisk(jobId);
      if (diskArtifact) {
        outputFilePath = diskArtifact.outputFilePath;
        contentType = diskArtifact.contentType;
        downloadFilename = diskArtifact.filename;
      }
    }

    if (!outputFilePath) {
      res.status(404).json({ error: 'Rendered export file is not ready or expired.' });
      return;
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(outputFilePath);
    } catch {
      res.status(404).json({ error: 'Export artifact missing from storage.' });
      return;
    }

    const safeFilename = downloadFilename.replace(/["\\\r\n]/g, '');
    const isInline = req.query.inline === '1';

    if (isInline) {
      await streamFileWithRange(req, res, outputFilePath, contentType, {
        cacheControl: 'private, max-age=300',
        contentDisposition: `inline; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`,
      });
      return;
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`
    );
    res.setHeader('Cache-Control', 'private, max-age=300');
    createReadStream(outputFilePath).pipe(res);
  });

  return router;
}
