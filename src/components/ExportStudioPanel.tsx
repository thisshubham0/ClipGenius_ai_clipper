import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  Clock,
  Download,
  Film,
  Loader2,
  Play,
  RefreshCw,
} from 'lucide-react';
import { apiFetch } from '../lib/apiClient';
import { getCaptionLanguageLabel } from '../lib/captionLanguages';
import {
  ensureClipVersions,
  getBackgroundStyleOption,
  getSoundtrackOption,
  resolveClipBackgroundStyle,
} from '../lib/clipVersions';
import { downloadExportFile } from '../lib/downloadFile';
import {
  EXPORT_FORMAT_OPTIONS,
  EXPORT_QUALITY_OPTIONS,
  getExportFormatOption,
} from '../lib/exportFormats';
import { formatBytes } from '../lib/validation';
import type {
  AspectRatio,
  BrandKit,
  Clip,
  ExportContainerFormat,
  ExportJob,
  ExportQuality,
  Project,
  SocialExportPreset,
} from '../types/clipgenius';

interface SocialPresetSpec {
  id: Exclude<SocialExportPreset, 'custom'>;
  label: string;
  aspectRatio: AspectRatio;
  quality: ExportQuality;
  containerFormat: ExportContainerFormat;
  burnCaptions: boolean;
  meta: string;
}

const SOCIAL_PRESETS: SocialPresetSpec[] = [
  {
    id: 'tiktok',
    label: 'TikTok',
    aspectRatio: '9:16',
    quality: '1080p',
    containerFormat: 'mp4',
    burnCaptions: true,
    meta: '9:16 · 1080p MP4',
  },
  {
    id: 'reels',
    label: 'Reels',
    aspectRatio: '9:16',
    quality: '1080p',
    containerFormat: 'mp4',
    burnCaptions: true,
    meta: '9:16 · 1080p MP4',
  },
  {
    id: 'shorts',
    label: 'Shorts',
    aspectRatio: '9:16',
    quality: '1080p',
    containerFormat: 'mp4',
    burnCaptions: true,
    meta: '9:16 · 1080p MP4',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    aspectRatio: '16:9',
    quality: '1080p',
    containerFormat: 'mp4',
    burnCaptions: true,
    meta: '16:9 · 1080p MP4',
  },
];

interface ExportStudioPanelProps {
  project: Project;
  activeClip: Clip;
  brandKit: BrandKit;
  onPatchClip: (patch: Partial<Clip>) => void;
  onDownloadSrt: () => void;
  onDownloadVtt: () => void;
  onExportCompleted?: (completedCount: number) => void;
  onPreviewRenderedVideo?: (url: string, label: string) => void;
}

