# ClipGenius AI — Phase 0 Architecture & Engineering Specification

## 1. System Overview & Runtime Stack Rationale

### Recommended Production Architecture
The production target separates interactive web delivery, transactional state, media storage, and GPU/CPU-intensive video workers:

```
+-------------------------------------------------------------------------+
|                        Browser Client (React / TS)                      |
|  Landing  ·  Auth  ·  Dashboard  ·  Upload Queue  ·  In-Browser Editor  |
+-----------------------------------+-------------------------------------+
                                    | HTTPS (REST + SSE job progress)
                                    v
+-------------------------------------------------------------------------+
|                    API Gateway & BFF (Express / FastAPI)                |
|  Auth/RBAC  ·  Upload Signing  ·  Validation  ·  LLM Adapter  ·  Health |
+--------+--------------------+---------------------+---------------------+
         |                    |                     |
         v                    v                     v
+----------------+   +------------------+   +-----------------------------+
| PostgreSQL DB  |   | Redis Job Queue  |   | S3 / R2 Object Storage      |
| Projects, Clips|   | BullMQ / Celery  |   | Signed URLs, Multipart Raw  |
| Scores, Usage  |   | Idempotent Stages|   | Video, Proxies, Exports     |
+----------------+   +--------+---------+   +--------------+--------------+
                              |                            ^
                              v                            |
+-------------------------------------------------------------------------+
|                   Media & AI Worker Pool (Docker / GPU)                 |
|  1. FFprobe + FFmpeg Audio Extract  2. Whisper Word-Level Transcript    |
|  3. Speaker Diarization (pyannote)  4. PySceneDetect + Face Tracking    |
|  5. Gemini / Provider-Agnostic LLM Highlighting & Scoring               |
|  6. FFmpeg Burned-in Caption + Reframe Render Queue (MP4 / SRT / ZIP)   |
+-------------------------------------------------------------------------+
```

### Stack Justification (AI Studio Runtime vs. Production Target)
- **Workspace Runtime (Phases 0–1)**: Runs **React 19 + TypeScript + Tailwind CSS v4 + Motion** served via **Express + Vite** on port `3000`, using `@google/genai` server-side. This matches the container runtime cleanly without requiring separate Python/Redis sidecars during UI and contract validation.
- **Production Worker Split (Phases 2–6)**: Media probing, Whisper transcription, OpenCV/MediaPipe active-speaker tracking, and FFmpeg rendering stay isolated behind clean API & queue contracts (`/api/uploads/*`, `/api/projects/:id/analyze`, `/api/clips/:id/export`) so Python/FastAPI or containerized FFmpeg workers can be attached without rewriting frontend components.

## 2. Repository & Folder Structure

