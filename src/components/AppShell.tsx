import { useState, type ReactNode } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FolderKanban,
  LayoutDashboard,
  LayoutTemplate,
  LogOut,
  Menu,
  Palette,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Scissors,
  Settings,
  Upload,
  X,
} from 'lucide-react';
import { useUploadManager } from '../lib/uploadManager';
import type { User } from '../types/clipgenius';

export type WorkspaceTab =
  | 'dashboard'
  | 'create'
  | 'projects'
  | 'editor'
  | 'templates'
  | 'brandkit'
  | 'settings';

interface AppShellProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  onOpenProjectInEditor?: (projectId: string) => void;
  user: User;
  isAuthenticated?: boolean;
  onOpenAuth?: () => void;
  onSignOut: () => void;
  bannerNotice?: string | null;
  onDismissBanner?: () => void;
  children: ReactNode;
}

const NAV_ITEMS: { id: WorkspaceTab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'create', label: 'Create Clips', icon: Upload },
  { id: 'projects', label: 'My Projects', icon: FolderKanban },
  { id: 'editor', label: 'AI Editor', icon: Scissors },
  { id: 'templates', label: 'Templates', icon: LayoutTemplate },
  { id: 'brandkit', label: 'Brand Kit', icon: Palette },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const TAB_TITLES: Record<WorkspaceTab, string> = {
  dashboard: 'Dashboard',
  create: 'Create Clips',
  projects: 'My Projects',
  editor: 'AI Editor',
  templates: 'Templates',
  brandkit: 'Brand Kit',
  settings: 'Settings',
};

