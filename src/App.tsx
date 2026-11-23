import { useEffect, useRef, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { AppShell, type WorkspaceTab } from './components/AppShell';
import { AuthView, type AuthScreenMode } from './components/AuthView';
import { CreateClipsView } from './components/CreateClipsView';
import { DashboardView } from './components/DashboardView';
import { EditorPreviewView } from './components/EditorPreviewView';
import { LandingPage } from './components/LandingPage';
import { ProjectsView } from './components/ProjectsView';
import {
  BrandKitView,
  SettingsView,
  TemplatesView,
} from './components/TemplatesBrandSettingsViews';
import {
  INITIAL_BRAND_KIT,
  SAMPLE_DEMO_PROJECT,
  SAMPLE_USAGE_RECORD,
} from './data/demoProject';
import { apiFetch, clearAuthTokenProvider, setAuthTokenProvider } from './lib/apiClient';
import { auth, signOutFirebase } from './lib/firebase';
import { UploadProvider } from './lib/uploadManager';
import type {
  AnalysisTriggerResult,
  AspectRatio,
  BrandKit,
  CaptionStylePreset,
  Clip,
  ClipDurationPreset,
  Project,
  Transcript,
  User,
} from './types/clipgenius';

type SurfaceMode = 'landing' | 'auth' | 'app';

const DEFAULT_DEMO_USER: User = {
  id: 'demo_user',
  email: 'demo@clipgenius.local',
  name: 'Studio Preview',
  plan: 'creator',
  role: 'creator',
  createdAt: '2026-11-18T00:00:00Z',
};

export default function App() {
  const [surface, setSurface] = useState<SurfaceMode>('landing');
  const [authMode, setAuthMode] = useState<AuthScreenMode>('signin');
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('dashboard');
  const activeTabRef = useRef<WorkspaceTab>(activeTab);
  activeTabRef.current = activeTab;
  const [user, setUser] = useState<User>(DEFAULT_DEMO_USER);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const authMethodRef = useRef<'none' | 'google' | 'email'>('none');
  const [projects, setProjects] = useState<Project[]>([SAMPLE_DEMO_PROJECT]);
  const [activeProjectId, setActiveProjectId] = useState<string>(SAMPLE_DEMO_PROJECT.id);
  const [selectedEditorClipId, setSelectedEditorClipId] = useState<string | undefined>(
    SAMPLE_DEMO_PROJECT.clips[0].id
  );
  const [brandKit, setBrandKit] = useState<BrandKit>(INITIAL_BRAND_KIT);
  const [bannerNotice, setBannerNotice] = useState<string | null>(null);
  const [exportsCompleted, setExportsCompleted] = useState<number>(
    SAMPLE_USAGE_RECORD.exportsCompleted
  );

  async function refreshWorkspaceData() {
    try {
      const [projRes, expRes] = await Promise.all([
        apiFetch('/api/projects'),
        apiFetch('/api/exports'),
      ]);
      if (projRes.ok) {
        const data = (await projRes.json()) as { projects?: Project[] };
        if (Array.isArray(data.projects) && data.projects.length > 0) {
          setProjects(data.projects);
        }
      }
      if (expRes.ok) {
        const expData = (await expRes.json()) as { jobs?: { status: string }[] };
        if (Array.isArray(expData.jobs)) {
          setExportsCompleted(expData.jobs.filter((j) => j.status === 'completed').length);
        }
      }
    } catch {
      // Keep local fallback state on transient errors
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === '1') {
      setSurface('app');
      setActiveTab('dashboard');
    }

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        try {
          const token = await firebaseUser.getIdToken();
          authMethodRef.current = 'google';
          setAuthTokenProvider(() => firebaseUser.getIdToken(), token);
          setIsAuthenticated(true);

          const meRes = await apiFetch('/api/me');
          if (meRes.ok) {
            const meData = (await meRes.json()) as {
              user?: User;
              brandKit?: BrandKit | null;
              exportsCompleted?: number;
            };
            if (meData.user) setUser(meData.user);
            if (meData.brandKit) setBrandKit(meData.brandKit);
            if (typeof meData.exportsCompleted === 'number') {
              setExportsCompleted(meData.exportsCompleted);
            }
          } else {
            setUser({
              id: firebaseUser.uid,
              email: firebaseUser.email ?? 'creator@clipgenius.app',
              name: firebaseUser.displayName ?? 'ClipGenius Creator',
              plan: 'creator',
              role: 'creator',
              createdAt: new Date().toISOString(),
            });
          }
          await refreshWorkspaceData();
          setSurface((prev) => (prev === 'auth' ? 'app' : prev));
        } catch {
          await refreshWorkspaceData();
          setSurface((prev) => (prev === 'auth' ? 'app' : prev));
        }
      } else if (authMethodRef.current !== 'email') {
        authMethodRef.current = 'none';
        clearAuthTokenProvider();
        setIsAuthenticated(false);
        setUser(DEFAULT_DEMO_USER);
        setBrandKit(INITIAL_BRAND_KIT);
        await refreshWorkspaceData();
      }
    });

    return () => unsubscribe();
  }, []);

  function handleProjectUpdated(updated: Project) {
    setProjects((prev) =>
      prev.map((proj) => (proj.id === updated.id ? updated : proj))
    );
    if (updated.id === activeProjectId && updated.clips.length > 0) {
      setSelectedEditorClipId((prevClipId) =>
        prevClipId && updated.clips.some((c) => c.id === prevClipId)
          ? prevClipId
          : updated.clips[0].id
      );
    }
  }

  // Subscribe via SSE to any project actively running the 7-stage Phase 3 pipeline
  const processingProjectIds = projects
    .filter((p) => !p.isDemo && p.status === 'processing')
    .map((p) => p.id)
    .join(',');

  useEffect(() => {
    if (!processingProjectIds) return;
    const ids = processingProjectIds.split(',').filter(Boolean);
    const sources = ids.map((id) => {
      const es = new EventSource(`/api/projects/${encodeURIComponent(id)}/events`);
      es.addEventListener('project', (evt) => {
        try {
          const updated = JSON.parse((evt as MessageEvent).data) as Project;
          handleProjectUpdated(updated);
          if (updated.status === 'ready' && updated.transcript) {
            setBannerNotice(
              `AI analysis complete for "${updated.title}": ${updated.clips.length} ranked clip(s) ready in AI Editor.`
            );
          }
        } catch {
          // Ignore malformed SSE event payload
        }
      });
      return es;
    });

    return () => {
      for (const es of sources) {
        es.close();
      }
    };
  }, [processingProjectIds, activeProjectId]);

  const activeProject =
    projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? SAMPLE_DEMO_PROJECT;

  function handleEnterDemoStudio(clipId?: string) {
    setActiveProjectId(SAMPLE_DEMO_PROJECT.id);
    if (clipId) {
      setSelectedEditorClipId(clipId);
    } else {
      setSelectedEditorClipId(SAMPLE_DEMO_PROJECT.clips[0].id);
    }
    setActiveTab('editor');
    setBannerNotice(SAMPLE_DEMO_PROJECT.demoNotice ?? null);
    setSurface('app');
  }

  function handleOpenAuth(mode: AuthScreenMode = 'signin') {
    if (isAuthenticated) {
      setSurface('app');
      return;
    }
    setAuthMode(mode);
    setSurface('auth');
  }

  function handleAuthenticated(
    nextUser: User,
    options?: {
      isAuthenticatedAccount?: boolean;
      authMethod?: 'none' | 'google' | 'email';
      brandKit?: BrandKit | null;
      exportsCompleted?: number;
      notice?: string;
    }
  ) {
    authMethodRef.current =
      options?.authMethod ?? (options?.isAuthenticatedAccount ? 'google' : 'none');
    setUser(nextUser);
    setIsAuthenticated(Boolean(options?.isAuthenticatedAccount));
    if (options?.brandKit) {
      setBrandKit(options.brandKit);
    }
    if (typeof options?.exportsCompleted === 'number') {
      setExportsCompleted(options.exportsCompleted);
    }
    setBannerNotice(options?.notice ?? null);
    setActiveTab('dashboard');
    setSurface('app');
    void refreshWorkspaceData();
  }

  async function handleSignOut() {
    if (authMethodRef.current === 'google') {
      await signOutFirebase().catch(() => {});
    }
    authMethodRef.current = 'none';
    clearAuthTokenProvider();
    setIsAuthenticated(false);
    setUser(DEFAULT_DEMO_USER);
    setBrandKit(INITIAL_BRAND_KIT);
    setBannerNotice(null);
    setSurface('landing');
  }

  async function handleSaveBrandKit(
    next: BrandKit
  ): Promise<{ ok: boolean; message: string }> {
    setBrandKit(next);
    if (!isAuthenticated) {
      return {
        ok: true,
        message: 'Saved to preview session · Sign in to save across sessions',
      };
    }
    try {
      const res = await apiFetch('/api/brand-kit', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const data = (await res.json().catch(() => ({}))) as {
        brandKit?: BrandKit;
        error?: string;
      };
      if (!res.ok) {
        return {
          ok: false,
          message: data.error || 'Unable to save Brand Kit to your account.',
        };
      }
      if (data.brandKit) {
        setBrandKit(data.brandKit);
      }
      return {
        ok: true,
        message: 'Saved to your ClipGenius account',
      };
    } catch {
      return {
        ok: false,
        message: 'Network error while saving Brand Kit.',
      };
    }
  }

  function handleOpenProjectInEditor(projectId: string, clipId?: string) {
    const found = projects.find((p) => p.id === projectId);
    setActiveProjectId(projectId);
    if (clipId) {
      setSelectedEditorClipId(clipId);
    } else if (found?.clips[0]) {
      setSelectedEditorClipId(found.clips[0].id);
    }
    setActiveTab('editor');
  }

  function handleUpdateClip(clipId: string, patch: Partial<Clip>) {
    setProjects((prev) =>
      prev.map((proj) => {
        if (proj.id !== activeProject.id) return proj;
        return {
          ...proj,
          clips: proj.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
        };
      })
    );
  }

  function handleUpdateProjectTranscript(projectId: string, transcript: Transcript) {
    setProjects((prev) =>
      prev.map((proj) => (proj.id === projectId ? { ...proj, transcript } : proj))
    );
  }

  function handleProjectCreated(newProject: Project) {
    setProjects((prev) => [newProject, ...prev.filter((p) => p.id !== newProject.id)]);
    // Do not abruptly switch the active project if the user is mid-edit in AI Editor
    if (activeTabRef.current !== 'editor') {
      setActiveProjectId(newProject.id);
      if (newProject.clips[0]) {
        setSelectedEditorClipId(newProject.clips[0].id);
      }
    }
    setBannerNotice(
      newProject.status === 'processing'
        ? `"${newProject.title}" uploaded & FFprobe verified. AI is analyzing the full video audio to detect speech, sound events, and recommend the best clips...`
        : `"${newProject.title}" uploaded & FFprobe verified (${newProject.video.width}x${newProject.video.height}, ${newProject.video.fps}fps). Ready for AI analysis or editing.`
    );
  }

  async function handleStartAnalysis(
    projectId: string,
    targetClipDurationSec: ClipDurationPreset = 30,
    resume: boolean = true,
    captionLanguage?: string
  ): Promise<AnalysisTriggerResult> {
    try {
      const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetClipDurationSec, resume, captionLanguage }),
      });
      const data = (await res.json()) as AnalysisTriggerResult;
      if (data.project) {
        handleProjectUpdated(data.project);
      }
      return data;
    } catch {
      return { error: 'Unable to reach AI analysis pipeline endpoint.' };
    }
  }

  async function handleDeleteProject(projectId: string) {
    await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }).catch(
      () => {}
    );
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    if (activeProjectId === projectId) {
      setActiveProjectId(SAMPLE_DEMO_PROJECT.id);
    }
  }

  function handleApplyTemplate(preset: CaptionStylePreset, ratio: AspectRatio) {
    const targetClipId = selectedEditorClipId ?? activeProject.clips[0]?.id;
    if (!targetClipId) return;
    handleUpdateClip(targetClipId, { captionStyle: preset, aspectRatio: ratio });
    setSelectedEditorClipId(targetClipId);
    setActiveTab('editor');
  }

  return (
    <UploadProvider onProjectCreated={handleProjectCreated}>
      {surface === 'landing' ? (
        <LandingPage
          isAuthenticated={isAuthenticated}
          onOpenWorkspace={() => setSurface('app')}
          onOpenAuth={(mode) => handleOpenAuth(mode)}
          onEnterDemoStudio={handleEnterDemoStudio}
        />
      ) : surface === 'auth' ? (
        <AuthView
          initialMode={authMode}
          onBackToLanding={() => setSurface('landing')}
          onAuthenticated={handleAuthenticated}
        />
      ) : (
        <AppShell
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          onOpenProjectInEditor={(id) => handleOpenProjectInEditor(id)}
          user={user}
          isAuthenticated={isAuthenticated}
          onOpenAuth={handleOpenAuth}
          onSignOut={() => void handleSignOut()}
          bannerNotice={bannerNotice}
          onDismissBanner={() => setBannerNotice(null)}
        >
          {activeTab === 'dashboard' && (
            <DashboardView
              user={user}
              projects={projects}
              usage={{ ...SAMPLE_USAGE_RECORD, exportsCompleted }}
              onNavigateToCreate={() => setActiveTab('create')}
              onOpenProjectInEditor={handleOpenProjectInEditor}
              onNavigateToProjects={() => setActiveTab('projects')}
            />
          )}

          {activeTab === 'create' && (
            <CreateClipsView
              projects={projects}
              onStartAnalysis={handleStartAnalysis}
              onOpenProjectInEditor={(id) => handleOpenProjectInEditor(id)}
              onOpenSampleEditor={() => handleOpenProjectInEditor(SAMPLE_DEMO_PROJECT.id)}
            />
          )}

          {activeTab === 'projects' && (
            <ProjectsView
              projects={projects}
              onOpenProject={(id) => handleOpenProjectInEditor(id)}
              onDeleteProject={(id) => void handleDeleteProject(id)}
              onCreateNew={() => setActiveTab('create')}
            />
          )}

          {activeTab === 'editor' && (
            <EditorPreviewView
              project={activeProject}
              allProjects={projects}
              onSwitchProject={(id) => handleOpenProjectInEditor(id)}
              initialClipId={selectedEditorClipId}
              brandKit={brandKit}
              onUpdateClip={handleUpdateClip}
              onUpdateProjectTranscript={handleUpdateProjectTranscript}
              onStartAnalysis={handleStartAnalysis}
              onExportCompleted={setExportsCompleted}
              onNavigateToCreate={() => setActiveTab('create')}
            />
          )}

          {activeTab === 'templates' && <TemplatesView onApplyTemplate={handleApplyTemplate} />}

          {activeTab === 'brandkit' && (
            <BrandKitView
              brandKit={brandKit}
              isAuthenticated={isAuthenticated}
              onSaveBrandKit={handleSaveBrandKit}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsView
              user={user}
              isAuthenticated={isAuthenticated}
              onOpenAuth={handleOpenAuth}
              onSignOut={() => void handleSignOut()}
            />
          )}
        </AppShell>
      )}
    </UploadProvider>
  );
}
