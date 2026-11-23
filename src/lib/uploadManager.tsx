import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { apiFetch } from './apiClient';
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  validateImportUrl,
  validateVideoFile,
} from './validation';
import type {
  ClipDurationPreset,
  Project,
  UploadQueueItem,
} from '../types/clipgenius';

export interface ActiveUploadState extends UploadQueueItem {
  file?: File;
  uploadId?: string;
  totalChunks?: number;
  nextChunkIndex: number;
  chunkSizeBytes?: number;
  createdProject?: Project;
}

export interface UploadSummary {
  activeCount: number;
  pausedCount: number;
  completedCount: number;
  errorCount: number;
  overallProgressPct: number;
  hasInFlight: boolean;
}

export function summarizeUploadQueue(queue: ActiveUploadState[]): UploadSummary {
  let activeCount = 0;
  let pausedCount = 0;
  let completedCount = 0;
  let errorCount = 0;
  let inFlightPctSum = 0;

  for (const item of queue) {
    if (item.status === 'uploading' || item.status === 'validating') {
      activeCount += 1;
      inFlightPctSum += Math.max(0, Math.min(100, item.progressPct));
    } else if (item.status === 'paused') {
      pausedCount += 1;
    } else if (item.status === 'queued_phase2') {
      completedCount += 1;
    } else if (item.status === 'error') {
      errorCount += 1;
    }
  }

  const overallProgressPct =
    activeCount > 0 ? Math.round(inFlightPctSum / activeCount) : completedCount > 0 ? 100 : 0;

  return {
    activeCount,
    pausedCount,
    completedCount,
    errorCount,
    overallProgressPct,
    hasInFlight: activeCount > 0,
  };
}

export function upsertQueueItem(
  queue: ActiveUploadState[],
  id: string,
  updater: (item: ActiveUploadState) => ActiveUploadState
): ActiveUploadState[] {
  return queue.map((item) => (item.id === id ? updater(item) : item));
}

export function computeChunkProgressPct(completedChunks: number, totalChunks: number): number {
  const safeTotal = Math.max(1, totalChunks);
  const clamped = Math.max(0, Math.min(safeTotal, completedChunks));
  return Math.min(96, Math.round((clamped / safeTotal) * 95));
}

interface UploadManagerContextValue {
  queue: ActiveUploadState[];
  summary: UploadSummary;
  sourceTab: 'upload' | 'url';
  setSourceTab: (tab: 'upload' | 'url') => void;
  targetDuration: ClipDurationPreset;
  setTargetDuration: (dur: ClipDurationPreset) => void;
  captionLanguage: 'original' | 'en' | 'hinglish';
  setCaptionLanguage: (lang: 'original' | 'en' | 'hinglish') => void;
  uploadError: string | null;
  setUploadError: (msg: string | null) => void;
  urlInput: string;
  setUrlInput: (val: string) => void;
  rightsConfirmed: boolean;
  setRightsConfirmed: (val: boolean) => void;
  urlStatus: { type: 'error' | 'info'; text: string } | null;
  submittingUrl: boolean;
  analysisFeedback: Record<string, string>;
  setProjectAnalysisFeedback: (projectId: string, msg: string) => void;
  enqueueFiles: (files: FileList | File[] | null) => void;
  pauseUpload: (itemId: string) => void;
  resumeOrRetryUpload: (itemId: string) => void;
  removeUploadItem: (itemId: string) => Promise<void>;
  submitUrlImport: (onImported?: (project: Project) => void) => Promise<void>;
}

const UploadManagerContext = createContext<UploadManagerContextValue | null>(null);

interface UploadProviderProps {
  onProjectCreated: (project: Project) => void;
  children: ReactNode;
}