```
/
├── docs/
│   └── ARCHITECTURE.md        # System diagram, data model, API contract, risks
├── server/
│   └── routes/
│       └── api.ts             # Express REST API surface & server config checks
├── server.ts                  # Express + Vite middleware entrypoint (port 3000)
├── src/
│   ├── assets/images/         # Generated studio & sample clip assets
│   ├── components/
│   │   ├── AppShell.tsx       # Responsive sidebar + mobile drawer + workspace bar
│   │   ├── AuthView.tsx       # Sign in, sign up, password reset, OAuth notice
│   │   ├── CaptionStylePanel.tsx # Caption styles, customization, silence/filler cuts & translation
│   │   ├── CreateClipsView.tsx# Drag/drop uploader, URL import, browser video probe
│   │   ├── DashboardView.tsx  # Usage stats, recent projects, pipeline status
│   │   ├── EditorPreviewView.tsx # 9:16/16:9/1:1/4:5 preview, multi-track studio, score & metadata
│   │   ├── ExportStudioPanel.tsx # Social presets, FFmpeg MP4/ZIP render queue & expiring downloads
│   │   ├── LandingPage.tsx    # Marketing page, demo clips, pricing, FAQ
│   │   ├── MultiTrackTimeline.tsx # Draggable In/Out trim handles, waveform cuts, cues & crop curve
│   │   ├── ProjectsView.tsx   # Searchable project cards & filtering
│   │   └── TemplatesBrandSettingsViews.tsx # Templates, Brand Kit, System Config
│   ├── data/
│   │   └── demoProject.ts     # Clearly labeled Sample Demo Project data
│   ├── lib/
│   │   ├── editorEngine.ts    # Silence/filler timeline skipping, EMA crop smoothing, cues & SRT/VTT
│   │   ├── editorEngine.test.ts # node:test suite for editor engine
│   │   ├── scoring.ts         # Weighted Viral Score math, timecodes, SRT/VTT export
│   │   ├── scoring.test.ts    # node:test suite for scoring & SRT
│   │   ├── validation.ts      # File, URL, and auth validation rules
│   │   └── validation.test.ts # node:test suite for validation
│   ├── types/
│   │   └── clipgenius.ts      # Core domain interfaces (11 entities)
│   ├── App.tsx                # Top-level routing & state orchestration
│   ├── index.css              # Tailwind v4 + font tokens + reduced-motion
│   └── main.tsx               # React root
├── .env.example               # Documented environment variable contract
├── metadata.json              # App identity & server-side Gemini capability
└── README.md                  # Setup, verification & phase roadmap
```

## 3. API Surface Summary

| Method | Endpoint | Phase | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | 0/6 | Liveness check, uptime, active phase, security & rate-limit headers |
| `GET` | `/api/config/status` | 0/6 | Honest readiness flags (`GEMINI_API_KEY`, `ffmpeg`, Google Sign-In) |
| `GET` | `/api/me` | 6 | Verified Firebase Google ID token profile, synced Brand Kit & usage count (`401` if unauthenticated) |
| `GET` / `PUT` | `/api/brand-kit` | 6 | Load and persist owner-scoped Brand Kit in Cloud SQL PostgreSQL (`401` if unauthenticated) |
| `GET` | `/api/projects` | 1/6 | List owner-scoped PostgreSQL projects (plus labeled Sample Demo Project) |
| `GET` / `DELETE` | `/api/projects/:id` | 1/6 | Retrieve or delete owner-scoped project with RBAC verification |
| `POST` | `/api/uploads/init` | 2/6 | Initialize chunked upload session with MIME/extension/size checks |
| `PUT` | `/api/uploads/:uploadId/chunk/:index` | 2 | Stream binary upload chunks to local signed storage |
| `POST` | `/api/uploads/:uploadId/complete` | 2/6 | Assemble chunks, FFprobe validate, generate thumbnail/proxy & persist to PostgreSQL |
| `POST` | `/api/uploads/import-url` | 2/6 | Download direct video URL (or report yt-dlp requirement), FFprobe verify & persist |
| `GET` | `/api/media/:storageKey` | 2 | Serve signed media previews with HTTP 206 Byte-Range streaming |
| `POST` | `/api/projects/:id/analyze` | 3/6 | Rate-limited, owner-scoped 7-stage FFmpeg + Gemini analysis pipeline |
| `GET` | `/api/projects/:id/events` | 3 | SSE stream pushing live stage progress & ranked clips |
| `PATCH` | `/api/clips/:id` | 2/4/6 | Persist trim bounds, captions, styling, crop keyframes & translations to PostgreSQL |
| `POST` | `/api/clips/:id/translate` | 4/6 | Rate-limited Gemini subtitle translation |
| `POST` | `/api/clips/:id/export` | 5/6 | Rate-limited FFmpeg MP4 render with reframing, blur fill & burned-in ASS captions |
| `POST` | `/api/projects/:id/export-batch` | 5/6 | Rate-limited batch ZIP bundle (MP4 + SRT + VTT + social copy) |
| `GET` | `/api/exports` | 5/6 | List owner-scoped active & completed export render queue jobs |
| `POST` | `/api/exports/:jobId/retry` | 5/6 | Retry a failed render job with incremented attempt counter |
| `GET` | `/api/exports/:jobId/download` | 5 | Stream completed `.mp4` or `.zip` after verifying expiring HMAC-SHA256 signature |

