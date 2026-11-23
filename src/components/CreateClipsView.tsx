import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Film,
  Link2,
  Pause,
  Play,
  RotateCcw,
  Scissors,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { CLIP_DURATION_PRESETS, formatTimecode } from '../lib/scoring';
import { useUploadManager, type ActiveUploadState } from '../lib/uploadManager';
import { formatBytes } from '../lib/validation';
import type {
  AnalysisTriggerResult,
  ClipDurationPreset,
  Project,
} from '../types/clipgenius';

interface CreateClipsViewProps {
  projects?: Project[];
  onStartAnalysis?: (
    projectId: string,
    targetDuration: ClipDurationPreset,
    resume?: boolean,
    captionLanguage?: string
  ) => Promise<AnalysisTriggerResult>;
  onOpenProjectInEditor: (projectId: string) => void;
  onOpenSampleEditor: () => void;
}

export function CreateClipsView({
  projects = [],
  onStartAnalysis,
  onOpenProjectInEditor,
  onOpenSampleEditor,
}: CreateClipsViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const {
    queue,
    sourceTab,
    setSourceTab,
    targetDuration,
    setTargetDuration,
    captionLanguage,
    setCaptionLanguage,
    uploadError,
    urlInput,
    setUrlInput,
    rightsConfirmed,
    setRightsConfirmed,
    urlStatus,
    submittingUrl,
    analysisFeedback,
    setProjectAnalysisFeedback,
    enqueueFiles,
    pauseUpload,
    resumeOrRetryUpload,
    removeUploadItem,
    submitUrlImport,
  } = useUploadManager();

  function handleFilesSelected(files: FileList | null) {
    enqueueFiles(files);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  function handlePauseUpload(item: ActiveUploadState) {
    pauseUpload(item.id);
  }

  function handleResumeOrRetry(item: ActiveUploadState) {
    resumeOrRetryUpload(item.id);
  }

  async function handleRemoveItem(item: ActiveUploadState) {
    await removeUploadItem(item.id);
  }

  async function handleTriggerAnalysis(projectId: string, resume: boolean = true) {
    if (!onStartAnalysis) return;
    setProjectAnalysisFeedback(projectId, '');
    const result = await onStartAnalysis(projectId, targetDuration, resume, captionLanguage);
    if (result.requiresConfiguration && result.message) {
      setProjectAnalysisFeedback(projectId, result.message);
    } else if (result.error) {
      setProjectAnalysisFeedback(projectId, result.error);
    }
  }

  async function handleUrlSubmit(e: React.FormEvent) {
    e.preventDefault();
    await submitUrlImport((imported) => {
      if (mountedRef.current) {
        onOpenProjectInEditor(imported.id);
      }
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-white">Ingest Long-Form Video</h2>
          <p className="mt-1 text-sm text-slate-400">
            Chunked resumable upload with server-side FFprobe stream validation and automatic
            thumbnail extraction.
          </p>
        </div>

        <div className="inline-flex rounded-lg border border-white/10 bg-[#131720] p-1 self-start">
          <button
            type="button"
            onClick={() => setSourceTab('upload')}
            className={`rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
              sourceTab === 'upload' ? 'bg-[#1F2634] text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            File Upload
          </button>
          <button
            type="button"
            onClick={() => setSourceTab('url')}
            className={`rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
              sourceTab === 'url' ? 'bg-[#1F2634] text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            Import via URL
          </button>
        </div>
      </div>

      {sourceTab === 'upload' ? (
        <div className="space-y-6">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              handleFilesSelected(e.dataTransfer.files);
            }}
            className={`rounded-xl border border-dashed p-10 text-center transition-colors ${
              dragActive
                ? 'border-amber-400 bg-amber-500/10'
                : 'border-white/20 bg-[#131720] hover:border-white/30'
            }`}
          >
            <Upload className="mx-auto h-10 w-10 text-amber-400" aria-hidden="true" />
            <h3 className="mt-4 font-display text-lg font-semibold text-white">
              Drop a video master here or browse files
            </h3>
            <p className="mt-1.5 text-sm text-slate-400">
              Accepted: MP4, MOV, WebM, MKV · 2 MB resumable chunks · FFprobe verified · Max 2 GB
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".mp4,.mov,.webm,.mkv,video/mp4,video/quicktime,video/webm,video/x-matroska"
              className="sr-only"
              aria-label="Select video file to upload"
              onChange={(e) => handleFilesSelected(e.target.files)}
            />
            <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2.5 text-xs text-slate-300">
              <div className="flex items-center gap-2">
                <span>Clip length:</span>
                <div className="inline-flex rounded-lg border border-white/10 bg-[#0B0D11] p-0.5">
                  {CLIP_DURATION_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setTargetDuration(preset)}
                      className={`rounded-md px-2.5 py-1 font-mono text-xs transition-colors ${
                        targetDuration === preset
                          ? 'bg-amber-500 text-slate-950 font-semibold'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {preset}s
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span>Caption language:</span>
                <div
                  role="group"
                  aria-label="Upload caption language"
                  className="inline-flex rounded-lg border border-white/10 bg-[#0B0D11] p-0.5"
                >
                  {(
                    [
                      { code: 'original', label: 'Auto' },
                      { code: 'en', label: 'English' },
                      { code: 'hinglish', label: 'Hinglish' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.code}
                      type="button"
                      data-testid={`upload-caption-lang-${opt.code}`}
                      onClick={() => setCaptionLanguage(opt.code)}
                      className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                        captionLanguage === opt.code
                          ? 'bg-amber-500 text-slate-950 font-semibold'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="rounded-lg bg-amber-500 px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-amber-400 transition-colors"
              >
                Choose Video File
              </button>
              <button
                type="button"
                onClick={onOpenSampleEditor}
                className="rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-medium text-white hover:bg-white/10 transition-colors"
              >
                Explore Sample Demo Project
              </button>
            </div>
          </div>

          {uploadError && (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200"
            >
              <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{uploadError}</span>
            </div>
          )}

          {queue.length > 0 && (
            <section className="rounded-xl border border-white/10 bg-[#131720] p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-display text-base font-semibold text-white">
                  Upload &amp; FFprobe Queue ({queue.length})
                </h3>
                <span className="text-xs text-slate-400">
                  Signed local object storage · Range streaming active
                </span>
              </div>

              <div className="divide-y divide-white/10 border-t border-white/10">
                {queue.map((item) => {
                  const liveProject = item.createdProject
                    ? projects.find((p) => p.id === item.createdProject!.id) ?? item.createdProject
                    : undefined;
                  const runningStage = liveProject?.processingStages.find(
                    (s) => s.status === 'running'
                  );
                  const failedStage = liveProject?.processingStages.find(
                    (s) => s.status === 'failed'
                  );
                  const completedStages =
                    liveProject?.processingStages.filter((s) => s.status === 'completed').length ??
                    0;
                  const totalStages = Math.max(7, liveProject?.processingStages.length ?? 7);
                  const feedback = liveProject ? analysisFeedback[liveProject.id] : undefined;

                  return (
                    <div key={item.id} className="py-4 space-y-3">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="flex items-start gap-3 min-w-0">
                          {liveProject?.video.thumbnailUrl ? (
                            <img
                              src={liveProject.video.thumbnailUrl}
                              alt={item.filename}
                              referrerPolicy="no-referrer"
                              className="h-12 w-20 rounded border border-white/10 object-cover shrink-0"
                            />
                          ) : (
                            <div className="h-12 w-20 rounded border border-white/10 bg-[#0B0D11] flex items-center justify-center shrink-0">
                              <Film className="h-5 w-5 text-amber-400" aria-hidden="true" />
                            </div>
                          )}

                          <div className="min-w-0">
                            <p className="text-sm font-medium text-white truncate">
                              {item.filename}
                            </p>
                            <p className="mt-0.5 text-xs text-slate-400 tabular-nums">
                              {formatBytes(item.sizeBytes)}
                              {liveProject ? (
                                <>
                                  {' · '}
                                  {formatTimecode(liveProject.video.durationSec)}
                                  {' · '}
                                  {liveProject.video.width}x{liveProject.video.height}
                                  {' · '}
                                  {liveProject.video.fps}fps
                                  {' · '}
                                  {liveProject.video.codec}
                                  {liveProject.status === 'ready' &&
                                    liveProject.processingStages.some(
                                      (s) => s.stage === 'clip_ranking' && s.status === 'completed'
                                    ) && (
                                      <>
                                        {' · '}
                                        <span className="text-emerald-400">
                                          {liveProject.clips.length} AI clips ranked (
                                          {liveProject.transcript?.words.length ?? 0} words)
                                        </span>
                                      </>
                                    )}
                                </>
                              ) : (
                                <>
                                  {' · '}
                                  {item.status === 'uploading' &&
                                    `Uploading chunk ${Math.min(
                                      item.nextChunkIndex + 1,
                                      item.totalChunks ?? 1
                                    )}/${item.totalChunks ?? 1}`}
                                  {item.status === 'validating' &&
                                    'Running FFprobe & extracting preview...'}
                                  {item.status === 'paused' && 'Upload paused'}
                                  {item.status === 'error' &&
                                    (item.errorMessage ?? 'Upload failed')}
                                </>
                              )}
                            </p>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          {liveProject &&
                            liveProject.status !== 'processing' &&
                            !liveProject.processingStages.some(
                              (s) => s.stage === 'clip_ranking' && s.status === 'completed'
                            ) && (
                            <>
                              <label htmlFor={`dur-${liveProject.id}`} className="sr-only">
                                Target clip duration
                              </label>
                              <select
                                id={`dur-${liveProject.id}`}
                                value={targetDuration}
                                onChange={(e) =>
                                  setTargetDuration(Number(e.target.value) as ClipDurationPreset)
                                }
                                className="rounded-lg border border-white/15 bg-[#0B0D11] px-2.5 py-2 text-xs font-mono text-white focus:border-amber-500 focus:outline-none"
                              >
                                {CLIP_DURATION_PRESETS.map((preset) => (
                                  <option key={preset} value={preset}>
                                    Target {preset}s
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                onClick={() =>
                                  void handleTriggerAnalysis(
                                    liveProject.id,
                                    liveProject.status === 'error'
                                  )
                                }
                                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors whitespace-nowrap"
                              >
                                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                                {liveProject.status === 'error'
                                  ? 'Retry Failed Stage'
                                  : 'Run AI Highlight Analysis'}
                              </button>
                            </>
                          )}

                          {liveProject && (
                            <button
                              type="button"
                              onClick={() => onOpenProjectInEditor(liveProject.id)}
                              className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                                liveProject.status === 'ready' &&
                                liveProject.processingStages.some(
                                  (s) => s.stage === 'clip_ranking' && s.status === 'completed'
                                )
                                  ? 'bg-amber-500 text-slate-950 hover:bg-amber-400'
                                  : 'border border-white/15 bg-white/5 text-white hover:bg-white/10'
                              }`}
                            >
                              <Scissors className="h-3.5 w-3.5" aria-hidden="true" />
                              Open in AI Editor
                            </button>
                          )}

                          {item.status === 'uploading' && (
                            <button
                              type="button"
                              aria-label={`Pause ${item.filename}`}
                              onClick={() => handlePauseUpload(item)}
                              className="rounded-md border border-white/15 bg-white/5 p-2 text-slate-200 hover:bg-white/10"
                            >
                              <Pause className="h-3.5 w-3.5" />
                            </button>
                          )}

                          {item.status === 'paused' && (
                            <button
                              type="button"
                              aria-label={`Resume ${item.filename}`}
                              onClick={() => handleResumeOrRetry(item)}
                              className="rounded-md border border-white/15 bg-white/5 p-2 text-slate-200 hover:bg-white/10"
                            >
                              <Play className="h-3.5 w-3.5" />
                            </button>
                          )}

                          {item.status === 'error' && (
                            <button
                              type="button"
                              aria-label={`Retry ${item.filename}`}
                              onClick={() => handleResumeOrRetry(item)}
                              className="rounded-md border border-white/15 bg-white/5 p-2 text-slate-200 hover:bg-white/10"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </button>
                          )}

                          <button
                            type="button"
                            aria-label={`Remove ${item.filename}`}
                            onClick={() => void handleRemoveItem(item)}
                            className="rounded-md border border-white/15 bg-white/5 p-2 text-slate-300 hover:text-red-300 hover:bg-red-500/10"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>

                      {liveProject?.status === 'processing' && (
                        <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 space-y-2">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-medium text-amber-300 capitalize">
                              {runningStage
                                ? `${runningStage.stage.replace(/_/g, ' ')}: ${runningStage.message}`
                                : 'Running 7-stage AI pipeline...'}
                            </span>
                            <span className="font-mono text-slate-300 tabular-nums">
                              {completedStages}/{totalStages} stages
                            </span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-amber-500 transition-all duration-300"
                              style={{
                                width: `${Math.max(
                                  10,
                                  Math.round((completedStages / totalStages) * 100)
                                )}%`,
                              }}
                            />
                          </div>
                        </div>
                      )}

                      {liveProject?.status === 'error' && failedStage && (
                        <div
                          role="alert"
                          className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200"
                        >
                          Stage &ldquo;{failedStage.stage.replace(/_/g, ' ')}&rdquo; failed:{' '}
                          {failedStage.message}
                        </div>
                      )}

                      {feedback && (
                        <div
                          role="status"
                          className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100"
                        >
                          {feedback}
                        </div>
                      )}

                      {item.status !== 'error' && !liveProject && (
                        <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-amber-500 transition-all duration-150"
                            style={{ width: `${item.progressPct}%` }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      ) : (
        <form
          onSubmit={handleUrlSubmit}
          noValidate
          className="rounded-xl border border-white/10 bg-[#131720] p-6 sm:p-8 space-y-5 max-w-2xl"
        >
          <div>
            <label htmlFor="video-url-input" className="block text-sm font-medium text-white mb-2">
              Video source URL
            </label>
            <div className="relative">
              <Link2
                className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"
                aria-hidden="true"
              />
              <input
                id="video-url-input"
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://cdn.example.com/interview.mp4 or YouTube URL"
                className="w-full rounded-lg border border-white/15 bg-[#0B0D11] pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
              />
            </div>
            <p className="mt-1.5 text-xs text-slate-400">
              Direct MP4 / MOV / WebM / MKV URLs stream and probe immediately. YouTube/Vimeo
              links require yt-dlp configured on the worker host.
            </p>
          </div>

          <label className="flex items-start gap-3 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={rightsConfirmed}
              onChange={(e) => setRightsConfirmed(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-white/20 bg-[#0B0D11] text-amber-500 focus:ring-amber-400"
            />
            <span>
              I confirm that I own the copyright or hold explicit permission to process and clip
              this source video.
            </span>
          </label>

          {urlStatus && (
            <div
              role={urlStatus.type === 'error' ? 'alert' : 'status'}
              className={`flex items-start gap-2.5 rounded-lg border p-3.5 text-xs ${
                urlStatus.type === 'error'
                  ? 'border-red-500/30 bg-red-500/10 text-red-200'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-100'
              }`}
            >
              {urlStatus.type === 'error' ? (
                <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
              ) : (
                <CheckCircle2
                  className="h-4 w-4 text-amber-400 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
              )}
              <span>{urlStatus.text}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={submittingUrl}
            className="rounded-lg bg-amber-500 px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-60 transition-colors"
          >
            {submittingUrl ? 'Importing & Probing...' : 'Import & Probe Video'}
          </button>
        </form>
      )}
    </div>
  );
}
