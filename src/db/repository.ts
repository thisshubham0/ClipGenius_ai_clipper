import crypto from 'node:crypto';
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import type {
  AspectRatio,
  BackgroundStyle,
  BrandKit,
  CaptionCustomizations,
  CaptionStylePreset,
  Clip,
  ClipScore,
  ClipVersion,
  CropKeyframe,
  ExportJob,
  ProcessingJob,
  Project,
  SilenceInterval,
  SocialCopyPack,
  SocialExportPreset,
  SoundtrackId,
  Transcript,
  TranscriptWord,
  TranslatedSubtitleCue,
  User,
  Video,
} from '../types/clipgenius.ts';
import { db, isSqlConfigured } from './index.ts';
import { brandKits, clips, exportJobs, projects, users } from './schema.ts';

interface ClipPayloadJson {
  thumbnailUrl: string;
  speaker: string;
  score: ClipScore;
  metadata: SocialCopyPack;
  words: TranscriptWord[];
  captionOverrides?: CaptionCustomizations;
  captionTextEdited?: boolean;
  cropKeyframes?: CropKeyframe[];
  translatedCues?: Record<string, TranslatedSubtitleCue[]>;
  backgroundStyle?: BackgroundStyle;
  soundtrackId?: SoundtrackId;
  soundtrackVolume?: number;
  versions?: ClipVersion[];
  activeVersionId?: string;
  isAiRecommended?: boolean;
  recommendationReason?: string;
}

export interface UserAuthRecord {
  user: User;
  passwordHash: string | null;
  authProvider: string;
}

function mapUserRow(row: typeof users.$inferSelect): User {
  return {
    id: row.uid,
    email: row.email,
    name: row.name,
    plan: (row.plan as User['plan']) || 'creator',
    role: (row.role as User['role']) || 'creator',
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getOrCreateUser(
  uid: string,
  email: string,
  name?: string
): Promise<User> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!isSqlConfigured()) {
    return {
      id: uid,
      email: normalizedEmail,
      name: name?.trim() || normalizedEmail.split('@')[0] || 'Creator',
      plan: 'creator',
      role: 'creator',
      createdAt: new Date().toISOString(),
    };
  }

  try {
    const resolvedName = name?.trim() || normalizedEmail.split('@')[0] || 'Creator';
    const result = await db
      .insert(users)
      .values({
        uid,
        email: normalizedEmail,
        name: resolvedName,
        authProvider: 'google',
        role: 'creator',
        plan: 'creator',
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email: normalizedEmail,
          name: resolvedName,
          updatedAt: new Date(),
        },
      })
      .returning();

    return mapUserRow(result[0]);
  } catch (error) {
    console.error('Database query failed in getOrCreateUser:', error);
    throw new Error('Unable to synchronize user profile. Please try again later.', {
      cause: error,
    });
  }
}