## 4. Minimum Data Model (11 Entities)

1. **User**: `id`, `email`, `passwordHash`, `name`, `plan` (`starter | creator | studio`), `role`, `createdAt`
2. **Project**: `id`, `ownerId`, `title`, `status`, `isDemo`, `createdAt`
3. **Video**: `id`, `projectId`, `sourceType`, `sourceUrl`, `filename`, `mimeType`, `fileSizeBytes`, `durationSec`, `width`, `height`, `fps`, `codec`, `storageKey`, `thumbnailUrl`
4. **Transcript**: `id`, `videoId`, `language`, `speakers[]`, `words[]` (`word`, `startSec`, `endSec`, `speaker`, `confidence`)
5. **Clip**: `id`, `projectId`, `title`, `startSec`, `endSec`, `aspectRatio`, `cropOffsetX`, `autoSpeakerTracking`, `backgroundBlurFill`, `captionStyle`, `captionText`
6. **ClipScore**: `id`, `clipId`, `overallEstimate` (0-100), `disclaimer`, `summary`, `criteria[6]` (weight, score, rationale)
7. **CaptionStyle**: `id`, `preset`, `fontFamily`, `fontSizePx`, `primaryColor`, `highlightColor`, `strokeColor`, `position`, `uppercase`
8. **BrandKit**: `id`, `ownerId`, `name`, `primaryColor`, `accentColor`, `fontDisplay`, `defaultCaptionPreset`, `watermarkPosition`, `watermarkText`
9. **ProcessingJob**: `id`, `projectId`, `stage`, `status`, `progressPct`, `attempt`, `error`, `updatedAt`
10. **ExportJob**: `id`, `clipId`, `format`, `burnCaptions`, `status`, `progressPct`, `downloadUrl`, `expiresAt`, `error`
11. **UsageRecord**: `id`, `ownerId`, `periodStart`, `minutesAnalyzed`, `clipsGenerated`, `exportsCompleted`

## 5. Key Technical Risks & Mitigations

1. **Large Video Uploads (2 GB – 10 GB) Timing Out Proxy Servers**
   - *Mitigation*: Direct-to-object-storage S3/R2 multipart presigned URLs (5–10 MB chunks) with client-side pause/resume/retry and server-side `ffprobe` validation before queuing jobs.
2. **GPU Cost & Latency for Transcription + Active-Speaker Tracking**
   - *Mitigation*: Extract lightweight 16kHz mono audio first (`ffmpeg -vn`) for fast Whisper inference; run scene detection + face bounding-box keyframes at 2–5 fps with Savitzky-Golay/EMA smoothing instead of per-frame heavy inference.
3. **Long-Running Job Failures & Partial State**
   - *Mitigation*: Idempotent stage-level checkpoints persisted in `ProcessingJob` (`audio_extract` -> `transcription` -> `diarization` -> `scene_detection` -> `topic_segmentation` -> `highlight_detection` -> `clip_ranking`) so retries resume from the last completed stage with exponential backoff and dead-letter alerting.
4. **Preview vs. Burned-In FFmpeg Export Drift**
   - *Mitigation*: Single canonical caption/crop JSON schema consumed by both the browser preview overlay and the Phase 5 ASS subtitle + `crop` filtergraph generator, verified against frame-accurate timestamps.
5. **Abuse & Unbounded Render Costs**
   - *Mitigation*: Per-user/IP rate limits, plan duration & file-size quotas enforced server-side before signing uploads, job concurrency caps per workspace, and automatic TTL cleanup of temporary files and signed export URLs.
