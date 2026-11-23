import { ArrowRight, CheckCircle2, Clock, Scissors, Upload } from 'lucide-react';
import { formatTimecode } from '../lib/scoring';
import { formatBytes } from '../lib/validation';
import type { Project, UsageRecord, User } from '../types/clipgenius';

interface DashboardViewProps {
  user: User;
  projects: Project[];
  usage: UsageRecord;
  onNavigateToCreate: () => void;
  onOpenProjectInEditor: (projectId: string, clipId?: string) => void;
  onNavigateToProjects: () => void;
}

export function DashboardView({
  user,
  projects,
  usage,
  onNavigateToCreate,
  onOpenProjectInEditor,
  onNavigateToProjects,
}: DashboardViewProps) {
  const featuredProject = projects[0];
  const allClips = projects.flatMap((p) => p.clips);
  const featuredClips = featuredProject?.clips ?? [];

  return (
    <div className="space-y-8">
      {/* Welcome & Primary CTA */}
      <section className="rounded-xl border border-white/10 bg-[#131720] p-6 sm:p-8 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <p className="text-xs font-medium text-amber-400">Workspace overview</p>
          <h2 className="mt-1.5 font-display text-2xl sm:text-3xl font-semibold text-white">
            Welcome back, {user.name}
          </h2>
          <p className="mt-2 text-sm text-slate-300 max-w-2xl">
            Upload a long-form video to run the 7-stage AI transcription and highlight ranking
            pipeline, or open the Sample Demo Project to test reframing and captions.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onNavigateToCreate}
            className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0"
          >
            <Upload className="h-4 w-4" aria-hidden="true" />
            Upload Video
          </button>
          {featuredProject && (
            <button
              type="button"
              onClick={() => onOpenProjectInEditor(featuredProject.id)}
              className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-medium text-white hover:bg-white/10 transition-colors whitespace-nowrap shrink-0"
            >
              <Scissors className="h-4 w-4 text-amber-400" aria-hidden="true" />
              {featuredProject.isDemo ? 'Open Sample Editor' : 'Open Latest in Editor'}
            </button>
          )}
        </div>
      </section>

      {/* Usage Metrics Grid */}
      <section aria-label="Usage metrics">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-display text-base font-semibold text-white">Monthly Usage</h3>
          <span className="text-xs text-slate-400">{usage.periodLabel}</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-xl border border-white/10 bg-[#131720] p-5">
            <p className="text-xs text-slate-400">Source minutes processed</p>
            <p className="mt-2 font-display text-2xl font-semibold text-white tabular-nums">
              {usage.minutesAnalyzed}{' '}
              <span className="text-sm font-normal text-slate-400">/ {usage.minutesLimit} min</span>
            </p>
            <div className="mt-3 h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-amber-500"
                style={{
                  width: `${Math.min(100, (usage.minutesAnalyzed / usage.minutesLimit) * 100)}%`,
                }}
              />
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-[#131720] p-5">
            <p className="text-xs text-slate-400">Ranked clips ready</p>
            <p className="mt-2 font-display text-2xl font-semibold text-white tabular-nums">
              {allClips.length}
            </p>
            <p className="mt-3 text-xs text-slate-400">
              Across {projects.length} {projects.length === 1 ? 'project' : 'projects'}
            </p>
          </div>

          <div className="rounded-xl border border-white/10 bg-[#131720] p-5">
            <p className="text-xs text-slate-400">Rendered MP4 exports</p>
            <p className="mt-2 font-display text-2xl font-semibold text-white tabular-nums">
              {usage.exportsCompleted}{' '}
              <span className="text-sm font-normal text-slate-400">/ {usage.exportsLimit}</span>
            </p>
            <p className="mt-3 text-xs text-slate-400">SRT/VTT downloads unlimited</p>
          </div>
        </div>
      </section>

      {/* Two-Column Recent Projects + Pipeline Status */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-7 rounded-xl border border-white/10 bg-[#131720] p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-semibold text-white">Recent Projects</h3>
              <button
                type="button"
                onClick={onNavigateToProjects}
                className="text-xs font-medium text-amber-400 hover:text-amber-300 inline-flex items-center gap-1"
              >
                View all
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>

            <div className="divide-y divide-white/10 border-t border-white/10">
              {projects.map((project) => (
                <div
                  key={project.id}
                  className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  <div className="min-w-0">
                    <p className="text-xs text-amber-400">
                      {project.isDemo
                        ? 'Sample Demo Project'
                        : project.transcript
                        ? 'AI Analyzed Project'
                        : project.status === 'processing'
                        ? 'Analyzing with AI...'
                        : 'Uploaded Master'}
                      <span className="text-slate-500 mx-1.5" aria-hidden="true">
                        ·
                      </span>
                      <span className="text-slate-400 tabular-nums">
                        {formatTimecode(project.video.durationSec)} · {project.video.width}x
                        {project.video.height} · {formatBytes(project.video.fileSizeBytes)}
                      </span>
                    </p>
                    <h4 className="mt-1 font-display text-sm font-semibold text-white truncate">
                      {project.title}
                    </h4>
                    <p className="mt-1 text-xs text-slate-400">
                      {project.clips.length} {project.clips.length === 1 ? 'clip' : 'clips'} · Status:{' '}
                      {project.status === 'processing'
                        ? 'Running AI pipeline'
                        : project.status === 'error'
                        ? 'Pipeline error (retry available)'
                        : project.transcript
                        ? `Transcribed (${project.transcript.words.length} words)`
                        : 'Ready for editing / analysis'}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => onOpenProjectInEditor(project.id)}
                    className="rounded-lg border border-white/15 bg-white/5 px-3.5 py-2 text-xs font-medium text-white hover:bg-white/10 transition-colors whitespace-nowrap shrink-0"
                  >
                    {project.clips.length > 0 ? 'Open Editor' : 'Inspect'}
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-slate-400">
            <span>Supported masters: MP4, MOV, WebM, MKV or validated video links</span>
            <button
              type="button"
              onClick={onNavigateToCreate}
              className="text-amber-400 hover:text-amber-300 font-medium whitespace-nowrap shrink-0 text-left"
            >
              + Add new video
            </button>
          </div>
        </section>

        <section className="lg:col-span-5 rounded-xl border border-white/10 bg-[#131720] p-6">
          <h3 className="font-display text-base font-semibold text-white">
            Pipeline Stage Log
          </h3>
          <p className="mt-1 text-xs text-slate-400">
            {featuredProject?.isDemo
              ? 'Sample Demo Project processing stages'
              : `${featuredProject?.title ?? 'Latest project'} · 7-stage pipeline`}
          </p>

          <div className="mt-4 space-y-3">
            {(featuredProject?.processingStages ?? []).map((stage) => (
              <div
                key={stage.id}
                className="flex items-start gap-3 border-b border-white/5 pb-3 last:border-b-0 last:pb-0"
              >
                {stage.status === 'completed' ? (
                  <CheckCircle2
                    className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                ) : (
                  <Clock
                    className={`h-4 w-4 shrink-0 mt-0.5 ${
                      stage.status === 'failed'
                        ? 'text-red-400'
                        : stage.status === 'running'
                        ? 'text-amber-400'
                        : 'text-slate-400'
                    }`}
                    aria-hidden="true"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-slate-200 capitalize">
                      {stage.stage.replace(/_/g, ' ')}
                    </span>
                    <span className="font-mono text-slate-400 tabular-nums">
                      {stage.progressPct}%
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-400">{stage.message}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Generated Clips Quick Rail */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-display text-base font-semibold text-white">
              Ranked Clips ({featuredProject?.title ?? 'Sample Demo Project'})
            </h3>
            <p className="text-xs text-slate-400">
              Scores are weighted estimates, not guarantees of reach.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {featuredClips.map((clip) => (
            <div
              key={clip.id}
              className="rounded-xl border border-white/10 bg-[#131720] overflow-hidden flex flex-col justify-between"
            >
              <div className="relative h-44 bg-[#0B0D11]">
                <img
                  src={clip.thumbnailUrl}
                  alt={clip.title}
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover object-top"
                />
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#131720] via-transparent to-black/30"
                />
                <div className="absolute bottom-3 left-4 right-4 flex items-center justify-between text-xs">
                  <span className="font-mono text-slate-200 tabular-nums">
                    {formatTimecode(clip.startSec)} – {formatTimecode(clip.endSec)}
                  </span>
                  <span className="font-mono font-semibold text-amber-400 tabular-nums">
                    Score {clip.score.overallEstimate}/100 est.
                  </span>
                </div>
              </div>

              <div className="p-4 flex-1 flex flex-col justify-between gap-4">
                <div>
                  <h4 className="font-display text-sm font-semibold text-white">{clip.title}</h4>
                  <p className="mt-1 text-xs text-slate-400 line-clamp-2">{clip.score.summary}</p>
                </div>

                <button
                  type="button"
                  onClick={() => onOpenProjectInEditor(clip.projectId, clip.id)}
                  className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs font-medium text-white hover:bg-white/10 transition-colors"
                >
                  Edit Clip
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