export function UploadProvider({ onProjectCreated, children }: UploadProviderProps) {
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const queueRef = useRef<ActiveUploadState[]>([]);
  const onProjectCreatedRef = useRef(onProjectCreated);
  onProjectCreatedRef.current = onProjectCreated;

  const [queue, setQueue] = useState<ActiveUploadState[]>([]);
  queueRef.current = queue;

  const [sourceTab, setSourceTab] = useState<'upload' | 'url'>('upload');
  const [targetDuration, setTargetDuration] = useState<ClipDurationPreset>(30);
  const targetDurationRef = useRef<ClipDurationPreset>(targetDuration);
  targetDurationRef.current = targetDuration;

  const [captionLanguage, setCaptionLanguage] = useState<'original' | 'en' | 'hinglish'>('en');
  const captionLanguageRef = useRef<'original' | 'en' | 'hinglish'>(captionLanguage);
  captionLanguageRef.current = captionLanguage;

  const [uploadError, setUploadError] = useState<string | null>(null);
  const [analysisFeedback, setAnalysisFeedback] = useState<Record<string, string>>({});

  const [urlInput, setUrlInput] = useState('');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [urlStatus, setUrlStatus] = useState<{ type: 'error' | 'info'; text: string } | null>(
    null
  );
  const [submittingUrl, setSubmittingUrl] = useState(false);

  const summary = useMemo(() => summarizeUploadQueue(queue), [queue]);

  // Warn only on full browser reload/close while an upload is actively transferring
  useEffect(() => {
    if (!summary.hasInFlight && !submittingUrl) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [summary.hasInFlight, submittingUrl]);

  const updateItem = useCallback(
    (id: string, updater: (item: ActiveUploadState) => ActiveUploadState) => {
      setQueue((prev) => upsertQueueItem(prev, id, updater));
    },
    []
  );

  const runChunkedUpload = useCallback(
    async (
      itemId: string,
      file: File,
      startFromChunk: number = 0,
      existingUploadId?: string,
      existingChunkSize?: number,
      existingTotalChunks?: number
    ) => {
      // Cancel any stale controller for this same item before starting
      abortControllersRef.current.get(itemId)?.abort();
      const controller = new AbortController();
      abortControllersRef.current.set(itemId, controller);

      try {
        let uploadId = existingUploadId;
        let chunkSizeBytes = existingChunkSize ?? 2 * 1024 * 1024;
        let totalChunks =
          existingTotalChunks ?? Math.max(1, Math.ceil(file.size / chunkSizeBytes));

        if (!uploadId) {
          updateItem(itemId, (it) => ({
            ...it,
            status: 'uploading',
            errorMessage: undefined,
          }));

          const initRes = await apiFetch('/api/uploads/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filename: file.name,
              fileSizeBytes: file.size,
              mimeType: file.type,
            }),
            signal: controller.signal,
          });

          const initData = await initRes.json();
          if (!initRes.ok) {
            throw new Error(initData.error ?? 'Failed to initialize upload session.');
          }

          uploadId = initData.uploadId;
          chunkSizeBytes = initData.chunkSizeBytes;
          totalChunks = initData.totalChunks;

          updateItem(itemId, (it) => ({
            ...it,
            uploadId,
            chunkSizeBytes,
            totalChunks,
            status: 'uploading',
          }));
        } else {
          updateItem(itemId, (it) => ({
            ...it,
            status: 'uploading',
            errorMessage: undefined,
          }));
        }

        for (let idx = startFromChunk; idx < totalChunks; idx += 1) {
          if (controller.signal.aborted) {
            return;
          }

          const start = idx * chunkSizeBytes;
          const end = Math.min(file.size, start + chunkSizeBytes);
          const chunkBlob = file.slice(start, end);

          const chunkRes = await apiFetch(`/api/uploads/${uploadId}/chunk/${idx}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: chunkBlob,
            signal: controller.signal,
          });

          if (!chunkRes.ok) {
            const errJson = await chunkRes.json().catch(() => ({}));
            throw new Error(errJson.error ?? `Chunk ${idx + 1} failed.`);
          }

          const progressPct = computeChunkProgressPct(idx + 1, totalChunks);
          updateItem(itemId, (it) => ({
            ...it,
            nextChunkIndex: idx + 1,
            progressPct,
          }));
        }

        if (controller.signal.aborted) {
          return;
        }

        updateItem(itemId, (it) => ({
          ...it,
          status: 'validating',
          progressPct: 98,
        }));

        const completeRes = await apiFetch(`/api/uploads/${uploadId}/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            autoAnalyze: true,
            targetDuration: targetDurationRef.current,
            captionLanguage: captionLanguageRef.current,
          }),
          signal: controller.signal,
        });

        const completeData = await completeRes.json();
        if (!completeRes.ok) {
          throw new Error(completeData.error ?? 'FFprobe validation failed.');
        }

        const project: Project = completeData.project;
        updateItem(itemId, (it) => ({
          ...it,
          status: 'queued_phase2',
          progressPct: 100,
          durationSec: project.video.durationSec,
          resolution: `${project.video.width}x${project.video.height}`,
          createdProject: project,
        }));

        onProjectCreatedRef.current(project);
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          return;
        }
        updateItem(itemId, (it) => ({
          ...it,
          status: 'error',
          errorMessage: err instanceof Error ? err.message : 'Upload failed.',
        }));
      } finally {
        if (abortControllersRef.current.get(itemId) === controller) {
          abortControllersRef.current.delete(itemId);
        }
      }
    },
    [updateItem]
  );

  const enqueueFiles = useCallback(
    (files: FileList | File[] | null) => {
      if (!files || files.length === 0) return;
      setUploadError(null);

      for (const file of Array.from(files)) {
        const clientCheck = validateVideoFile(
          { name: file.name, size: file.size, type: file.type },
          DEFAULT_MAX_UPLOAD_BYTES
        );

        if (!clientCheck.valid) {
          setUploadError(clientCheck.error ?? 'Invalid video file.');
          continue;
        }

        const id = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const newItem: ActiveUploadState = {
          id,
          filename: file.name,
          sizeBytes: file.size,
          mimeType: file.type || 'video/mp4',
          progressPct: 0,
          status: 'uploading',
          file,
          nextChunkIndex: 0,
        };

        setQueue((prev) => [newItem, ...prev]);
        void runChunkedUpload(id, file, 0);
      }
    },
    [runChunkedUpload]
  );

  const pauseUpload = useCallback(
    (itemId: string) => {
      abortControllersRef.current.get(itemId)?.abort();
      updateItem(itemId, (it) => ({ ...it, status: 'paused' }));
    },
    [updateItem]
  );

  const resumeOrRetryUpload = useCallback(
    (itemId: string) => {
      const item = queueRef.current.find((q) => q.id === itemId);
      if (!item || !item.file) return;
      void runChunkedUpload(
        item.id,
        item.file,
        item.nextChunkIndex,
        item.uploadId,
        item.chunkSizeBytes,
        item.totalChunks
      );
    },
    [runChunkedUpload]
  );

  const removeUploadItem = useCallback(async (itemId: string) => {
    const item = queueRef.current.find((q) => q.id === itemId);
    abortControllersRef.current.get(itemId)?.abort();
    abortControllersRef.current.delete(itemId);
    if (item?.uploadId && item.status !== 'queued_phase2') {
      await apiFetch(`/api/uploads/${item.uploadId}`, { method: 'DELETE' }).catch(() => {});
    }
    setQueue((prev) => prev.filter((q) => q.id !== itemId));
  }, []);

  const setProjectAnalysisFeedback = useCallback((projectId: string, msg: string) => {
    setAnalysisFeedback((prev) => ({ ...prev, [projectId]: msg }));
  }, []);

  const submitUrlImport = useCallback(
    async (onImported?: (project: Project) => void) => {
      setUrlStatus(null);

      const check = validateImportUrl(urlInput);
      if (!check.valid) {
        setUrlStatus({ type: 'error', text: check.error ?? 'Invalid video URL.' });
        return;
      }

      if (!rightsConfirmed) {
        setUrlStatus({
          type: 'error',
          text: 'Confirm that you hold content rights or authorization before importing this URL.',
        });
        return;
      }

      setSubmittingUrl(true);
      try {
        const res = await apiFetch('/api/uploads/import-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceUrl: urlInput.trim(),
            rightsConfirmed,
            autoAnalyze: true,
            targetDuration: targetDurationRef.current,
            captionLanguage: captionLanguageRef.current,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setUrlStatus({ type: 'error', text: data.error ?? 'URL import failed.' });
          return;
        }

        if (data.requiresConfiguration) {
          setUrlStatus({
            type: 'info',
            text: data.message,
          });
          return;
        }

        if (data.project) {
          const imported: Project = data.project;
          onProjectCreatedRef.current(imported);
          setUrlStatus({
            type: 'info',
            text: `Imported and FFprobe verified "${imported.title}". Opening in AI Editor...`,
          });
          onImported?.(imported);
        }
      } catch {
        setUrlStatus({ type: 'error', text: 'Unable to reach media import endpoint.' });
      } finally {
        setSubmittingUrl(false);
      }
    },
    [urlInput, rightsConfirmed]
  );

  const value = useMemo<UploadManagerContextValue>(
    () => ({
      queue,
      summary,
      sourceTab,
      setSourceTab,
      targetDuration,
      setTargetDuration,
      captionLanguage,
      setCaptionLanguage,
      uploadError,
      setUploadError,
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
    }),
    [
      queue,
      summary,
      sourceTab,
      targetDuration,
      captionLanguage,
      uploadError,
      urlInput,
      rightsConfirmed,
      urlStatus,
      submittingUrl,
      analysisFeedback,
      setProjectAnalysisFeedback,
      enqueueFiles,
      pauseUpload,
      resumeOrRetryUpload,
      removeUploadItem,
      submitUrlImport,
    ]
  );

  return (
    <UploadManagerContext.Provider value={value}>
      {children}
    </UploadManagerContext.Provider>
  );
}

export function useUploadManager(): UploadManagerContextValue {
  const ctx = useContext(UploadManagerContext);
  if (!ctx) {
    throw new Error('useUploadManager must be used within an UploadProvider');
  }
  return ctx;
}