export function AppShell({
  activeTab,
  onSelectTab,
  onOpenProjectInEditor,
  user,
  isAuthenticated = false,
  onOpenAuth,
  onSignOut,
  bannerNotice,
  onDismissBanner,
  children,
}: AppShellProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [dismissedDockIds, setDismissedDockIds] = useState<string[]>([]);

  const { queue, summary, submittingUrl, pauseUpload, resumeOrRetryUpload } = useUploadManager();

  const dockItems = queue.filter((item) => {
    if (item.status === 'uploading' || item.status === 'validating' || item.status === 'paused') {
      return true;
    }
    return !dismissedDockIds.includes(item.id);
  });

  const showUploadDock =
    activeTab !== 'create' && (dockItems.length > 0 || submittingUrl);

  function handleDismissFinishedDockItems() {
    const finishedIds = dockItems
      .filter((it) => it.status === 'queued_phase2' || it.status === 'error')
      .map((it) => it.id);
    if (finishedIds.length > 0) {
      setDismissedDockIds((prev) => Array.from(new Set([...prev, ...finishedIds])));
    }
  }

  const sidebarContent = (
    <div className="flex h-full flex-col justify-between bg-[#0E1117] border-r border-white/10">
      <div>
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <button
            type="button"
            title="Go to Dashboard"
            onClick={() => {
              onSelectTab('dashboard');
              setMobileNavOpen(false);
            }}
            className="font-display text-lg font-semibold tracking-tight text-white hover:text-amber-300 transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 rounded"
          >
            ClipGenius
          </button>
          <button
            type="button"
            aria-label="Close sidebar"
            onClick={() => setMobileNavOpen(false)}
            className="lg:hidden rounded-md p-1.5 text-slate-400 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav aria-label="Workspace navigation" className="p-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            const showNavUploadPct =
              item.id === 'create' && (summary.hasInFlight || submittingUrl);
            const showNavPaused =
              item.id === 'create' && !showNavUploadPct && summary.pausedCount > 0;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => {
                  onSelectTab(item.id);
                  setMobileNavOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                  active
                    ? 'bg-[#1A202C] text-white'
                    : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
                }`}
              >
                <span className="flex items-center gap-3 min-w-0">
                  <Icon
                    className={`h-4 w-4 shrink-0 ${active ? 'text-amber-400' : 'text-slate-400'}`}
                    aria-hidden="true"
                  />
                  <span className="truncate">{item.label}</span>
                </span>
                {showNavUploadPct && (
                  <span
                    data-testid="nav-upload-progress"
                    className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold text-amber-400 tabular-nums shrink-0"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                    {submittingUrl && !summary.hasInFlight
                      ? 'URL'
                      : `${summary.overallProgressPct}%`}
                  </span>
                )}
                {showNavPaused && (
                  <span className="font-mono text-[10px] text-slate-400 shrink-0">Paused</span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="border-t border-white/10 p-4 space-y-2.5">
        <div className="text-xs">
          <p className="font-medium text-white truncate">{user.name}</p>
          <p className="text-slate-400 truncate">
            {isAuthenticated ? `${user.email} · ${user.plan}` : 'Sample Preview · Guest'}
          </p>
        </div>
        {!isAuthenticated && onOpenAuth && (
          <button
            type="button"
            onClick={onOpenAuth}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-300 hover:bg-amber-500/20 transition-colors"
          >
            Sign In / Create Account
          </button>
        )}
        <button
          type="button"
          onClick={onSignOut}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-white/10 hover:text-white transition-colors"
        >
          <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
          {isAuthenticated ? 'Sign Out' : 'Exit Preview'}
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0B0D11] text-[#F3F4F6] flex">
      {/* Desktop Sidebar (256px) */}
      <aside className="hidden lg:block w-64 shrink-0 sticky top-0 h-screen">
        {sidebarContent}
      </aside>

      {/* Mobile Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70"
            aria-hidden="true"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="relative w-64 max-w-[80vw] h-full z-10">{sidebarContent}</aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-30 border-b border-white/10 bg-[#0B0D11]/95 backdrop-blur-md">
          <div className="flex items-center justify-between gap-4 px-4 sm:px-8 py-3.5">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                aria-label="Open navigation menu"
                onClick={() => setMobileNavOpen(true)}
                className="lg:hidden inline-flex h-10 w-10 items-center justify-center rounded-lg border border-white/15 text-slate-200 hover:bg-white/5"
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="flex items-center gap-2 text-sm min-w-0">
                <span className="text-slate-400 hidden sm:inline">Workspace</span>
                <span className="text-slate-600 hidden sm:inline" aria-hidden="true">
                  /
                </span>
                <h1 className="font-display text-base font-semibold text-white truncate">
                  {TAB_TITLES[activeTab]}
                </h1>
              </div>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <button
                type="button"
                onClick={() => onSelectTab('create')}
                className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                New Project
              </button>
            </div>
          </div>

          {bannerNotice && (
            <div className="border-t border-amber-500/20 bg-amber-500/10 px-4 sm:px-8 py-2 flex items-center justify-between gap-4 text-xs text-amber-100">
              <span>{bannerNotice}</span>
              {onDismissBanner && (
                <button
                  type="button"
                  onClick={onDismissBanner}
                  aria-label="Dismiss notice"
                  className="text-amber-300 hover:text-white shrink-0"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
        </header>

        <main className="flex-1 p-4 sm:p-8 max-w-[1360px] w-full mx-auto">{children}</main>
      </div>

      {/* Persistent Background Upload Dock when navigating away from Create Clips */}
      {showUploadDock && (
        <aside
          data-testid="global-upload-dock"
          aria-label="Background uploads"
          className="fixed bottom-5 right-5 z-40 w-[340px] max-w-[calc(100vw-2rem)] rounded-xl border border-white/15 bg-[#131720]/95 backdrop-blur-md shadow-2xl overflow-hidden"
        >
          <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 border-b border-white/10 bg-[#0E1117]/90">
            <div className="flex items-center gap-2 min-w-0">
              {summary.hasInFlight || submittingUrl ? (
                <Upload className="h-3.5 w-3.5 text-amber-400 animate-pulse shrink-0" aria-hidden="true" />
              ) : summary.errorCount > 0 && summary.pausedCount === 0 ? (
                <AlertCircle className="h-3.5 w-3.5 text-red-400 shrink-0" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
              )}
              <span className="text-xs font-semibold text-white truncate">
                {summary.hasInFlight
                  ? `Uploading in background · ${summary.overallProgressPct}%`
                  : submittingUrl
                    ? 'Importing video URL...'
                    : summary.pausedCount > 0
                      ? `${summary.pausedCount} upload${summary.pausedCount > 1 ? 's' : ''} paused`
                      : summary.errorCount > 0
                        ? 'Upload attention needed'
                        : 'Upload complete'}
              </span>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                aria-label={dockCollapsed ? 'Expand upload dock' : 'Collapse upload dock'}
                onClick={() => setDockCollapsed((c) => !c)}
                className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
              >
                {dockCollapsed ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>
              {!summary.hasInFlight && !submittingUrl && summary.pausedCount === 0 && (
                <button
                  type="button"
                  aria-label="Dismiss upload dock"
                  onClick={handleDismissFinishedDockItems}
                  className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {!dockCollapsed && (
            <div className="divide-y divide-white/10 max-h-60 overflow-y-auto">
              {submittingUrl && (
                <div className="px-3.5 py-2.5 text-xs text-slate-300">
                  Downloading and probing video URL in background...
                </div>
              )}

              {dockItems.slice(0, 3).map((item) => (
                <div key={item.id} className="px-3.5 py-2.5 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-white truncate">{item.filename}</p>
                    <div className="flex items-center gap-1 shrink-0">
                      {item.status === 'uploading' && (
                        <button
                          type="button"
                          aria-label={`Pause ${item.filename}`}
                          onClick={() => pauseUpload(item.id)}
                          className="rounded border border-white/10 bg-white/5 p-1 text-slate-300 hover:bg-white/10 hover:text-white"
                        >
                          <Pause className="h-3 w-3" />
                        </button>
                      )}
                      {item.status === 'paused' && (
                        <button
                          type="button"
                          aria-label={`Resume ${item.filename}`}
                          onClick={() => resumeOrRetryUpload(item.id)}
                          className="rounded border border-white/10 bg-white/5 p-1 text-slate-300 hover:bg-white/10 hover:text-white"
                        >
                          <Play className="h-3 w-3" />
                        </button>
                      )}
                      {item.status === 'error' && (
                        <button
                          type="button"
                          aria-label={`Retry ${item.filename}`}
                          onClick={() => resumeOrRetryUpload(item.id)}
                          className="rounded border border-white/10 bg-white/5 p-1 text-slate-300 hover:bg-white/10 hover:text-white"
                        >
                          <RotateCcw className="h-3 w-3" />
                        </button>
                      )}
                      {item.createdProject && onOpenProjectInEditor && (
                        <button
                          type="button"
                          onClick={() => onOpenProjectInEditor(item.createdProject!.id)}
                          className="rounded bg-amber-500 px-2 py-0.5 text-[11px] font-semibold text-slate-950 hover:bg-amber-400 transition-colors"
                        >
                          Open Editor
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-slate-400 tabular-nums">
                    <span className="truncate">
                      {item.status === 'uploading' &&
                        `Uploading chunk ${Math.min(
                          item.nextChunkIndex + 1,
                          item.totalChunks ?? 1
                        )}/${item.totalChunks ?? 1}`}
                      {item.status === 'validating' && 'Verifying stream with FFprobe...'}
                      {item.status === 'paused' && 'Paused'}
                      {item.status === 'queued_phase2' && 'Uploaded & verified'}
                      {item.status === 'error' && (item.errorMessage ?? 'Upload failed')}
                    </span>
                    <span className="font-mono text-slate-300 shrink-0 ml-2">
                      {item.progressPct}%
                    </span>
                  </div>

                  {item.status !== 'error' && item.status !== 'queued_phase2' && (
                    <div className="h-1 w-full rounded-full bg-white/10 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-150 ${
                          item.status === 'paused' ? 'bg-slate-400' : 'bg-amber-500'
                        }`}
                        style={{ width: `${item.progressPct}%` }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="px-3.5 py-2 border-t border-white/10 bg-[#0E1117]/70 flex items-center justify-between text-[11px]">
            <span className="text-slate-400">
              {dockItems.length > 3 ? `+${dockItems.length - 3} more in queue` : 'Continues across tabs'}
            </span>
            <button
              type="button"
              onClick={() => onSelectTab('create')}
              className="font-medium text-amber-400 hover:text-amber-300 transition-colors"
            >
              View Queue
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}
