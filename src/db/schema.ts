import { relations } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  authProvider: text('auth_provider').notNull().default('google'),
  role: text('role').notNull().default('creator'),
  plan: text('plan').notNull().default('creator'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  ownerUid: text('owner_uid')
    .notNull()
    .references(() => users.uid, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  status: text('status').notNull().default('ready'),
  videoJson: jsonb('video_json').notNull(),
  transcriptJson: jsonb('transcript_json'),
  sceneCutsJson: jsonb('scene_cuts_json'),
  silencesJson: jsonb('silences_json'),
  processingStagesJson: jsonb('processing_stages_json').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const clips = pgTable('clips', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  ownerUid: text('owner_uid')
    .notNull()
    .references(() => users.uid, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  startSec: doublePrecision('start_sec').notNull(),
  endSec: doublePrecision('end_sec').notNull(),
  aspectRatio: text('aspect_ratio').notNull().default('9:16'),
  cropOffsetX: doublePrecision('crop_offset_x').notNull().default(50),
  autoSpeakerTracking: boolean('auto_speaker_tracking').notNull().default(true),
  autoZoom: boolean('auto_zoom').notNull().default(false),
  backgroundBlurFill: boolean('background_blur_fill').notNull().default(false),
  removeSilences: boolean('remove_silences').notNull().default(false),
  removeFillers: boolean('remove_fillers').notNull().default(false),
  captionStyle: text('caption_style').notNull().default('modern_animated'),
  captionText: text('caption_text').notNull().default(''),
  subtitleLanguage: text('subtitle_language').notNull().default('original'),
  overallScore: integer('overall_score').notNull().default(0),
  payloadJson: jsonb('payload_json').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const brandKits = pgTable('brand_kits', {
  id: serial('id').primaryKey(),
  ownerUid: text('owner_uid')
    .notNull()
    .unique()
    .references(() => users.uid, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  primaryColor: text('primary_color').notNull(),
  accentColor: text('accent_color').notNull(),
  fontDisplay: text('font_display').notNull(),
  defaultCaptionPreset: text('default_caption_preset').notNull(),
  watermarkPosition: text('watermark_position').notNull(),
  watermarkText: text('watermark_text').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const exportJobs = pgTable('export_jobs', {
  id: text('id').primaryKey(),
  ownerUid: text('owner_uid')
    .notNull()
    .references(() => users.uid, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull(),
  clipId: text('clip_id').notNull(),
  clipTitle: text('clip_title').notNull(),
  kind: text('kind').notNull(),
  format: text('format').notNull(),
  quality: text('quality').notNull(),
  aspectRatio: text('aspect_ratio').notNull(),
  platformPreset: text('platform_preset').notNull(),
  burnCaptions: boolean('burn_captions').notNull().default(true),
  status: text('status').notNull(),
  progressPct: integer('progress_pct').notNull().default(0),
  filename: text('filename'),
  fileSizeBytes: integer('file_size_bytes'),
  error: text('error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const usersRelations = relations(users, ({ many, one }) => ({
  projects: many(projects),
  clips: many(clips),
  exportJobs: many(exportJobs),
  brandKit: one(brandKits, {
    fields: [users.uid],
    references: [brandKits.ownerUid],
  }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  owner: one(users, {
    fields: [projects.ownerUid],
    references: [users.uid],
  }),
  clips: many(clips),
}));

export const clipsRelations = relations(clips, ({ one }) => ({
  project: one(projects, {
    fields: [clips.projectId],
    references: [projects.id],
  }),
  owner: one(users, {
    fields: [clips.ownerUid],
    references: [users.uid],
  }),
}));
