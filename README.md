# ClipGenius AI

Production-grade SaaS workspace that turns long-form videos into ranked, captioned, platform-ready short clips with transparent, explainable AI scoring and an in-browser studio editor.

## Current Delivery Status

- **Phase 0 (Completed):** Architecture spec (`docs/ARCHITECTURE.md`), repository layout, typed domain contracts (`src/types/clipgenius.ts`), pure logic modules (`src/lib/validation.ts`, `src/lib/scoring.ts`) with `node:test` unit tests, and Express API gateway skeleton (`server.ts`, `server/routes/api.ts`).
- **Phase 1 (Completed):** Dark-first responsive frontend including the Marketing Landing Page, Auth screens, Responsive App Shell (`Dashboard`, `Create Clips`, `My Projects`, `AI Editor`, `Templates`, `Brand Kit`, `Settings`), and clearly labeled **Sample Demo Project** preview.
- **Phase 2 (Completed):** Chunked resumable uploads, direct URL media import, server-side FFprobe verification, JPEG thumbnail + H.264 preview proxy + waveform generation, and HMAC-SHA256 signed HTTP `206` Byte-Range video playback.
- **Phase 3 (Completed):** Idempotent, resumable 7-stage AI analysis pipeline (`audio_extract` + silence detection, `gemini-3.5-transcribe` verbatim transcription, `gemini-3.8-flash` speaker diarization & word alignment, FFmpeg scene cut detection, topic segmentation, highlight extraction & social copy pack, sentence-boundary snapping & deterministic Viral Score ranking), real-time SSE progress stream, clickable word-level Transcript tab, and `.SRT` + `.VTT` subtitle downloads.
- **Phase 4 (Completed):** Advanced in-browser editor with multi-track timeline (`MultiTrackTimeline.tsx` with draggable In/Out trim handles, waveform silence/filler cut bands, clickable timed caption cues, and SVG active-speaker crop curve + keyframe editor), bidirectional EMA smoothed active-speaker crop & auto-zoom, custom caption styling (`CaptionStylePanel.tsx`), live silence/filler-word playback skipping, real server-side Gemini subtitle translation (`POST /api/clips/:id/translate`) with localized `.SRT`/`.VTT` export, honest disabled provider-gated AI Voice Dubbing row, and keyboard shortcuts (`Space`, `J`/`L`, `[`/`]`, `Cmd/Ctrl+Z`).
- **Phase 5 (Completed):** Server-side FFmpeg MP4 render queue (`server/media/renderQueue.ts`, `server/media/renderSpec.ts`) supporting `720p`/`1080p` exports across `9:16`, `16:9`, `1:1`, and `4:5`, horizontal crop anchor & blurred background fill, burned-in styled `.ASS` subtitles (preserving font size, colors, alignment, uppercase, karaoke tags, translated languages & brand watermark), one-click social export presets (TikTok, Reels, Shorts, LinkedIn), batch `.ZIP` bundles (MP4 + SRT + VTT + social copy), real-time queue progress & retries, and expiring HMAC-SHA256 signed download links.
- **Phase 6 (Completed):** Production relational persistence via **Cloud SQL (PostgreSQL) + Drizzle ORM** (`src/db/schema.ts`, `src/db/index.ts`, `src/db/repository.ts` across `users`, `projects`, `clips`, `brand_kits`, and `export_jobs`), real **Firebase Google Sign-In** (`src/lib/firebase.ts`, `src/lib/firebase-admin.ts`, `src/middleware/auth.ts`, in-memory ID token Bearer auth via `src/lib/apiClient.ts`), owner-scoped RBAC checks (`canAccessWorkspaceResource`), iframe-safe security headers, and sliding-window API/compute rate limiting (`server/middleware/security.ts`).

## Running Locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Environment Variables

Copy `.env.example` to `.env` for local overrides (in AI Studio, runtime secrets and Cloud SQL connection parameters are injected automatically):

- `GEMINI_API_KEY` — Server-side Gemini API key (never exposed to browser)
- `APP_URL` — Public base URL for links and callbacks
- `MEDIA_SIGNING_SECRET` — HMAC-SHA256 secret for expiring media/export links
- `SQL_HOST`, `SQL_USER`, `SQL_PASSWORD`, `SQL_DB_NAME` — Cloud SQL (PostgreSQL) runtime pool parameters
- `SQL_ADMIN_USER`, `SQL_ADMIN_PASSWORD` — Drizzle Kit schema migration credentials
- `REDIS_URL` — Optional external Redis queue connection string
- `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` — Optional external S3/R2 object storage

## Verification

```bash
npm test      # Run unit tests (validation, scoring, editor engine, FFmpeg render spec, security & RBAC)
npm run lint  # TypeScript check
npm run build # Production Vite bundle
```