function formatExpiryTime(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function ExportStudioPanel({
  project,
  activeClip,
  brandKit,
  onPatchClip,
  onDownloadSrt,
  onDownloadVtt,
  onExportCompleted,
  onPreviewRenderedVideo,
}: ExportStudioPanelProps) {
  const [containerFormat, setContainerFormat] = useState<ExportContainerFormat>('mp4');
  const [exportQuality, setExportQuality] = useState<ExportQuality>('720p');
  const [burnCaptions, setBurnCaptions] = useState(true);
  const [autoSaveOnComplete, setAutoSaveOnComplete] = useState(true);
  const [selectedPreset, setSelectedPreset] = useState<SocialExportPreset>('custom');
  const [selectedBatchClipIds, setSelectedBatchClipIds] = useState<string[]>(() =>
    project.clips.map((c) => c.id)
  );
  const [showClipPicker, setShowClipPicker] = useState(false);

  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [submittingSingle, setSubmittingSingle] = useState(false);
  const [submittingBatch, setSubmittingBatch] = useState(false);
  const [downloadingProgress, setDownloadingProgress] = useState<Record<string, number>>({});
  const [statusMessage, setStatusMessage] = useState<{
    type: 'info' | 'success' | 'error';
    text: string;
  } | null>(null);

  // Track jobs queued during this session so auto-save fires once when they complete
  const autoSavePendingIdsRef = useRef<Set<string>>(new Set());
  const autoSaveEnabledRef = useRef(autoSaveOnComplete);
  autoSaveEnabledRef.current = autoSaveOnComplete;

  useEffect(() => {
    setSelectedBatchClipIds(project.clips.map((c) => c.id));
  }, [project.id, project.clips.length]);

  const hasActiveJobs = jobs.some((j) => j.status === 'queued' || j.status === 'running');

  async function triggerVerifiedDownload(job: ExportJob) {
    if (!job.downloadUrl) {
      setStatusMessage({
        type: 'error',
        text: 'Download link is unavailable. Click Render again to regenerate.',
      });
      return;
    }

    const fmtSpec = getExportFormatOption(job.containerFormat);
    const fallbackName =
      job.kind === 'batch_zip'
        ? `${job.id}_clips.zip`
        : `${job.id}.${fmtSpec.extension}`;
    const filename = job.filename || fallbackName;

    setDownloadingProgress((prev) => ({ ...prev, [job.id]: 1 }));
    try {
      const result = await downloadExportFile({
        url: job.downloadUrl,
        filename,
        kind: job.kind,
        containerFormat: job.containerFormat ?? 'mp4',
        onProgress: (pct) => {
          setDownloadingProgress((prev) => ({ ...prev, [job.id]: pct }));
        },
      });
      setStatusMessage({
        type: 'success',
        text: `Saved "${filename}" (${formatBytes(result.bytesDownloaded)}) — verified playable ${
          job.kind === 'batch_zip' ? 'ZIP archive' : fmtSpec.label
        }.`,
      });
    } catch (err) {
      setStatusMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to save exported file.',
      });
    } finally {
      setDownloadingProgress((prev) => {
        const next = { ...prev };
        delete next[job.id];
        return next;
      });
    }
  }

  async function fetchProjectExports() {
    try {
      const res = await apiFetch(`/api/exports?projectId=${encodeURIComponent(project.id)}`);
      if (!res.ok) return;
      const data = (await res.json()) as { jobs?: ExportJob[] };
      if (Array.isArray(data.jobs)) {
        setJobs(data.jobs);
        const completedCount = data.jobs.filter((j) => j.status === 'completed').length;
        onExportCompleted?.(completedCount);

        // Trigger auto-save once for jobs started in this session
        for (const job of data.jobs) {
          if (
            job.status === 'completed' &&
            job.downloadUrl &&
            autoSavePendingIdsRef.current.has(job.id)
          ) {
            autoSavePendingIdsRef.current.delete(job.id);
            if (autoSaveEnabledRef.current) {
              void triggerVerifiedDownload(job);
            }
          } else if (job.status === 'failed') {
            autoSavePendingIdsRef.current.delete(job.id);
          }
        }
      }
    } catch {
      // Ignore transient poll errors
    }
  }

  useEffect(() => {
    void fetchProjectExports();
  }, [project.id]);

  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = window.setInterval(() => {
      void fetchProjectExports();
    }, 850);
    return () => window.clearInterval(timer);
  }, [hasActiveJobs, project.id]);

  function handleSelectPreset(preset: SocialPresetSpec) {
    setSelectedPreset(preset.id);
    setContainerFormat(preset.containerFormat);
    setExportQuality(preset.quality);
    setBurnCaptions(preset.burnCaptions);
    if (activeClip.aspectRatio !== preset.aspectRatio) {
      onPatchClip({ aspectRatio: preset.aspectRatio });
    }
    setStatusMessage({
      type: 'info',
      text: `Applied ${preset.label} preset (${preset.aspectRatio}, ${preset.quality} ${preset.containerFormat.toUpperCase()}, burned-in captions).`,
    });
  }

  function toggleBatchClip(clipId: string) {
    setSelectedBatchClipIds((prev) =>
      prev.includes(clipId) ? prev.filter((id) => id !== clipId) : [...prev, clipId]
    );
  }

  async function handleQueueSingleExport() {
    setStatusMessage(null);
    setSubmittingSingle(true);
    try {
      const res = await apiFetch(`/api/clips/${encodeURIComponent(activeClip.id)}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quality: exportQuality,
          containerFormat,
          burnCaptions,
          aspectRatio: activeClip.aspectRatio,
          platformPreset: selectedPreset,
          brandKit,
          clipPatch: {
            title: activeClip.title,
            startSec: activeClip.startSec,
            endSec: activeClip.endSec,
            aspectRatio: activeClip.aspectRatio,
            cropOffsetX: activeClip.cropOffsetX,
            autoSpeakerTracking: activeClip.autoSpeakerTracking,
            autoZoom: activeClip.autoZoom,
            cropKeyframes: activeClip.cropKeyframes,
            backgroundBlurFill: activeClip.backgroundBlurFill,
            backgroundStyle: resolveClipBackgroundStyle(activeClip),
            soundtrackId: activeClip.soundtrackId ?? 'none',
            soundtrackVolume: activeClip.soundtrackVolume ?? 0.22,
            versions: activeClip.versions,
            activeVersionId: activeClip.activeVersionId,
            removeSilences: activeClip.removeSilences,
            removeFillers: activeClip.removeFillers,
            captionStyle: activeClip.captionStyle,
            captionOverrides: activeClip.captionOverrides,
            captionText: activeClip.captionText,
            captionTextEdited: activeClip.captionTextEdited,
            subtitleLanguage: activeClip.subtitleLanguage,
            translatedCues: activeClip.translatedCues,
          },
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        requiresConfiguration?: boolean;
        message?: string;
        error?: string;
        job?: ExportJob;
      };
      if (data.requiresConfiguration || data.error) {
        setStatusMessage({
          type: 'error',
          text: data.message ?? data.error ?? 'Unable to start video render.',
        });
        return;
      }
      if (data.job) {
        if (autoSaveOnComplete) {
          autoSavePendingIdsRef.current.add(data.job.id);
        }
        setJobs((prev) => [data.job!, ...prev.filter((j) => j.id !== data.job!.id)]);
      }
    } catch {
      setStatusMessage({
        type: 'error',
        text: 'Unable to reach server render queue endpoint.',
      });
    } finally {
      setSubmittingSingle(false);
    }
  }

  async function handleQueueBatchZip() {
    setStatusMessage(null);
    const clipIdsToExport =
      selectedBatchClipIds.length > 0
        ? selectedBatchClipIds
        : project.clips.map((c) => c.id);

    setSubmittingBatch(true);
    try {
      const res = await apiFetch(`/api/projects/${encodeURIComponent(project.id)}/export-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quality: exportQuality,
          containerFormat,
          burnCaptions,
          clipIds: clipIdsToExport,
          brandKit,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        requiresConfiguration?: boolean;
        message?: string;
        error?: string;
        job?: ExportJob;
      };
      if (data.requiresConfiguration || data.error) {
        setStatusMessage({
          type: 'error',
          text: data.message ?? data.error ?? 'Unable to start batch ZIP render.',
        });
        return;
      }
      if (data.job) {
        if (autoSaveOnComplete) {
          autoSavePendingIdsRef.current.add(data.job.id);
        }
        setJobs((prev) => [data.job!, ...prev.filter((j) => j.id !== data.job!.id)]);
      }
    } catch {
      setStatusMessage({
        type: 'error',
        text: 'Unable to reach batch export endpoint.',
      });
    } finally {
      setSubmittingBatch(false);
    }
  }

  async function handleRetryJob(jobId: string) {
    try {
      const res = await apiFetch(`/api/exports/${encodeURIComponent(jobId)}/retry`, {
        method: 'POST',
      });
      const data = (await res.json()) as { job?: ExportJob };
      if (data.job) {
        if (autoSaveOnComplete) {
          autoSavePendingIdsRef.current.add(jobId);
        }
        setJobs((prev) => prev.map((j) => (j.id === jobId ? data.job! : j)));
      }
    } catch {
      setStatusMessage({
        type: 'error',
        text: 'Unable to retry export job.',
      });
    }
  }

  const activeFormatSpec = getExportFormatOption(containerFormat);
  const activeLang = activeClip.subtitleLanguage || 'original';
  const { versions, activeVersionId } = ensureClipVersions(activeClip);
  const activeVersionObj = versions.find((v) => v.id === activeVersionId) ?? versions[0];
  const activeBgOption = getBackgroundStyleOption(resolveClipBackgroundStyle(activeClip));
  const activeTrackOption = getSoundtrackOption(activeClip.soundtrackId);
  const batchCount =
    selectedBatchClipIds.length > 0 ? selectedBatchClipIds.length : project.clips.length;

  return (
    <div data-testid="export-studio-panel" className="space-y-4">
      {/* Desired Download Format Picker */}
      <div className="rounded-lg border border-white/10 bg-[#0B0D11] p-3.5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-white">Desired Download Format</p>
          <span className="font-mono text-[10px] text-amber-400">
            {activeFormatSpec.codecSummary}
          </span>
        </div>

        <div
          data-testid="format-selector-grid"
          className="grid grid-cols-3 gap-1.5"
        >
          {EXPORT_FORMAT_OPTIONS.map((fmt) => {
            const active = containerFormat === fmt.id;
            return (
              <button
                key={fmt.id}
                type="button"
                data-testid={`format-opt-${fmt.id}`}
                onClick={() => {
                  setContainerFormat(fmt.id);
                  setSelectedPreset('custom');
                }}
                className={`rounded-md px-2.5 py-2 text-left border transition-colors ${
                  active
                    ? 'border-amber-500 bg-amber-500/15 text-white'
                    : 'border-white/10 bg-[#131720] text-slate-300 hover:border-white/25 hover:text-white'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="font-mono text-xs font-semibold">{fmt.label}</span>
                  {fmt.recommended && (
                    <span className="text-[9px] font-semibold uppercase text-amber-400">Best</span>
                  )}
                </div>
                <p className="text-[10px] text-slate-400 truncate mt-0.5">{fmt.shortTag}</p>
              </button>
            );
          })}
        </div>

        {/* One-Click Platform Presets */}
        <div className="pt-2 border-t border-white/10 space-y-2">
          <p className="text-[11px] font-medium text-slate-400">Quick Platform Presets</p>
          <div className="grid grid-cols-2 gap-1.5">
            {SOCIAL_PRESETS.map((preset) => {
              const active = selectedPreset === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => handleSelectPreset(preset)}
                  className={`flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors border whitespace-nowrap ${
                    active
                      ? 'border-amber-500 bg-amber-500/15 text-white'
                      : 'border-white/10 bg-[#131720] text-slate-300 hover:border-white/25 hover:text-white'
                  }`}
                >
                  <span className="text-[11px] font-semibold">{preset.label}</span>
                  <span className="font-mono text-[10px] text-slate-400 tabular-nums">
                    {preset.meta}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Render & Download Controls */}
      <div className="rounded-lg border border-white/10 bg-[#0B0D11] p-3.5 space-y-3.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-white">
            Render &amp; Download · {activeVersionObj?.label ?? 'Ver-1'}
          </p>
          <span className="font-mono text-[11px] text-slate-400 tabular-nums">
            {activeFormatSpec.isAudioOnly ? 'Stereo Audio' : activeClip.aspectRatio} ·{' '}
            {activeFormatSpec.label}
          </span>
        </div>

        <p className="text-[11px] text-slate-400">
          Active edit:{' '}
          <span className="text-slate-200">
            {activeVersionObj?.label} ({activeVersionObj?.name})
          </span>{' '}
          · {activeBgOption.shortLabel} · {activeTrackOption.shortLabel}
        </p>

        {activeFormatSpec.supportsResolution && (
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-slate-400">Resolution</span>
            <div className="inline-flex rounded-md border border-white/10 bg-[#131720] p-0.5">
              {EXPORT_QUALITY_OPTIONS.map((res) => (
                <button
                  key={res}
                  type="button"
                  data-testid={`quality-opt-${res}`}
                  onClick={() => {
                    setExportQuality(res);
                    setSelectedPreset('custom');
                  }}
                  className={`rounded px-2.5 py-1 font-mono text-xs transition-colors ${
                    exportQuality === res
                      ? 'bg-amber-500 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  {res}
                </button>
              ))}
            </div>
          </div>
        )}

        {activeFormatSpec.supportsBurnCaptions && (
          <label className="flex items-center justify-between gap-2 text-xs text-slate-300 cursor-pointer">
            <span>
              Burn styled captions into {activeFormatSpec.label}
              {activeLang !== 'original' ? ` (${getCaptionLanguageLabel(activeLang)})` : ''}
            </span>
            <input
              type="checkbox"
              checked={burnCaptions}
              onChange={(e) => setBurnCaptions(e.target.checked)}
              className="h-4 w-4 rounded border-white/20 accent-amber-500"
            />
          </label>
        )}

        <label className="flex items-center justify-between gap-2 text-xs text-slate-300 cursor-pointer">
          <span>Auto-save file when render finishes</span>
          <input
            type="checkbox"
            checked={autoSaveOnComplete}
            onChange={(e) => setAutoSaveOnComplete(e.target.checked)}
            className="h-4 w-4 rounded border-white/20 accent-amber-500"
          />
        </label>

        {/* Primary Single & Batch All-Clips Action Buttons */}
        <div className="grid grid-cols-1 gap-2 pt-1">
          <button
            type="button"
            data-testid="render-single-btn"
            disabled={submittingSingle}
            onClick={() => void handleQueueSingleExport()}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-3 py-2.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-60 transition-colors whitespace-nowrap"
          >
            {submittingSingle ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Film className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Render &amp; Download Current Clip ({activeFormatSpec.supportsResolution ? `${exportQuality} ` : ''}
            {activeFormatSpec.label})
          </button>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="render-batch-btn"
                disabled={submittingBatch || project.clips.length === 0}
                onClick={() => void handleQueueBatchZip()}
                className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-2.5 text-xs font-medium text-white hover:bg-white/10 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                {submittingBatch ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Archive className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
                )}
                Download All Edited ({batchCount}) as {activeFormatSpec.label} .ZIP
              </button>

              {project.clips.length > 1 && (
                <button
                  type="button"
                  onClick={() => setShowClipPicker((v) => !v)}
                  className="rounded-lg border border-white/15 bg-[#131720] px-2.5 py-2.5 text-[11px] font-medium text-slate-300 hover:text-white whitespace-nowrap"
                >
                  {showClipPicker ? 'Hide' : 'Select'}
                </button>
              )}
            </div>

            {showClipPicker && project.clips.length > 1 && (
              <div className="rounded-md border border-white/10 bg-[#131720] p-2.5 space-y-1.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-slate-400">Clips included in ZIP bundle</span>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedBatchClipIds(
                        selectedBatchClipIds.length === project.clips.length
                          ? [activeClip.id]
                          : project.clips.map((c) => c.id)
                      )
                    }
                    className="text-amber-400 hover:text-amber-300 font-medium"
                  >
                    {selectedBatchClipIds.length === project.clips.length
                      ? 'Current Only'
                      : 'Select All'}
                  </button>
                </div>
                <div className="max-h-32 overflow-y-auto space-y-1">
                  {project.clips.map((c, idx) => {
                    const checked = selectedBatchClipIds.includes(c.id);
                    return (
                      <label
                        key={c.id}
                        className="flex items-center gap-2 text-[11px] text-slate-200 cursor-pointer py-0.5"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleBatchClip(c.id)}
                          className="h-3.5 w-3.5 rounded border-white/20 accent-amber-500"
                        />
                        <span className="truncate">
                          #{idx + 1} · {c.title}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {statusMessage && (
          <div
            role="status"
            className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[11px] ${
              statusMessage.type === 'error'
                ? 'border-rose-500/35 bg-rose-500/10 text-rose-100'
                : statusMessage.type === 'success'
                  ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-100'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-100'
            }`}
          >
            {statusMessage.type === 'success' ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
            ) : (
              <AlertCircle
                className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${
                  statusMessage.type === 'error' ? 'text-rose-400' : 'text-amber-400'
                }`}
                aria-hidden="true"
              />
            )}
            <span>{statusMessage.text}</span>
          </div>
        )}
      </div>

      {/* Live Server Render & Verified Downloads Queue */}
      <div
        data-testid="render-queue"
        className="rounded-lg border border-white/10 bg-[#0B0D11] p-3.5 space-y-2.5"
      >
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-white">Downloads Ready ({jobs.length})</p>
          <span className="text-[11px] text-slate-500">FFprobe verified · Safe save</span>
        </div>

        {jobs.length === 0 ? (
          <p className="text-xs text-slate-500 py-1">
            Choose your desired format above and click Render &amp; Download to create a verified
            playable file.
          </p>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto pr-0.5">
            {jobs.map((job) => {
              const jobFmt = getExportFormatOption(job.containerFormat);
              const dlPct = downloadingProgress[job.id];
              const isSaving = typeof dlPct === 'number';
              return (
                <div
                  key={job.id}
                  data-testid={`export-job-${job.kind}`}
                  className="rounded-md border border-white/10 bg-[#131720] p-2.5 space-y-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-white truncate">{job.clipTitle}</p>
                      <p className="font-mono text-[10px] text-slate-400 mt-0.5">
                        {job.kind === 'batch_zip'
                          ? `${jobFmt.label} ZIP Bundle`
                          : `${jobFmt.isAudioOnly ? 'Audio' : job.aspectRatio} ${jobFmt.label}`}
                        {jobFmt.supportsResolution ? ` · ${job.quality}` : ''}
                        {job.burnCaptions && jobFmt.supportsBurnCaptions
                          ? ' · Burned captions'
                          : ''}
                        {job.fileSizeBytes ? ` · ${formatBytes(job.fileSizeBytes)}` : ''}
                      </p>
                    </div>

                    <div className="shrink-0 flex items-center gap-1.5">
                      {job.status === 'completed' &&
                        job.kind === 'mp4' &&
                        job.previewUrl &&
                        onPreviewRenderedVideo && (
                          <button
                            type="button"
                            onClick={() =>
                              onPreviewRenderedVideo(
                                job.previewUrl!,
                                `${job.aspectRatio} · ${job.quality} ${jobFmt.label}`
                              )
                            }
                            className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/15 px-2 py-1 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/25 whitespace-nowrap"
                          >
                            <Play className="h-3 w-3" aria-hidden="true" />
                            Watch
                          </button>
                        )}
                      {job.status === 'completed' && job.downloadUrl && (
                        <button
                          type="button"
                          disabled={isSaving}
                          data-testid={`save-export-${job.kind}`}
                          onClick={() => void triggerVerifiedDownload(job)}
                          className="inline-flex items-center gap-1 rounded bg-emerald-500 px-2.5 py-1 text-[11px] font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-70 whitespace-nowrap"
                        >
                          {isSaving ? (
                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                          ) : (
                            <Download className="h-3 w-3" aria-hidden="true" />
                          )}
                          {isSaving
                            ? `Saving ${dlPct}%`
                            : job.kind === 'batch_zip'
                              ? 'Save ZIP'
                              : `Save ${jobFmt.label}`}
                        </button>
                      )}
                      {job.status === 'failed' && (
                        <button
                          type="button"
                          onClick={() => void handleRetryJob(job.id)}
                          className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-300 hover:bg-amber-500/20 whitespace-nowrap"
                        >
                          <RefreshCw className="h-3 w-3" aria-hidden="true" />
                          Retry
                        </button>
                      )}
                      {(job.status === 'queued' || job.status === 'running') && (
                        <span className="font-mono text-[11px] text-amber-400 tabular-nums">
                          {job.progressPct}%
                        </span>
                      )}
                    </div>
                  </div>

                  {(job.status === 'queued' || job.status === 'running') && (
                    <div className="space-y-1">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                        <div
                          className="h-full bg-amber-500 transition-all duration-300"
                          style={{ width: `${Math.max(4, job.progressPct)}%` }}
                        />
                      </div>
                      <p className="text-[11px] text-slate-400 truncate">{job.message}</p>
                    </div>
                  )}

                  {job.status === 'completed' && (
                    <div className="flex items-center justify-between text-[11px] text-emerald-400">
                      <span className="inline-flex items-center gap-1 truncate">
                        <CheckCircle2 className="h-3 w-3 shrink-0" aria-hidden="true" />
                        {job.message || 'Verified playable'}
                      </span>
                      {job.expiresAt && (
                        <span className="inline-flex items-center gap-1 text-slate-500 font-mono shrink-0 ml-2">
                          <Clock className="h-3 w-3" aria-hidden="true" />
                          Exp {formatExpiryTime(job.expiresAt)}
                        </span>
                      )}
                    </div>
                  )}

                  {job.status === 'failed' && (
                    <p className="text-[11px] text-rose-400 break-words">
                      {job.error || 'FFmpeg render failed.'}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Standalone Subtitle Tracks */}
      <div className="rounded-lg border border-white/10 bg-[#0B0D11] p-3.5 space-y-2.5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-white">Standalone Subtitle Tracks</p>
          <span className="font-mono text-[10px] text-slate-400 uppercase">
            {activeLang === 'original' ? 'Original' : activeLang}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onDownloadSrt}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs font-medium text-white hover:bg-white/10 whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
            Download .SRT
          </button>
          <button
            type="button"
            onClick={onDownloadVtt}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs font-medium text-white hover:bg-white/10 whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
            Download .VTT
          </button>
        </div>
      </div>
    </div>
  );
}
