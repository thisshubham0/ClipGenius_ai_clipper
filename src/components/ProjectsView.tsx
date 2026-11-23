import { useState } from 'react';
import { Film, Plus, Search, Trash2 } from 'lucide-react';
import { formatTimecode } from '../lib/scoring';
import { formatBytes } from '../lib/validation';
import type { Project } from '../types/clipgenius';

interface ProjectsViewProps {
  projects: Project[];
  onOpenProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onCreateNew: () => void;
}

export function ProjectsView({
  projects,
  onOpenProject,
  onDeleteProject,
  onCreateNew,
}: ProjectsViewProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'ready' | 'queued'>('all');

  const filtered = projects.filter((p) => {
    const matchesQuery =
      !query.trim() ||
      p.title.toLowerCase().includes(query.trim().toLowerCase()) ||
      p.video.filename.toLowerCase().includes(query.trim().toLowerCase());
    if (!matchesQuery) return false;
    if (filter === 'ready') return p.status === 'ready';
    if (filter === 'queued') return p.status !== 'ready';
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-white">Projects</h2>
          <p className="mt-1 text-sm text-slate-400">
            Manage ingested source masters and generated short clip collections.
          </p>
        </div>
        <button
          type="button"
          onClick={onCreateNew}
          className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors self-start"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Upload Video
        </button>
      </div>

      {/* Search & Status Filter */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by project title or filename..."
            aria-label="Search projects"
            className="w-full rounded-lg border border-white/15 bg-[#131720] pl-9 pr-4 py-2 text-sm text-white placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
          />
        </div>

        <div className="inline-flex rounded-lg border border-white/10 bg-[#131720] p-1 self-start">
          {(
            [
              ['all', 'All'],
              ['ready', 'Ready'],
              ['queued', 'In Progress'],
            ] as const
          ).map(([val, label]) => (
            <button
              key={val}
              type="button"
              onClick={() => setFilter(val)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                filter === val ? 'bg-[#1F2634] text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-[#131720] p-12 text-center">
          <Film className="mx-auto h-8 w-8 text-slate-500" aria-hidden="true" />
          <h3 className="mt-3 font-display text-base font-semibold text-white">
            No matching projects
          </h3>
          <p className="mt-1 text-sm text-slate-400">
            Clear your search filter or upload a new long-form video.
          </p>
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setFilter('all');
            }}
            className="mt-4 rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-xs font-medium text-white hover:bg-white/10"
          >
            Reset Filters
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filtered.map((project) => (
            <div
              key={project.id}
              className="rounded-xl border border-white/10 bg-[#131720] overflow-hidden flex flex-col justify-between"
            >
              <div>
                <div className="relative h-40 bg-[#0B0D11]">
                  {project.video.thumbnailUrl ? (
                    <img
                      src={project.video.thumbnailUrl}
                      alt={project.title}
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-[#0D1017] text-xs text-slate-400">
                      <Film className="h-6 w-6 text-slate-500 mr-2" aria-hidden="true" />
                      Generating preview thumbnail...
                    </div>
                  )}
                </div>

                <div className="p-5">
                  <p className="text-xs text-amber-400">
                    {project.isDemo ? 'Sample Demo Project' : 'Validated Upload'}
                  </p>
                  <h3 className="mt-1 font-display text-base font-semibold text-white">
                    {project.title}
                  </h3>
                  <p className="mt-1.5 text-xs text-slate-400 tabular-nums">
                    {project.video.durationSec > 0
                      ? formatTimecode(project.video.durationSec)
                      : 'Pending duration'}{' '}
                    ·{' '}
                    {project.video.width > 0
                      ? `${project.video.width}x${project.video.height}`
                      : 'Pending probe'}{' '}
                    · {project.video.fileSizeBytes > 0 ? formatBytes(project.video.fileSizeBytes) : 'URL'}
                  </p>
                </div>
              </div>

              <div className="px-5 pb-5 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => onOpenProject(project.id)}
                  className="flex-1 rounded-lg bg-white/5 border border-white/15 px-3 py-2 text-xs font-medium text-white hover:bg-white/10 transition-colors"
                >
                  {project.clips.length > 0
                    ? `Open ${project.clips.length} Clips`
                    : 'Inspect Status'}
                </button>
                {!project.isDemo && (
                  <button
                    type="button"
                    aria-label={`Delete ${project.title}`}
                    onClick={() => onDeleteProject(project.id)}
                    className="rounded-lg border border-white/10 p-2 text-slate-400 hover:text-red-300 hover:bg-red-500/10"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