export async function findUserByEmail(email: string): Promise<UserAuthRecord | null> {
  if (!isSqlConfigured()) return null;

  const normalizedEmail = email.trim().toLowerCase();
  try {
    const rows = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${normalizedEmail}`)
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return {
      user: mapUserRow(row),
      passwordHash: row.passwordHash ?? null,
      authProvider: row.authProvider || 'google',
    };
  } catch (error) {
    console.error('Database query failed in findUserByEmail:', error);
    throw new Error('Unable to look up account right now. Please try again later.', {
      cause: error,
    });
  }
}

export async function getUserByUid(uid: string): Promise<User | null> {
  if (!isSqlConfigured()) return null;

  try {
    const rows = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
    const row = rows[0];
    return row ? mapUserRow(row) : null;
  } catch (error) {
    console.error('Database query failed in getUserByUid:', error);
    throw new Error('Unable to load account profile right now.', { cause: error });
  }
}

export async function createEmailPasswordUser(params: {
  email: string;
  name: string;
  passwordHash: string;
}): Promise<User> {
  if (!isSqlConfigured()) {
    throw new Error('Account registration requires database connectivity.');
  }

  const normalizedEmail = params.email.trim().toLowerCase();
  const resolvedName = params.name.trim() || normalizedEmail.split('@')[0] || 'Creator';
  const uid = `usr_${crypto.randomUUID().replace(/-/g, '')}`;

  try {
    const result = await db
      .insert(users)
      .values({
        uid,
        email: normalizedEmail,
        name: resolvedName,
        passwordHash: params.passwordHash,
        authProvider: 'password',
        role: 'creator',
        plan: 'creator',
      })
      .returning();

    return mapUserRow(result[0]);
  } catch (error) {
    console.error('Database query failed in createEmailPasswordUser:', error);
    throw new Error('Unable to create your account right now. Please try again.', {
      cause: error,
    });
  }
}

export async function listProjectsForOwner(ownerUid: string): Promise<Project[]> {
  if (!isSqlConfigured()) return [];

  try {
    const projRows = await db
      .select()
      .from(projects)
      .where(eq(projects.ownerUid, ownerUid))
      .orderBy(desc(projects.createdAt));

    if (projRows.length === 0) return [];

    const clipRows = await db
      .select()
      .from(clips)
      .where(eq(clips.ownerUid, ownerUid))
      .orderBy(desc(clips.overallScore), desc(clips.createdAt));

    const clipsByProject = new Map<string, Clip[]>();
    for (const row of clipRows) {
      const payload = (row.payloadJson ?? {}) as ClipPayloadJson;
      const hydratedClip: Clip = {
        id: row.id,
        projectId: row.projectId,
        title: row.title,
        startSec: row.startSec,
        endSec: row.endSec,
        aspectRatio: row.aspectRatio as AspectRatio,
        cropOffsetX: row.cropOffsetX,
        autoSpeakerTracking: row.autoSpeakerTracking,
        autoZoom: row.autoZoom,
        backgroundBlurFill: row.backgroundBlurFill,
        backgroundStyle: payload.backgroundStyle,
        soundtrackId: payload.soundtrackId,
        soundtrackVolume: payload.soundtrackVolume,
        versions: payload.versions,
        activeVersionId: payload.activeVersionId,
        isAiRecommended: payload.isAiRecommended,
        recommendationReason: payload.recommendationReason,
        removeSilences: row.removeSilences,
        removeFillers: row.removeFillers,
        captionStyle: row.captionStyle as CaptionStylePreset,
        captionText: row.captionText,
        captionTextEdited: payload.captionTextEdited,
        subtitleLanguage: row.subtitleLanguage,
        thumbnailUrl: payload.thumbnailUrl ?? '',
        speaker: payload.speaker ?? 'Speaker 1',
        score: payload.score,
        metadata: payload.metadata,
        words: payload.words ?? [],
        captionOverrides: payload.captionOverrides,
        cropKeyframes: payload.cropKeyframes,
        translatedCues: payload.translatedCues,
      };
      const existing = clipsByProject.get(row.projectId) ?? [];
      existing.push(hydratedClip);
      clipsByProject.set(row.projectId, existing);
    }

    return projRows.map((row) => ({
      id: row.id,
      ownerId: row.ownerUid,
      title: row.title,
      createdAt: row.createdAt.toISOString(),
      status: (row.status as Project['status']) || 'ready',
      isDemo: false,
      video: row.videoJson as Video,
      transcript: (row.transcriptJson as Transcript | null) ?? undefined,
      sceneCutsSec: (row.sceneCutsJson as number[] | null) ?? undefined,
      silences: (row.silencesJson as SilenceInterval[] | null) ?? undefined,
      silenceCount: Array.isArray(row.silencesJson)
        ? (row.silencesJson as SilenceInterval[]).length
        : undefined,
      processingStages: (row.processingStagesJson as ProcessingJob[]) ?? [],
      clips: clipsByProject.get(row.id) ?? [],
    }));
  } catch (error) {
    console.error('Database query failed in listProjectsForOwner:', error);
    throw new Error('Unable to load workspace projects right now.', { cause: error });
  }
}

export async function upsertProjectWithClips(
  ownerUid: string,
  project: Project
): Promise<void> {
  if (!isSqlConfigured() || project.isDemo) return;

  try {
    await db
      .insert(projects)
      .values({
        id: project.id,
        ownerUid,
        title: project.title,
        status: project.status,
        videoJson: project.video,
        transcriptJson: project.transcript ?? null,
        sceneCutsJson: project.sceneCutsSec ?? null,
        silencesJson: project.silences ?? null,
        processingStagesJson: project.processingStages,
      })
      .onConflictDoUpdate({
        target: projects.id,
        set: {
          title: project.title,
          status: project.status,
          videoJson: project.video,
          transcriptJson: project.transcript ?? null,
          sceneCutsJson: project.sceneCutsSec ?? null,
          silencesJson: project.silences ?? null,
          processingStagesJson: project.processingStages,
          updatedAt: new Date(),
        },
      });

    const currentClipIds = project.clips.map((c) => c.id);
    if (currentClipIds.length > 0) {
      await db
        .delete(clips)
        .where(
          and(
            eq(clips.projectId, project.id),
            eq(clips.ownerUid, ownerUid),
            notInArray(clips.id, currentClipIds)
          )
        );
    }

    for (const clip of project.clips) {
      await upsertClipForOwner(ownerUid, clip);
    }
  } catch (error) {
    console.error('Database query failed in upsertProjectWithClips:', error);
    throw new Error('Unable to save project data right now.', { cause: error });
  }
}

export async function upsertClipForOwner(ownerUid: string, clip: Clip): Promise<void> {
  if (!isSqlConfigured()) return;

  try {
    const payloadJson: ClipPayloadJson = {
      thumbnailUrl: clip.thumbnailUrl,
      speaker: clip.speaker,
      score: clip.score,
      metadata: clip.metadata,
      words: clip.words,
      captionOverrides: clip.captionOverrides,
      captionTextEdited: clip.captionTextEdited,
      cropKeyframes: clip.cropKeyframes,
      translatedCues: clip.translatedCues,
      backgroundStyle: clip.backgroundStyle,
      soundtrackId: clip.soundtrackId,
      soundtrackVolume: clip.soundtrackVolume,
      versions: clip.versions,
      activeVersionId: clip.activeVersionId,
      isAiRecommended: clip.isAiRecommended,
      recommendationReason: clip.recommendationReason,
    };

    await db
      .insert(clips)
      .values({
        id: clip.id,
        projectId: clip.projectId,
        ownerUid,
        title: clip.title,
        startSec: clip.startSec,
        endSec: clip.endSec,
        aspectRatio: clip.aspectRatio,
        cropOffsetX: clip.cropOffsetX,
        autoSpeakerTracking: clip.autoSpeakerTracking,
        autoZoom: Boolean(clip.autoZoom),
        backgroundBlurFill: clip.backgroundBlurFill,
        removeSilences: Boolean(clip.removeSilences),
        removeFillers: Boolean(clip.removeFillers),
        captionStyle: clip.captionStyle,
        captionText: clip.captionText,
        subtitleLanguage: clip.subtitleLanguage || 'original',
        overallScore: Math.round(clip.score?.overallEstimate ?? 0),
        payloadJson,
      })
      .onConflictDoUpdate({
        target: clips.id,
        set: {
          title: clip.title,
          startSec: clip.startSec,
          endSec: clip.endSec,
          aspectRatio: clip.aspectRatio,
          cropOffsetX: clip.cropOffsetX,
          autoSpeakerTracking: clip.autoSpeakerTracking,
          autoZoom: Boolean(clip.autoZoom),
          backgroundBlurFill: clip.backgroundBlurFill,
          removeSilences: Boolean(clip.removeSilences),
          removeFillers: Boolean(clip.removeFillers),
          captionStyle: clip.captionStyle,
          captionText: clip.captionText,
          subtitleLanguage: clip.subtitleLanguage || 'original',
          overallScore: Math.round(clip.score?.overallEstimate ?? 0),
          payloadJson,
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    console.error('Database query failed in upsertClipForOwner:', error);
    throw new Error('Unable to save clip edits right now.', { cause: error });
  }
}

export async function deleteProjectForOwner(
  ownerUid: string,
  projectId: string
): Promise<boolean> {
  if (!isSqlConfigured()) return false;

  try {
    const deleted = await db
      .delete(projects)
      .where(and(eq(projects.id, projectId), eq(projects.ownerUid, ownerUid)))
      .returning({ id: projects.id });
    return deleted.length > 0;
  } catch (error) {
    console.error('Database query failed in deleteProjectForOwner:', error);
    throw new Error('Unable to delete project right now.', { cause: error });
  }
}

export async function getBrandKitForOwner(ownerUid: string): Promise<BrandKit | null> {
  if (!isSqlConfigured()) return null;

  try {
    const rows = await db
      .select()
      .from(brandKits)
      .where(eq(brandKits.ownerUid, ownerUid))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: `bk_${row.id}`,
      name: row.name,
      primaryColor: row.primaryColor,
      accentColor: row.accentColor,
      fontDisplay: row.fontDisplay,
      defaultCaptionPreset: row.defaultCaptionPreset as CaptionStylePreset,
      watermarkPosition: row.watermarkPosition as BrandKit['watermarkPosition'],
      watermarkText: row.watermarkText,
    };
  } catch (error) {
    console.error('Database query failed in getBrandKitForOwner:', error);
    throw new Error('Unable to load Brand Kit settings.', { cause: error });
  }
}

export async function saveBrandKitForOwner(
  ownerUid: string,
  kit: BrandKit
): Promise<BrandKit> {
  if (!isSqlConfigured()) return kit;

  try {
    const result = await db
      .insert(brandKits)
      .values({
        ownerUid,
        name: kit.name,
        primaryColor: kit.primaryColor,
        accentColor: kit.accentColor,
        fontDisplay: kit.fontDisplay,
        defaultCaptionPreset: kit.defaultCaptionPreset,
        watermarkPosition: kit.watermarkPosition,
        watermarkText: kit.watermarkText,
      })
      .onConflictDoUpdate({
        target: brandKits.ownerUid,
        set: {
          name: kit.name,
          primaryColor: kit.primaryColor,
          accentColor: kit.accentColor,
          fontDisplay: kit.fontDisplay,
          defaultCaptionPreset: kit.defaultCaptionPreset,
          watermarkPosition: kit.watermarkPosition,
          watermarkText: kit.watermarkText,
          updatedAt: new Date(),
        },
      })
      .returning();

    const row = result[0];
    return {
      id: `bk_${row.id}`,
      name: row.name,
      primaryColor: row.primaryColor,
      accentColor: row.accentColor,
      fontDisplay: row.fontDisplay,
      defaultCaptionPreset: row.defaultCaptionPreset as CaptionStylePreset,
      watermarkPosition: row.watermarkPosition as BrandKit['watermarkPosition'],
      watermarkText: row.watermarkText,
    };
  } catch (error) {
    console.error('Database query failed in saveBrandKitForOwner:', error);
    throw new Error('Unable to save Brand Kit settings.', { cause: error });
  }
}

export async function upsertExportJobForOwner(
  ownerUid: string,
  job: ExportJob
): Promise<void> {
  if (!isSqlConfigured()) return;

  try {
    await db
      .insert(exportJobs)
      .values({
        id: job.id,
        ownerUid,
        projectId: job.projectId,
        clipId: job.clipId,
        clipTitle: job.clipTitle,
        kind: job.kind,
        format: job.format,
        quality: job.quality,
        aspectRatio: job.aspectRatio,
        platformPreset: job.platformPreset,
        burnCaptions: job.burnCaptions,
        status: job.status,
        progressPct: job.progressPct,
        filename: job.filename ?? null,
        fileSizeBytes: job.fileSizeBytes ?? null,
        error: job.error ?? null,
      })
      .onConflictDoUpdate({
        target: exportJobs.id,
        set: {
          status: job.status,
          progressPct: job.progressPct,
          filename: job.filename ?? null,
          fileSizeBytes: job.fileSizeBytes ?? null,
          error: job.error ?? null,
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    console.error('Database query failed in upsertExportJobForOwner:', error);
  }
}

export async function countCompletedExportsForOwner(ownerUid: string): Promise<number> {
  if (!isSqlConfigured()) return 0;

  try {
    const rows = await db
      .select({ id: exportJobs.id })
      .from(exportJobs)
      .where(and(eq(exportJobs.ownerUid, ownerUid), eq(exportJobs.status, 'completed')));
    return rows.length;
  } catch (error) {
    console.error('Database query failed in countCompletedExportsForOwner:', error);
    return 0;
  }
}

export async function listExportHistoryForOwner(
  ownerUid: string,
  projectId?: string
): Promise<ExportJob[]> {
  if (!isSqlConfigured()) return [];

  try {
    const rows = projectId
      ? await db
          .select()
          .from(exportJobs)
          .where(and(eq(exportJobs.ownerUid, ownerUid), eq(exportJobs.projectId, projectId)))
          .orderBy(desc(exportJobs.createdAt))
      : await db
          .select()
          .from(exportJobs)
          .where(eq(exportJobs.ownerUid, ownerUid))
          .orderBy(desc(exportJobs.createdAt));

    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      clipId: row.clipId,
      clipTitle: row.clipTitle,
      kind: row.kind as ExportJob['kind'],
      format: row.format as ExportJob['format'],
      quality: row.quality as ExportJob['quality'],
      aspectRatio: row.aspectRatio as AspectRatio,
      platformPreset: row.platformPreset as SocialExportPreset,
      burnCaptions: row.burnCaptions,
      status: row.status as ExportJob['status'],
      progressPct: row.progressPct,
      filename: row.filename ?? undefined,
      fileSizeBytes: row.fileSizeBytes ?? undefined,
      error: row.error ?? undefined,
      attempt: 1,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  } catch (error) {
    console.error('Database query failed in listExportHistoryForOwner:', error);
    return [];
  }
}
