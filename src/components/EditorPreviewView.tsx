import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AudioLines,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Film,
  Layers,
  Loader2,
  Mic,
  Music2,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Sparkles,
  Undo2,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { apiFetch } from '../lib/apiClient';
import {
  buildCaptionTextOutlineShadow,
  getSafeCaptionLayoutMetrics,
  hexToRgba,
  resolveCaptionStyle,
  wrapCaptionWords,
} from '../lib/captionStyles';
import {
  applyVersionPatchToClip,
  createNextClipVersionPatch,
  ensureClipVersions,
  getBackgroundStyleOption,
  getSoundtrackOption,
  resolveClipBackgroundStyle,
  syncPatchIntoActiveVersion,
} from '../lib/clipVersions';
import {
  buildCaptionTrackCues,
  buildSpeakerCropKeyframes,
  computeEffectiveTimeline,
  consolidateDisplaySpeakers,
  evaluateCropAtTime,
  filterWordsForCaptions,
  findNextPlayableTime,
  generateSrtFromTranslatedCues,
  generateVttFromTranslatedCues,
  resolveActiveCaptionCueAtTime,
  smoothCropKeyframes,
} from '../lib/editorEngine';
import {
  applyDurationPreset,
  CLIP_DURATION_PRESETS,
  clampClipTrimRange,
  formatTimecode,
  generateSrtFromWords,
  generateVttFromWords,
} from '../lib/scoring';
import { formatBytes } from '../lib/validation';
import type {
  AnalysisTriggerResult,
  AspectRatio,
  BrandKit,
  Clip,
  ClipDurationPreset,
  Project,
  Transcript,
  TranscriptWord,
  TranslatedSubtitleCue,
} from '../types/clipgenius';
import { CaptionStylePanel } from './CaptionStylePanel';
import { ExportStudioPanel } from './ExportStudioPanel';
import { MultiTrackTimeline } from './MultiTrackTimeline';

function hashSignature(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

interface EditorPreviewViewProps {
  project: Project;
  allProjects: Project[];
  onSwitchProject: (projectId: string) => void;
  initialClipId?: string;
  brandKit: BrandKit;
  onUpdateClip: (clipId: string, patch: Partial<Clip>) => void;
  onUpdateProjectTranscript?: (projectId: string, transcript: Transcript) => void;
  onStartAnalysis?: (
    projectId: string,
    targetDuration?: ClipDurationPreset,
    resume?: boolean
  ) => Promise<AnalysisTriggerResult>;
  onExportCompleted?: (completedCount: number) => void;
  onNavigateToCreate?: () => void;
}

const ASPECT_RATIO_CLASSES: Record<AspectRatio, string> = {
  '9:16': 'aspect-[9/16] max-w-[270px]',
  '16:9': 'aspect-video max-w-[540px]',
  '1:1': 'aspect-square max-w-[360px]',
  '4:5': 'aspect-[4/5] max-w-[310px]',
};

const DEFAULT_WAVEFORM = Array.from({ length: 48 }, (_, idx) =>
  Math.round(28 + Math.abs(Math.sin(idx * 0.45) * 48) + ((idx * 17) % 18))
);

export function EditorPreviewView({
  project,
  allProjects,
  onSwitchProject,
  initialClipId,
  brandKit,
  onUpdateClip,
  onUpdateProjectTranscript,
  onStartAnalysis,
  onExportCompleted,
  onNavigateToCreate,
}: EditorPreviewViewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bgVideoRef = useRef<HTMLVideoElement | null>(null);
  const soundtrackAudioRef = useRef<HTMLAudioElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const pendingPatchRef = useRef<{ clipId: string; patch: Partial<Clip> } | null>(null);

  const clips = project.clips;
  const [selectedClipId, setSelectedClipId] = useState<string>(
    initialClipId && clips.some((c) => c.id === initialClipId)
      ? initialClipId
      : clips[0]?.id ?? ''
  );

  useEffect(() => {
    if (initialClipId && clips.some((c) => c.id === initialClipId)) {
      setSelectedClipId(initialClipId);
    } else if (clips[0]) {
      setSelectedClipId(clips[0].id);
    }
  }, [project.id, initialClipId]);

  useEffect(() => {
    if (clips.length > 0 && !clips.some((c) => c.id === selectedClipId)) {
      setSelectedClipId(clips[0].id);
    }
  }, [clips, selectedClipId]);

  const activeClip = clips.find((c) => c.id === selectedClipId) ?? clips[0];

  const [inspectorTab, setInspectorTab] = useState<
    'score' | 'transcript' | 'style' | 'metadata' | 'export'
  >('score');
  const [targetAnalysisDuration, setTargetAnalysisDuration] = useState<ClipDurationPreset>(30);
  const [platformTab, setPlatformTab] = useState<'tiktok' | 'reels' | 'shorts' | 'linkedin'>(
    'tiktok'
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [directVideoFallback, setDirectVideoFallback] = useState(false);
  const [previewMode, setPreviewMode] = useState<'live' | 'rendered'>('live');
  const [renderedVersion, setRenderedVersion] = useState(0);
  const [renderedExportPreview, setRenderedExportPreview] = useState<{
    url: string;
    label: string;
  } | null>(null);
  const [playbackNotice, setPlaybackNotice] = useState<string | null>(null);
  const [playheadOffsetSec, setPlayheadOffsetSec] = useState(0);

  const [startDraft, setStartDraft] = useState('');
  const [endDraft, setEndDraft] = useState('');

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [analyzeStatusMsg, setAnalyzeStatusMsg] = useState<string | null>(null);
  const [detectingVoice, setDetectingVoice] = useState(false);
  const [voiceDetectMsg, setVoiceDetectMsg] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  useEffect(() => {
    setVoiceDetectMsg(null);
  }, [selectedClipId]);

  const [undoStack, setUndoStack] = useState<Partial<Clip>[]>([]);
  const [redoStack, setRedoStack] = useState<Partial<Clip>[]>([]);

  const clipVersionsInfo = useMemo(
    () => (activeClip ? ensureClipVersions(activeClip) : { versions: [], activeVersionId: '' }),
    [activeClip]
  );
  const activeVersionObj =
    clipVersionsInfo.versions.find((v) => v.id === clipVersionsInfo.activeVersionId) ??
    clipVersionsInfo.versions[0];
  const resolvedBgStyle = activeClip ? resolveClipBackgroundStyle(activeClip) : 'fill_crop';
  const activeBgOption = getBackgroundStyleOption(resolvedBgStyle);
  const activeSoundtrackId = activeClip?.soundtrackId ?? 'none';
  const activeSoundtrackOption = getSoundtrackOption(activeSoundtrackId);
  const activeSoundtrackVolume = activeClip?.soundtrackVolume ?? 0.22;

  const clipDurationSec = activeClip
    ? Math.max(5, Number((activeClip.endSec - activeClip.startSec).toFixed(2)))
    : 30;

  const isPlayingRenderedMp4 = Boolean(renderedExportPreview || previewMode === 'rendered');

  const editSignatureKey = useMemo(() => {
    if (!activeClip) return 'none';
    return JSON.stringify({
      id: activeClip.id,
      ver: clipVersionsInfo.activeVersionId,
      s: activeClip.startSec,
      e: activeClip.endSec,
      ar: activeClip.aspectRatio,
      x: activeClip.cropOffsetX,
      z: Boolean(activeClip.autoZoom),
      bg: resolvedBgStyle,
      st: activeSoundtrackId,
      sv: activeSoundtrackVolume,
      rs: Boolean(activeClip.removeSilences),
      rf: Boolean(activeClip.removeFillers),
      cs: activeClip.captionStyle,
      co: activeClip.captionOverrides ?? {},
      ct: activeClip.captionText,
      cte: Boolean(activeClip.captionTextEdited),
      lang: activeClip.subtitleLanguage ?? 'original',
      wmP: brandKit.watermarkPosition,
      wmT: brandKit.watermarkText,
      v: renderedVersion,
    });
  }, [
    activeClip,
    clipVersionsInfo.activeVersionId,
    resolvedBgStyle,
    activeSoundtrackId,
    activeSoundtrackVolume,
    brandKit.watermarkPosition,
    brandKit.watermarkText,
    renderedVersion,
  ]);

  const usesTranscodedSegmentSource =
    !project.isDemo &&
    !project.video.mediaUnavailable &&
    (project.video.browserPlayable === false || directVideoFallback);

  const usesSegmentRelativeTime = Boolean(
    isPlayingRenderedMp4 || project.isDemo || usesTranscodedSegmentSource
  );

  const videoSourceUrl = useMemo(() => {
    if (!activeClip) return '';
    if (renderedExportPreview) {
      return renderedExportPreview.url;
    }

    const authSuffix = project.video.previewAuthQuery
      ? `&${project.video.previewAuthQuery}`
      : '';

    if (previewMode === 'rendered') {
      if (!project.isDemo && project.video.mediaUnavailable) {
        return '';
      }
      const wmPos = encodeURIComponent(brandKit.watermarkPosition || 'none');
      const wmText = encodeURIComponent(brandKit.watermarkText || '');
      const hashParam = encodeURIComponent(
        `${hashSignature(editSignatureKey)}_${renderedVersion}`
      );
      return `/api/clips/${encodeURIComponent(activeClip.id)}/preview?mode=edited&burn=1&wmPos=${wmPos}&wmText=${wmText}&h=${hashParam}${authSuffix}`;
    }

    if (project.isDemo) {
      return `/api/demo/video/${encodeURIComponent(activeClip.id)}`;
    }

    if (project.video.mediaUnavailable) {
      return '';
    }

    if (usesTranscodedSegmentSource) {
      return `/api/clips/${encodeURIComponent(activeClip.id)}/preview?mode=source&s=${activeClip.startSec.toFixed(2)}&e=${activeClip.endSec.toFixed(2)}${authSuffix}`;
    }

    if (project.video.previewVideoUrl) {
      return project.video.previewVideoUrl;
    }

    return '';
  }, [
    activeClip,
    renderedExportPreview,
    previewMode,
    project.isDemo,
    project.video.mediaUnavailable,
    project.video.previewAuthQuery,
    project.video.previewVideoUrl,
    usesTranscodedSegmentSource,
    brandKit.watermarkPosition,
    brandKit.watermarkText,
    editSignatureKey,
    renderedVersion,
  ]);

  // Reset clip-level UI when switching clips or projects WITHOUT deadlocking videoReady
  useEffect(() => {
    setPlayheadOffsetSec(0);
    setIsPlaying(false);
    setRenderedExportPreview(null);
    setPlaybackNotice(null);
    setAnalyzeStatusMsg(null);
    if (activeClip) {
      setStartDraft(activeClip.startSec.toFixed(1));
      setEndDraft(activeClip.endSec.toFixed(1));
    }
    const vid = videoRef.current;
    if (vid) {
      vid.pause();
      if (vid.readyState >= 1 && !usesSegmentRelativeTime && activeClip) {
        vid.currentTime = activeClip.startSec;
      } else if (vid.readyState >= 1) {
        vid.currentTime = 0;
      }
    }
    bgVideoRef.current?.pause();
    soundtrackAudioRef.current?.pause();
  }, [selectedClipId, project.id]);

  // Reset direct-stream fallback only when switching projects
  useEffect(() => {
    setDirectVideoFallback(false);
    setPreviewMode('live');
  }, [project.id]);

  // Only reset videoReady / videoFailed when the actual <video src> URL changes
  useEffect(() => {
    setVideoFailed(false);
    setPlaybackNotice(null);
    if (!videoSourceUrl) {
      setVideoReady(false);
      setIsBuffering(false);
      return;
    }
    const vid = videoRef.current;
    if (vid && vid.currentSrc && vid.readyState >= 1) {
      setVideoReady(true);
      setIsBuffering(false);
    } else {
      setVideoReady(false);
      setIsBuffering(true);
    }
  }, [videoSourceUrl]);

  useEffect(() => {
    if (activeClip) {
      setStartDraft(activeClip.startSec.toFixed(1));
      setEndDraft(activeClip.endSec.toFixed(1));
    }
  }, [activeClip?.startSec, activeClip?.endSec]);

  // Keep muted property & soundtrack volume synchronized
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = isMuted;
    }
    if (soundtrackAudioRef.current) {
      soundtrackAudioRef.current.muted = isMuted || isPlayingRenderedMp4;
      soundtrackAudioRef.current.volume = Math.max(0, Math.min(0.65, activeSoundtrackVolume));
    }
  }, [isMuted, activeSoundtrackVolume, isPlayingRenderedMp4, activeSoundtrackId]);

  // Synchronize HTML5 <video> and live soundtrack <audio> when playback changes
  useEffect(() => {
    const vid = videoRef.current;
    const bgVid = bgVideoRef.current;
    const bgm = soundtrackAudioRef.current;
    if (!vid || !videoReady || videoFailed) return;

    if (isPlaying) {
      if (!usesSegmentRelativeTime && activeClip) {
        const targetTime = activeClip.startSec + playheadOffsetSec;
        if (Math.abs(vid.currentTime - targetTime) > 0.6) {
          vid.currentTime = targetTime;
        }
      }
      if (vid.paused) {
        void vid.play().catch((err: unknown) => {
          const errName = err instanceof Error ? err.name : '';
          if (errName === 'NotAllowedError' && !vid.muted) {
            vid.muted = true;
            setIsMuted(true);
            setPlaybackNotice('Muted to start playback — click the speaker icon to unmute.');
            void vid.play().catch(() => {
              setIsPlaying(false);
            });
          } else {
            setIsPlaying(false);
          }
        });
      }
      if (bgVid && bgVid.paused) {
        bgVid.currentTime = vid.currentTime;
        void bgVid.play().catch(() => {});
      }
      if (bgm && !isPlayingRenderedMp4 && activeSoundtrackId !== 'none') {
        bgm.volume = Math.max(0, Math.min(0.65, activeSoundtrackVolume));
        bgm.muted = isMuted;
        if (bgm.paused) {
          void bgm.play().catch(() => {});
        }
      } else if (bgm && !bgm.paused) {
        bgm.pause();
      }
    } else {
      if (!vid.paused) vid.pause();
      if (bgVid && !bgVid.paused) bgVid.pause();
      if (bgm && !bgm.paused) bgm.pause();
    }
  }, [
    isPlaying,
    videoReady,
    videoFailed,
    usesSegmentRelativeTime,
    isPlayingRenderedMp4,
    activeSoundtrackId,
    activeSoundtrackVolume,
    isMuted,
  ]);

  // Fallback timer ONLY when there is no playable video source at all
  useEffect(() => {
    if (!isPlaying || (videoSourceUrl && !videoFailed)) return;
    const timer = window.setInterval(() => {
      setPlayheadOffsetSec((prev) => {
        const next = prev + 0.15;
        return next >= clipDurationSec ? 0 : Number(next.toFixed(2));
      });
    }, 150);
    return () => window.clearInterval(timer);
  }, [isPlaying, videoSourceUrl, videoFailed, clipDurationSec]);

  async function flushPendingClipPatch(): Promise<void> {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingPatchRef.current;
    if (!pending) return;
    pendingPatchRef.current = null;
    try {
      await apiFetch(`/api/clips/${encodeURIComponent(pending.clipId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pending.patch),
      });
      setSaveState('saved');
    } catch {
      setSaveState('idle');
    }
  }

  function persistClipPatch(clipId: string, patch: Partial<Clip>) {
    setSaveState('saving');
    if (pendingPatchRef.current && pendingPatchRef.current.clipId === clipId) {
      pendingPatchRef.current = {
        clipId,
        patch: { ...pendingPatchRef.current.patch, ...patch },
      };
    } else {
      pendingPatchRef.current = { clipId, patch: { ...patch } };
    }
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      void flushPendingClipPatch();
    }, 220);
  }

  function applyPatchWithHistory(patch: Partial<Clip>) {
    if (!activeClip) return;
    const syncedPatch = syncPatchIntoActiveVersion(activeClip, patch);
    const inverse: Partial<Clip> = {};
    for (const key of Object.keys(syncedPatch) as (keyof Clip)[]) {
      (inverse as Record<string, unknown>)[key] = activeClip[key];
    }
    setUndoStack((prev) => [...prev.slice(-19), inverse]);
    setRedoStack([]);
    onUpdateClip(activeClip.id, syncedPatch);
    persistClipPatch(activeClip.id, syncedPatch);
  }

  async function handleDetectClipVoiceEnglish() {
    if (!activeClip) return;
    setVoiceDetectMsg(null);
    setDetectingVoice(true);
    try {
      const res = await apiFetch(`/api/clips/${encodeURIComponent(activeClip.id)}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetLanguage: 'en' }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        requiresConfiguration?: boolean;
        message?: string;
        error?: string;
        language?: string;
        wordsLanguage?: string;
        words?: TranscriptWord[];
        cues?: TranslatedSubtitleCue[];
        captionText?: string;
        speechWordCount?: number;
        soundEventCount?: number;
        speakers?: string[];
        transcript?: Transcript;
      };
      if (data.requiresConfiguration) {
        setVoiceDetectMsg(
          data.message ?? 'Requires GEMINI_API_KEY in server Secrets to detect voices.'
        );
        return;
      }
      if (!res.ok || !data.words || !data.cues) {
        setVoiceDetectMsg(data.error ?? 'Unable to detect voice from this clip audio.');
        return;
      }
      const detectedLang = data.wordsLanguage || data.language || 'en';
      applyPatchWithHistory({
        words: data.words,
        captionText: data.captionText ?? '',
        captionTextEdited: false,
        subtitleLanguage: detectedLang,
        wordsLanguage: detectedLang,
        speaker: data.speakers?.[0] || activeClip.speaker,
        translatedCues: {},
      });
      if (data.transcript && onUpdateProjectTranscript) {
        onUpdateProjectTranscript(project.id, data.transcript);
      }
      const spoken = data.speechWordCount ?? 0;
      const sounds = data.soundEventCount ?? 0;
      setVoiceDetectMsg(
        spoken > 0
          ? `Detected ${spoken} English spoken word(s) across ${data.cues.length} synced subtitle cue(s).`
          : sounds > 0
            ? `No spoken English words found — detected ${sounds} sound event(s).`
            : 'Scanned clip audio — no audible voice detected in this slice.'
      );
    } catch {
      setVoiceDetectMsg('Unable to reach voice detection endpoint.');
    } finally {
      setDetectingVoice(false);
    }
  }

  async function handleSelectVersion(versionId: string) {
    if (!activeClip) return;
    const versionPatch = applyVersionPatchToClip(activeClip, versionId);
    if (!versionPatch) return;
    setRenderedExportPreview(null);
    applyPatchWithHistory(versionPatch);
    if (previewMode === 'rendered') {
      await flushPendingClipPatch();
      setRenderedVersion((v) => v + 1);
      setPlayheadOffsetSec(0);
    }
  }

  async function handleCreateNewVersion() {
    if (!activeClip) return;
    const nextVersionPatch = createNextClipVersionPatch(activeClip);
    setRenderedExportPreview(null);
    applyPatchWithHistory(nextVersionPatch);
    if (previewMode === 'rendered') {
      await flushPendingClipPatch();
      setRenderedVersion((v) => v + 1);
      setPlayheadOffsetSec(0);
    }
  }

  function handleUndo() {
    if (!activeClip || undoStack.length === 0) return;
    const last = undoStack[undoStack.length - 1];
    const redoPatch: Partial<Clip> = {};
    for (const key of Object.keys(last) as (keyof Clip)[]) {
      (redoPatch as Record<string, unknown>)[key] = activeClip[key];
    }
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev, redoPatch]);
    onUpdateClip(activeClip.id, last);
    persistClipPatch(activeClip.id, last);
  }

  function handleRedo() {
    if (!activeClip || redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    const undoPatch: Partial<Clip> = {};
    for (const key of Object.keys(next) as (keyof Clip)[]) {
      (undoPatch as Record<string, unknown>)[key] = activeClip[key];
    }
    setRedoStack((prev) => prev.slice(0, -1));
    setUndoStack((prev) => [...prev, undoPatch]);
    onUpdateClip(activeClip.id, next);
    persistClipPatch(activeClip.id, next);
  }

  const resolvedCaptionStyle = useMemo(
    () => resolveCaptionStyle(activeClip),
    [activeClip?.captionStyle, activeClip?.captionOverrides]
  );

  const captionLayoutMetrics = useMemo(
    () => getSafeCaptionLayoutMetrics(activeClip?.aspectRatio ?? '9:16', resolvedCaptionStyle),
    [activeClip?.aspectRatio, resolvedCaptionStyle]
  );

  const effectiveCropKeyframes = useMemo(() => {
    if (!activeClip) return [];
    if (activeClip.cropKeyframes && activeClip.cropKeyframes.length > 0) {
      return smoothCropKeyframes(activeClip.cropKeyframes, 0.45);
    }
    if (activeClip.autoSpeakerTracking) {
      return buildSpeakerCropKeyframes({
        words: activeClip.words,
        startSec: activeClip.startSec,
        endSec: activeClip.endSec,
        baseOffsetX: activeClip.cropOffsetX,
        autoZoom: Boolean(activeClip.autoZoom),
      });
    }
    return [];
  }, [
    activeClip?.cropKeyframes,
    activeClip?.autoSpeakerTracking,
    activeClip?.words,
    activeClip?.startSec,
    activeClip?.endSec,
    activeClip?.cropOffsetX,
    activeClip?.autoZoom,
  ]);

  const silenceList = project.silences ?? [];
  const effectiveTimeline = useMemo(() => {
    if (!activeClip) {
      return { skippedRanges: [], savedSec: 0, effectiveDurationSec: 30 };
    }
    return computeEffectiveTimeline({
      startSec: activeClip.startSec,
      endSec: activeClip.endSec,
      silences: silenceList,
      removeSilences: Boolean(activeClip.removeSilences),
      words: activeClip.words,
      removeFillers: Boolean(activeClip.removeFillers),
    });
  }, [
    activeClip?.startSec,
    activeClip?.endSec,
    activeClip?.removeSilences,
    activeClip?.removeFillers,
    activeClip?.words,
    silenceList,
  ]);

  const filteredClipWords = useMemo(() => {
    if (!activeClip) return [];
    const clipInRange = activeClip.words.filter(
      (w) => w.endSec > activeClip.startSec && w.startSec < activeClip.endSec
    );
    const projInRange = (project.transcript?.words ?? []).filter(
      (w) => w.endSec > activeClip.startSec && w.startSec < activeClip.endSec
    );
    const baseWords =
      projInRange.length > clipInRange.length &&
      projInRange.some((w) => w.kind !== 'sound_event')
        ? projInRange
        : clipInRange.length > 0
          ? clipInRange
          : activeClip.words;
    return filterWordsForCaptions(baseWords, Boolean(activeClip.removeFillers));
  }, [
    activeClip?.words,
    activeClip?.startSec,
    activeClip?.endSec,
    activeClip?.removeFillers,
    project.transcript?.words,
  ]);

  const activeSubtitleLang = activeClip?.subtitleLanguage || 'original';
  const activeTranslatedCues = useMemo(() => {
    if (!activeClip || activeSubtitleLang === 'original') return undefined;
    // When words[] are already natively detected in the active language, drive captions
    // from exact per-word timestamps instead of static translated cue chunks.
    if (activeClip.wordsLanguage && activeSubtitleLang === activeClip.wordsLanguage) {
      return undefined;
    }
    const cues = activeClip.translatedCues?.[activeSubtitleLang];
    return cues && cues.length > 0 ? cues : undefined;
  }, [activeClip?.translatedCues, activeClip?.wordsLanguage, activeSubtitleLang]);

  const captionTrackCues = useMemo(() => {
    if (!activeClip) return [];
    return buildCaptionTrackCues({
      words: filteredClipWords,
      startSec: activeClip.startSec,
      endSec: activeClip.endSec,
      wordsPerCue: captionLayoutMetrics.effectiveWordsPerCue,
      translatedCues: activeTranslatedCues,
    });
  }, [
    filteredClipWords,
    activeClip?.startSec,
    activeClip?.endSec,
    captionLayoutMetrics.effectiveWordsPerCue,
    activeTranslatedCues,
  ]);

  const transcriptWords = useMemo(() => {
    const clipWords = activeClip?.words ?? [];
    const projWords = project.transcript?.words ?? [];
    const clipSpokenCount = clipWords.filter((w) => w.kind !== 'sound_event').length;
    const projSpokenCount = projWords.filter((w) => w.kind !== 'sound_event').length;
    if (clipSpokenCount > 0 && projSpokenCount === 0) {
      return clipWords;
    }
    if (projWords.length > 0) {
      return projWords;
    }
    return clipWords;
  }, [project.transcript, activeClip?.words]);

  const displaySpeakers = useMemo(
    () => consolidateDisplaySpeakers(transcriptWords, project.transcript?.speakers),
    [transcriptWords, project.transcript?.speakers]
  );

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
      } else if (e.key.toLowerCase() === 'j') {
        e.preventDefault();
        handleSeekOffset(playheadOffsetSec - 1);
      } else if (e.key.toLowerCase() === 'l') {
        e.preventDefault();
        handleSeekOffset(playheadOffsetSec + 1);
      } else if (e.key === '[' && activeClip) {
        e.preventDefault();
        const nextStart = activeClip.startSec + playheadOffsetSec;
        if (activeClip.endSec - nextStart >= 3) {
          commitTrimBounds(String(nextStart), String(activeClip.endSec));
          setPlayheadOffsetSec(0);
        }
      } else if (e.key === ']' && activeClip) {
        e.preventDefault();
        const nextEnd = activeClip.startSec + playheadOffsetSec;
        if (nextEnd - activeClip.startSec >= 3) {
          commitTrimBounds(String(activeClip.startSec), String(nextEnd));
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (!activeClip) {
    return (
      <div className="rounded-xl border border-white/10 bg-[#131720] p-10 text-center space-y-4">
        <h2 className="font-display text-lg font-semibold text-white">
          No editable clip loaded for "{project.title}"
        </h2>
        <p className="text-sm text-slate-400 max-w-lg mx-auto">
          Upload a video master via Create Clips or select an existing project below.
        </p>
        <div className="flex justify-center gap-3">
          {allProjects.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onSwitchProject(p.id)}
              className="rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-xs font-medium text-white hover:bg-white/10"
            >
              Open {p.title}
            </button>
          ))}
        </div>
      </div>
    );
  }

  function handleTogglePlay() {
    if (!activeClip) return;
    const vid = videoRef.current;
    const bgVid = bgVideoRef.current;
    const bgm = soundtrackAudioRef.current;

    if (isPlaying) {
      vid?.pause();
      bgVid?.pause();
      bgm?.pause();
      setIsPlaying(false);
      return;
    }

    setPlaybackNotice(null);
    setIsPlaying(true);

    if (vid && videoSourceUrl && !videoFailed) {
      if (!usesSegmentRelativeTime) {
        const target = activeClip.startSec + playheadOffsetSec;
        if (vid.currentTime < activeClip.startSec || vid.currentTime >= activeClip.endSec - 0.15) {
          vid.currentTime = target;
        }
      }
      // Invoke play() synchronously inside the user gesture to avoid browser autoplay blocks
      const playPromise = vid.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        void playPromise.catch((err: unknown) => {
          const errName = err instanceof Error ? err.name : '';
          if (errName === 'NotAllowedError' && !vid.muted) {
            vid.muted = true;
            setIsMuted(true);
            setPlaybackNotice('Muted to start playback — click the speaker icon to unmute.');
            void vid.play().catch(() => {
              setIsPlaying(false);
            });
          } else if (errName !== 'AbortError') {
            setIsPlaying(false);
          }
        });
      }
      if (bgVid) {
        bgVid.currentTime = vid.currentTime;
        void bgVid.play().catch(() => {});
      }
      if (bgm && !isPlayingRenderedMp4 && activeSoundtrackId !== 'none') {
        bgm.volume = Math.max(0, Math.min(0.65, activeSoundtrackVolume));
        bgm.muted = isMuted;
        void bgm.play().catch(() => {});
      }
    }
  }

  async function handleSwitchPreviewMode(nextMode: 'live' | 'rendered') {
    setRenderedExportPreview(null);
    if (nextMode === 'rendered') {
      soundtrackAudioRef.current?.pause();
      await flushPendingClipPatch();
      setRenderedVersion((v) => v + 1);
      setPlayheadOffsetSec(0);
    }
    setPreviewMode(nextMode);
  }

  function handleSeekOffset(nextOffsetSec: number) {
    const clamped = Math.max(0, Math.min(clipDurationSec, nextOffsetSec));
    setPlayheadOffsetSec(clamped);
    const vid = videoRef.current;
    const bgVid = bgVideoRef.current;
    if (vid && videoReady && !videoFailed) {
      const target = usesSegmentRelativeTime
        ? clamped % Math.max(1, vid.duration || clipDurationSec || 12)
        : activeClip.startSec + clamped;
      vid.currentTime = target;
      if (bgVid) bgVid.currentTime = target;
    }
  }

  function handleVideoTimeUpdate() {
    const vid = videoRef.current;
    if (!vid || !activeClip) return;

    // Rendered FFmpeg MP4 already has trim + silence/filler cuts baked in
    if (isPlayingRenderedMp4) {
      const vidDur = vid.duration || clipDurationSec;
      if (vidDur > 0 && vid.currentTime >= vidDur - 0.1) {
        vid.currentTime = 0;
        setPlayheadOffsetSec(0);
      } else {
        setPlayheadOffsetSec(Number(Math.min(clipDurationSec, vid.currentTime).toFixed(2)));
      }
      return;
    }

    if (usesSegmentRelativeTime) {
      const vidDur = vid.duration || clipDurationSec || 12;
      let nextOffset = Number(Math.min(clipDurationSec, vid.currentTime).toFixed(2));
      const skipTo = findNextPlayableTime(
        activeClip.startSec + nextOffset,
        effectiveTimeline.skippedRanges
      );
      if (skipTo !== null) {
        nextOffset = Math.min(clipDurationSec, Number((skipTo - activeClip.startSec).toFixed(2)));
        vid.currentTime = nextOffset % Math.max(1, vidDur);
      } else if (vidDur > 0 && vid.currentTime >= vidDur - 0.15) {
        vid.currentTime = 0;
        nextOffset = 0;
      }
      setPlayheadOffsetSec(nextOffset);
      return;
    }

    const skipTo = findNextPlayableTime(vid.currentTime, effectiveTimeline.skippedRanges);
    if (skipTo !== null && skipTo < activeClip.endSec) {
      vid.currentTime = skipTo;
      if (bgVideoRef.current) bgVideoRef.current.currentTime = skipTo;
      setPlayheadOffsetSec(Number((skipTo - activeClip.startSec).toFixed(2)));
      return;
    }

    const offset = vid.currentTime - activeClip.startSec;
    if (offset < 0) {
      vid.currentTime = activeClip.startSec;
      setPlayheadOffsetSec(0);
    } else if (offset >= clipDurationSec) {
      vid.currentTime = activeClip.startSec;
      setPlayheadOffsetSec(0);
    } else {
      setPlayheadOffsetSec(Number(offset.toFixed(2)));
    }
  }

  function commitTrimBounds(nextStartRaw: string, nextEndRaw: string) {
    const parsedStart = Number(nextStartRaw);
    const parsedEnd = Number(nextEndRaw);
    const maxDur = Math.max(5, project.video.durationSec || 60);
    const clamped = clampClipTrimRange(
      Number.isFinite(parsedStart) ? parsedStart : activeClip.startSec,
      Number.isFinite(parsedEnd) ? parsedEnd : activeClip.endSec,
      maxDur,
      3
    );
    setStartDraft(clamped.startSec.toFixed(1));
    setEndDraft(clamped.endSec.toFixed(1));
    applyPatchWithHistory(clamped);
    setPlayheadOffsetSec(0);
    if (videoRef.current && videoReady && !videoFailed) {
      videoRef.current.currentTime = usesSegmentRelativeTime ? 0 : clamped.startSec;
    }
  }

  const waveformBars =
    project.video.waveformPeaks && project.video.waveformPeaks.length > 0
      ? project.video.waveformPeaks
      : DEFAULT_WAVEFORM;

  const playheadAbsSec = activeClip.startSec + playheadOffsetSec;

  const activeCrop = evaluateCropAtTime({
    keyframes: effectiveCropKeyframes,
    timeSec: playheadAbsSec,
    fallbackX: activeClip.cropOffsetX,
    autoZoom: Boolean(activeClip.autoZoom),
  });

  const silenceCountInClip = silenceList.filter(
    (s) => s.endSec > activeClip.startSec && s.startSec < activeClip.endSec
  ).length;

  function handleAddCropKeyframe() {
    const timeSec = Number(playheadAbsSec.toFixed(2));
    const existing = activeClip.cropKeyframes && activeClip.cropKeyframes.length > 0
      ? [...activeClip.cropKeyframes]
      : [...effectiveCropKeyframes];
    const withoutNear = existing.filter((k) => Math.abs(k.timeSec - timeSec) > 0.35);
    const nextKeyframes = smoothCropKeyframes(
      [
        ...withoutNear,
        {
          timeSec,
          xPct: activeClip.cropOffsetX,
          zoom: activeClip.autoZoom ? 1.08 : 1,
          speaker: activeClip.speaker,
        },
      ],
      0.45
    );
    applyPatchWithHistory({ cropKeyframes: nextKeyframes, autoSpeakerTracking: true });
  }

  function handleResetCropKeyframes() {
    applyPatchWithHistory({ cropKeyframes: [] });
  }

  // Resolve live audio-derived captions from the exact same captionTrackCues used by the
  // Caption Track and FFmpeg ASS renderer — zero flicker during intra-cue pauses,
  // clean clearing during silent gaps, and exact per-word active highlighting.
  const allowIdlePreviewFallback = !isPlaying && playheadOffsetSec < 0.25;
  const preferManualCaption =
    activeSubtitleLang === 'original' &&
    Boolean(activeClip.captionTextEdited) &&
    activeClip.captionText.trim().length > 0;

  const timedCaptionWindow = preferManualCaption
    ? null
    : resolveActiveCaptionCueAtTime({
        cues: captionTrackCues,
        playheadAbsSec,
        allowIdlePreviewFallback,
      });

  const rawCaptionWords = preferManualCaption
    ? activeClip.captionText.trim().split(/\s+/).filter(Boolean)
    : [];
  const useTimedOverlay = Boolean(timedCaptionWindow && timedCaptionWindow.words.length > 0);
  const isActiveSoundEventCaption = Boolean(useTimedOverlay && timedCaptionWindow?.isSoundEvent);
  const captionWords = useTimedOverlay ? timedCaptionWindow!.words : rawCaptionWords;
  const highlightedWordIdx = useTimedOverlay
    ? timedCaptionWindow!.highlightedIdx
    : rawCaptionWords.length > 0
      ? Math.floor(
          (playheadOffsetSec / Math.max(4, Math.min(12, clipDurationSec))) * rawCaptionWords.length
        ) % rawCaptionWords.length
      : 0;
  const wrappedCaptionLines = useMemo(
    () =>
      isActiveSoundEventCaption
        ? [captionWords]
        : wrapCaptionWords(
            captionWords,
            captionLayoutMetrics.effectiveWordsPerCue,
            captionLayoutMetrics.maxLines
          ),
    [
      isActiveSoundEventCaption,
      captionWords,
      captionLayoutMetrics.effectiveWordsPerCue,
      captionLayoutMetrics.maxLines,
    ]
  );

  async function handleCopy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      setCopiedKey(null);
    }
  }

  function getWordsForSubtitleExport() {
    return filteredClipWords.length > 0
      ? filteredClipWords
      : activeClip.captionText
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((w, i) => ({
            word: w,
            startSec: activeClip.startSec + i * 0.45,
            endSec: activeClip.startSec + (i + 1) * 0.45,
            speaker: activeClip.speaker,
            confidence: 1,
          }));
  }

  function handleDownloadSrt() {
    const srt =
      captionTrackCues.length > 0
        ? generateSrtFromTranslatedCues(
            captionTrackCues.map((c) => ({
              startSec: c.startSec,
              endSec: c.endSec,
              text: c.text,
            })),
            activeClip.startSec
          )
        : generateSrtFromWords(
            getWordsForSubtitleExport(),
            activeClip.startSec,
            captionLayoutMetrics.effectiveWordsPerCue
          );
    const suffix = activeSubtitleLang !== 'original' ? `_${activeSubtitleLang}` : '';
    const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${activeClip.id}${suffix}.srt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function handleDownloadVtt() {
    const vtt =
      captionTrackCues.length > 0
        ? generateVttFromTranslatedCues(
            captionTrackCues.map((c) => ({
              startSec: c.startSec,
              endSec: c.endSec,
              text: c.text,
            })),
            activeClip.startSec
          )
        : generateVttFromWords(
            getWordsForSubtitleExport(),
            activeClip.startSec,
            captionLayoutMetrics.effectiveWordsPerCue
          );
    const suffix = activeSubtitleLang !== 'original' ? `_${activeSubtitleLang}` : '';
    const blob = new Blob([vtt], { type: 'text/vtt;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${activeClip.id}${suffix}.vtt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleAnalyzeProject(resume: boolean = true) {
    setAnalyzeStatusMsg(null);
    if (onStartAnalysis) {
      const data = await onStartAnalysis(project.id, targetAnalysisDuration, resume);
      if (data.requiresConfiguration || data.isDemo || data.error) {
        setAnalyzeStatusMsg(data.message ?? data.error ?? null);
      }
      return;
    }

    try {
      const res = await apiFetch(`/api/projects/${encodeURIComponent(project.id)}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetClipDurationSec: targetAnalysisDuration, resume }),
      });
      const data = (await res.json()) as AnalysisTriggerResult;
      if (data.requiresConfiguration || data.isDemo || data.error) {
        setAnalyzeStatusMsg(data.message ?? data.error ?? null);
      }
    } catch {
      setAnalyzeStatusMsg('Unable to reach AI pipeline endpoint.');
    }
  }

  function handleSeekToAbsoluteTime(absSec: number) {
    if (project.isDemo) {
      handleSeekOffset(Math.max(0, absSec - activeClip.startSec));
      return;
    }
    if (absSec >= activeClip.startSec && absSec <= activeClip.endSec) {
      handleSeekOffset(absSec - activeClip.startSec);
    } else {
      const vid = videoRef.current;
      const bgVid = bgVideoRef.current;
      if (vid && videoReady && !videoFailed) {
        vid.currentTime = absSec;
        if (bgVid) bgVid.currentTime = absSec;
      }
    }
  }

  const progressRatio = clipDurationSec > 0 ? Math.min(1, playheadOffsetSec / clipDurationSec) : 0;

  return (
    <div className="space-y-5">
      {/* Top Studio Header Bar */}
      <div className="rounded-xl border border-white/10 bg-[#131720] p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-amber-400">
              {project.isDemo
                ? 'Sample Demo Project — Illustrative Editor'
                : 'Uploaded Project — FFprobe Verified'}
            </span>
            <span className="text-slate-600" aria-hidden="true">
              ·
            </span>
            <span className="text-slate-400 tabular-nums">
              {project.video.width}x{project.video.height} · {project.video.fps}fps ·{' '}
              {project.video.codec} · {formatBytes(project.video.fileSizeBytes)}
            </span>
            {saveState !== 'idle' && (
              <>
                <span className="text-slate-600" aria-hidden="true">
                  ·
                </span>
                <span className="text-emerald-400">
                  {saveState === 'saving' ? 'Saving...' : 'Saved'}
                </span>
              </>
            )}
          </div>
          <h2 className="mt-1 font-display text-lg font-semibold text-white truncate">
            {activeClip.title}
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {allProjects.length > 1 && (
            <>
              <label htmlFor="project-switcher" className="sr-only">
                Select project
              </label>
              <select
                id="project-switcher"
                value={project.id}
                onChange={(e) => onSwitchProject(e.target.value)}
                className="rounded-lg border border-white/15 bg-[#0B0D11] px-3 py-2 text-xs font-medium text-white max-w-[200px] focus:border-amber-500 focus:outline-none"
              >
                {allProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.isDemo ? 'Demo: ' : ''}
                    {p.title}
                  </option>
                ))}
              </select>
            </>
          )}

          {clips.length > 1 && (
            <>
              <label htmlFor="clip-switcher" className="sr-only">
                Select clip
              </label>
              <select
                id="clip-switcher"
                value={activeClip.id}
                onChange={(e) => setSelectedClipId(e.target.value)}
                className="rounded-lg border border-white/15 bg-[#0B0D11] px-3 py-2 text-xs font-medium text-white max-w-[260px] focus:border-amber-500 focus:outline-none"
              >
                {clips.map((clip, i) => (
                  <option key={clip.id} value={clip.id}>
                    Clip 0{i + 1} · {clip.score.overallEstimate}/100 est. · {clip.title}
                  </option>
                ))}
              </select>
            </>
          )}

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              aria-label="Undo last edit"
              disabled={undoStack.length === 0}
              onClick={handleUndo}
              className="rounded-lg border border-white/15 bg-white/5 p-2 text-slate-200 hover:bg-white/10 disabled:opacity-40"
            >
              <Undo2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="Redo edit"
              disabled={redoStack.length === 0}
              onClick={handleRedo}
              className="rounded-lg border border-white/15 bg-white/5 p-2 text-slate-200 hover:bg-white/10 disabled:opacity-40"
            >
              <Redo2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              data-testid="editor-quick-download-btn"
              onClick={() => setInspectorTab('export')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors whitespace-nowrap"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              Download Video
            </button>
          </div>
        </div>
      </div>

      {/* AI Analysis Live Progress Banner OR Recommended Best Moments Strip */}
      {project.status === 'processing' ? (
        <div
          data-testid="analysis-progress-banner"
          className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        >
          <div className="flex items-start gap-3">
            <Loader2 className="h-5 w-5 text-amber-400 animate-spin shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-white">
                Analyzing full video audio to find the best moments...
              </p>
              <p className="text-xs text-amber-100/90 mt-0.5">
                {project.processingStages.find((s) => s.status === 'running')?.message ??
                  'Detecting spoken words, laughing, singing, humming, crying & ranking standout clips.'}
              </p>
            </div>
          </div>
          <div className="w-full sm:w-48 shrink-0">
            <div className="flex justify-between text-[11px] font-mono text-amber-200 mb-1 tabular-nums">
              <span>Pipeline progress</span>
              <span>
                {project.processingStages.filter((s) => s.status === 'completed').length}/
                {Math.max(7, project.processingStages.length)}
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-black/40 overflow-hidden">
              <div
                className="h-full rounded-full bg-amber-400 transition-all duration-300"
                style={{
                  width: `${Math.max(
                    12,
                    Math.round(
                      (project.processingStages.filter((s) => s.status === 'completed').length /
                        Math.max(7, project.processingStages.length)) *
                        100
                    )
                  )}%`,
                }}
              />
            </div>
          </div>
        </div>
      ) : (
        <section
          data-testid="recommended-moments-strip"
          aria-label="AI Recommended Moments"
          className="rounded-xl border border-white/10 bg-[#131720] p-4 space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-amber-400" aria-hidden="true" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-200">
                {clips.some((c) => c.isAiRecommended)
                  ? `Recommended Best Moments (${clips.length})`
                  : 'Full Video Pending AI Moment Detection'}
              </h3>
            </div>

            {!project.isDemo && !clips.some((c) => c.isAiRecommended) ? (
              <button
                type="button"
                onClick={() => void handleAnalyzeProject(false)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors"
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                Analyze Video &amp; Recommend Best Clips
              </button>
            ) : (
              <span className="text-[11px] text-slate-400">
                Ranked from full-video speech, sound events &amp; scene pacing
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
            {clips.map((clip, idx) => {
              const selected = clip.id === activeClip.id;
              const soundEventCount = clip.words.filter((w) => w.kind === 'sound_event').length;
              return (
                <button
                  key={clip.id}
                  type="button"
                  data-testid={`moment-card-${idx + 1}`}
                  onClick={() => setSelectedClipId(clip.id)}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    selected
                      ? 'border-amber-500 bg-amber-500/10'
                      : 'border-white/10 bg-[#0B0D11] hover:border-white/25'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span
                      className={`font-semibold ${
                        idx === 0 && clip.isAiRecommended ? 'text-amber-400' : 'text-slate-300'
                      }`}
                    >
                      {clip.isAiRecommended
                        ? idx === 0
                          ? '#1 Top Pick'
                          : `#${idx + 1} Recommended`
                        : 'Unanalyzed Range'}
                    </span>
                    <span className="font-mono text-slate-400 tabular-nums">
                      {formatTimecode(clip.startSec)}–{formatTimecode(clip.endSec)}
                      {clip.score.overallEstimate > 0 ? ` · ${clip.score.overallEstimate}/100` : ''}
                    </span>
                  </div>
                  <p className="mt-1 text-xs font-semibold text-white line-clamp-1">
                    {clip.title}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-400 line-clamp-2">
                    {clip.recommendationReason || clip.score.summary}
                  </p>
                  {soundEventCount > 0 && (
                    <p className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-medium text-sky-300">
                      <AudioLines className="h-3 w-3" aria-hidden="true" />
                      {soundEventCount} audio sound{' '}
                      {soundEventCount === 1 ? 'event' : 'events'} detected
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Main Editor Workspace */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left: Video Canvas + Waveform Timeline + Trim Controls */}
        <div className="xl:col-span-7 space-y-5">
          <div className="rounded-xl border border-white/10 bg-[#131720] p-5 sm:p-6">
            {/* Multi-Version Switcher Bar (Ver-1, Ver-2, Ver-3, Ver-4, + New Version) */}
            <div
              data-testid="clip-versions-bar"
              className="mb-3.5 rounded-lg border border-white/10 bg-[#0B0D11] p-2.5 space-y-2"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                {clipVersionsInfo.versions.map((ver) => {
                  const isActiveVer = ver.id === clipVersionsInfo.activeVersionId;
                  return (
                    <button
                      key={ver.id}
                      type="button"
                      data-testid={`version-btn-${ver.label.toLowerCase()}`}
                      onClick={() => void handleSelectVersion(ver.id)}
                      className={`rounded-md px-2.5 py-1 text-xs transition-colors whitespace-nowrap ${
                        isActiveVer
                          ? 'bg-amber-500 text-slate-950 font-semibold'
                          : 'border border-white/10 bg-[#131720] text-slate-300 hover:border-white/25 hover:text-white'
                      }`}
                    >
                      <span>{ver.label}</span>
                      <span
                        className={`ml-1.5 text-[11px] ${
                          isActiveVer ? 'text-slate-900/80' : 'text-slate-400'
                        }`}
                      >
                        {ver.name}
                      </span>
                    </button>
                  );
                })}

                <button
                  type="button"
                  data-testid="add-version-btn"
                  onClick={() => void handleCreateNewVersion()}
                  className="inline-flex items-center gap-1 rounded-md border border-dashed border-white/20 bg-white/5 px-2.5 py-1 text-xs font-medium text-slate-200 hover:border-amber-500/60 hover:text-amber-300 transition-colors whitespace-nowrap"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  New Version
                </button>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
                <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
                  <span className="inline-flex items-center gap-1">
                    <Sparkles className="h-3 w-3 text-amber-400" aria-hidden="true" />
                    <span className="text-slate-200">{resolvedCaptionStyle.label}</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Layers className="h-3 w-3 text-amber-400" aria-hidden="true" />
                    <span className="text-slate-200">{activeBgOption.shortLabel}</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Music2 className="h-3 w-3 text-amber-400" aria-hidden="true" />
                    <span className="text-slate-200">
                      {activeSoundtrackOption.shortLabel}
                      {activeSoundtrackId !== 'none'
                        ? ` (${Math.round(activeSoundtrackVolume * 100)}%)`
                        : ''}
                    </span>
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => setInspectorTab('style')}
                  className="text-[11px] font-medium text-amber-400 hover:text-amber-300 whitespace-nowrap"
                >
                  Customize look &amp; audio
                </button>
              </div>
            </div>

            {/* Hidden Live Soundtrack Audio Track (synced with Live Edit playback; muted in Rendered Edit) */}
            {!isPlayingRenderedMp4 && activeSoundtrackId !== 'none' && (
              <audio
                key={activeSoundtrackId}
                ref={soundtrackAudioRef}
                src={`/api/soundtracks/${encodeURIComponent(activeSoundtrackId)}`}
                loop
                preload="auto"
                className="hidden"
              />
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div className="flex flex-wrap items-center gap-2">
                <div
                  role="group"
                  aria-label="Aspect ratio selector"
                  className="inline-flex rounded-lg border border-white/10 bg-[#0B0D11] p-1"
                >
                  {(['9:16', '16:9', '1:1', '4:5'] as const).map((ratio) => (
                    <button
                      key={ratio}
                      type="button"
                      onClick={() => {
                        setRenderedExportPreview(null);
                        applyPatchWithHistory({ aspectRatio: ratio });
                      }}
                      className={`rounded-md px-3 py-1 text-xs font-mono font-medium transition-colors whitespace-nowrap ${
                        activeClip.aspectRatio === ratio
                          ? 'bg-amber-500 text-slate-950 font-semibold'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      {ratio}
                    </button>
                  ))}
                </div>

                {/* Live Edit vs Actual FFmpeg-Rendered Edit Preview Toggle */}
                <div
                  role="group"
                  aria-label="Preview mode selector"
                  className="inline-flex rounded-lg border border-white/10 bg-[#0B0D11] p-1"
                >
                  <button
                    type="button"
                    onClick={() => void handleSwitchPreviewMode('live')}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                      !isPlayingRenderedMp4
                        ? 'bg-white/15 text-white font-semibold'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Live Edit
                  </button>
                  <button
                    type="button"
                    disabled={!project.isDemo && Boolean(project.video.mediaUnavailable)}
                    onClick={() => void handleSwitchPreviewMode('rendered')}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap disabled:opacity-40 ${
                      isPlayingRenderedMp4
                        ? 'bg-amber-500 text-slate-950 font-semibold'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Film className="h-3 w-3" aria-hidden="true" />
                    Rendered Edit
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label={isMuted ? 'Unmute audio' : 'Mute audio'}
                  onClick={() => setIsMuted((m) => !m)}
                  className="rounded-md border border-white/10 bg-[#0B0D11] p-1.5 text-slate-300 hover:text-white"
                >
                  {isMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                </button>
                <span className="text-xs text-slate-400 tabular-nums font-mono">
                  {formatTimecode(activeClip.startSec + playheadOffsetSec, true)} /{' '}
                  {formatTimecode(activeClip.endSec, true)}
                </span>
              </div>
            </div>

            {isPlayingRenderedMp4 && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                <span className="inline-flex items-center gap-1.5">
                  <Film className="h-3.5 w-3.5 text-amber-400 shrink-0" aria-hidden="true" />
                  {renderedExportPreview
                    ? `Playing exported MP4 (${renderedExportPreview.label}) with burned-in edits`
                    : 'Playing FFmpeg-rendered preview with trim, reframing, silence cuts & burned-in captions'}
                </span>
                <div className="flex items-center gap-2">
                  {!renderedExportPreview && (
                    <button
                      type="button"
                      onClick={() => void handleSwitchPreviewMode('rendered')}
                      className="rounded border border-amber-400/40 bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-200 hover:bg-amber-500/25 whitespace-nowrap"
                    >
                      Re-render with latest edits
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleSwitchPreviewMode('live')}
                    className="rounded border border-white/15 bg-white/5 px-2 py-0.5 text-[11px] text-slate-200 hover:bg-white/10 whitespace-nowrap"
                  >
                    Back to Live Edit
                  </button>
                </div>
              </div>
            )}

            {playbackNotice && (
              <div
                role="status"
                className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-[#0B0D11] px-3 py-2 text-xs text-slate-300"
              >
                <span>{playbackNotice}</span>
                <button
                  type="button"
                  onClick={() => setPlaybackNotice(null)}
                  className="text-[11px] text-amber-400 hover:text-amber-300 shrink-0"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Video Stage */}
            <div className="flex justify-center bg-[#080A0D] rounded-xl border border-white/5 py-6 px-4 min-h-[380px] items-center">
              {!project.isDemo && project.video.mediaUnavailable ? (
                <div
                  data-testid="media-unavailable-banner"
                  className="max-w-md text-center space-y-4 py-8 px-4"
                >
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-400">
                    <AlertCircle className="h-6 w-6" aria-hidden="true" />
                  </div>
                  <div className="space-y-1.5">
                    <h3 className="font-display text-base font-semibold text-white">
                      Source video file needs re-upload
                    </h3>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      This project&apos;s metadata and clip edits are saved, but its temporary video file was cleared after a server restart. Re-upload the video to play and render clips again.
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-center gap-2.5 pt-1">
                    {onNavigateToCreate && (
                      <button
                        type="button"
                        onClick={onNavigateToCreate}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400"
                      >
                        <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                        Upload Video
                      </button>
                    )}
                    {allProjects.some((p) => p.isDemo) && (
                      <button
                        type="button"
                        onClick={() => {
                          const demo = allProjects.find((p) => p.isDemo);
                          if (demo) onSwitchProject(demo.id);
                        }}
                        className="rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-xs font-medium text-white hover:bg-white/10"
                      >
                        Open Sample Demo
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div
                  data-testid="editor-preview-frame"
                  data-aspect-ratio={activeClip.aspectRatio}
                  data-preview-mode={isPlayingRenderedMp4 ? 'rendered' : 'live'}
                  data-background-style={resolvedBgStyle}
                  data-soundtrack={activeSoundtrackId}
                  data-active-version={activeVersionObj?.label ?? 'Ver-1'}
                  style={
                    isPlayingRenderedMp4
                      ? undefined
                      : {
                          background: activeBgOption.stageBgCss,
                        }
                  }
                  className={`group relative w-full overflow-hidden rounded-lg border border-white/15 bg-[#0B0D11] transition-all duration-200 flex items-center justify-center ${
                    ASPECT_RATIO_CLASSES[activeClip.aspectRatio]
                  } ${
                    !isPlayingRenderedMp4 &&
                    activeBgOption.isFramed &&
                    resolvedBgStyle !== 'blur_fill'
                      ? 'p-3'
                      : ''
                  }`}
                >
                  {/* Optional Background Blur Fill Layer (only in live preview; baked into rendered MP4) */}
                  {!isPlayingRenderedMp4 &&
                    resolvedBgStyle === 'blur_fill' &&
                    videoSourceUrl &&
                    !videoFailed && (
                      <video
                        ref={bgVideoRef}
                        src={videoSourceUrl}
                        muted
                        playsInline
                        loop
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 h-full w-full object-cover scale-125 blur-xl opacity-60"
                      />
                    )}

                  {/* Real HTML5 Video Player */}
                  {videoSourceUrl && !videoFailed ? (
                    <video
                      key={videoSourceUrl}
                      ref={videoRef}
                      src={videoSourceUrl}
                      poster={activeClip.thumbnailUrl || undefined}
                      muted={isMuted}
                      playsInline
                      preload="auto"
                      onLoadStart={() => setIsBuffering(true)}
                      onLoadedMetadata={() => {
                        setVideoReady(true);
                        if (videoRef.current && !usesSegmentRelativeTime) {
                          videoRef.current.currentTime = activeClip.startSec;
                        }
                      }}
                      onLoadedData={() => {
                        setVideoReady(true);
                        setIsBuffering(false);
                      }}
                      onCanPlay={() => {
                        setVideoReady(true);
                        setIsBuffering(false);
                      }}
                      onWaiting={() => setIsBuffering(true)}
                      onPlaying={() => {
                        setIsBuffering(false);
                        setIsPlaying(true);
                      }}
                      onPause={() => {
                        setIsPlaying(false);
                        soundtrackAudioRef.current?.pause();
                      }}
                      onTimeUpdate={handleVideoTimeUpdate}
                      onError={() => {
                        // If direct stream failed (e.g. 10-bit x265 / MKV), auto-fallback to on-demand H.264 clip transcoder
                        if (!project.isDemo && !isPlayingRenderedMp4 && !directVideoFallback) {
                          setDirectVideoFallback(true);
                          setIsBuffering(true);
                          setPlaybackNotice(
                            'Converting source clip to browser-compatible H.264 for playback...'
                          );
                          return;
                        }
                        setIsBuffering(false);
                        setIsPlaying(false);
                        setVideoFailed(true);
                        setPlaybackNotice(
                          'Unable to decode this video stream. Try clicking Rendered Edit or re-uploading the video.'
                        );
                      }}
                      style={
                        isPlayingRenderedMp4
                          ? undefined
                          : {
                              objectPosition: `${activeCrop.xPct}% 30%`,
                              transform: activeBgOption.isFramed
                                ? undefined
                                : `scale(${activeCrop.zoom})`,
                              border:
                                activeBgOption.isFramed && resolvedBgStyle !== 'blur_fill'
                                  ? activeBgOption.frameBorderCss
                                  : undefined,
                            }
                      }
                      className={`relative z-0 transition-transform duration-150 ${
                        isPlayingRenderedMp4
                          ? 'h-full w-full object-contain bg-black'
                          : activeBgOption.isFramed
                          ? resolvedBgStyle === 'blur_fill'
                            ? 'h-full w-full object-contain'
                            : 'max-h-full w-full rounded-md object-contain shadow-2xl bg-black/40'
                          : 'h-full w-full object-cover'
                      }`}
                    />
                  ) : (
                    <img
                      src={activeClip.thumbnailUrl}
                      alt={activeClip.title}
                      referrerPolicy="no-referrer"
                      style={{
                        objectPosition: `${activeCrop.xPct}% 30%`,
                        transform: activeBgOption.isFramed ? undefined : `scale(${activeCrop.zoom})`,
                        border:
                          activeBgOption.isFramed && resolvedBgStyle !== 'blur_fill'
                            ? activeBgOption.frameBorderCss
                            : undefined,
                      }}
                      className={`transition-transform duration-150 ${
                        activeBgOption.isFramed
                          ? 'max-h-full w-full rounded-md object-contain'
                          : 'h-full w-full object-cover'
                      }`}
                    />
                  )}

                  {!isPlayingRenderedMp4 && (
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/20"
                    />
                  )}

                  {/* Interactive Stage Play/Pause Overlay Button */}
                  <button
                    type="button"
                    aria-label={isPlaying ? 'Pause video preview' : 'Play video preview'}
                    onClick={handleTogglePlay}
                    className={`absolute inset-0 z-10 flex transition-opacity ${
                      isPlaying && !isBuffering
                        ? 'items-start justify-start p-3 opacity-0 hover:opacity-100 focus:opacity-100'
                        : 'items-center justify-center opacity-100'
                    }`}
                  >
                    {isBuffering ? (
                      <span className="inline-flex items-center gap-2 rounded-lg bg-black/75 border border-white/15 px-3.5 py-2 text-xs font-medium text-white backdrop-blur-sm">
                        <Loader2 className="h-4 w-4 animate-spin text-amber-400" aria-hidden="true" />
                        {isPlayingRenderedMp4
                          ? 'Rendering edited preview...'
                          : usesTranscodedSegmentSource
                          ? 'Preparing playable clip...'
                          : 'Loading video...'}
                      </span>
                    ) : isPlaying ? (
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/70 border border-white/25 text-white shadow-lg backdrop-blur-sm">
                        <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                      </span>
                    ) : (
                      <span
                        className={`flex h-12 w-12 items-center justify-center rounded-full bg-black/70 border border-white/25 text-white shadow-lg backdrop-blur-sm transition-transform group-hover:scale-105 ${
                          !isPlayingRenderedMp4 && resolvedCaptionStyle.position === 'center'
                            ? 'mt-24'
                            : ''
                        }`}
                      >
                        <Play className="h-5 w-5 ml-0.5" aria-hidden="true" />
                      </span>
                    )}
                  </button>

                  {!isPlayingRenderedMp4 &&
                    brandKit.watermarkPosition !== 'none' &&
                    brandKit.watermarkText && (
                      <div
                        className={`pointer-events-none absolute z-20 px-2.5 py-1 text-[11px] font-medium text-white/80 bg-black/45 rounded ${
                          brandKit.watermarkPosition === 'top_right'
                            ? 'top-3 right-3'
                            : brandKit.watermarkPosition === 'top_left'
                            ? 'top-3 left-3'
                            : 'bottom-3 right-3'
                        }`}
                      >
                        {brandKit.watermarkText}
                      </div>
                    )}

                  {/* Live Synced Audio-Derived Caption Overlay (Speech OR Detected Sound Event) */}
                  {!isPlayingRenderedMp4 && captionWords.length > 0 && (
                    <div
                      data-testid="live-caption-overlay"
                      data-caption-kind={isActiveSoundEventCaption ? 'sound_event' : 'speech'}
                      data-caption-position={resolvedCaptionStyle.position}
                      data-caption-align={resolvedCaptionStyle.textAlign}
                      data-caption-font={resolvedCaptionStyle.fontFamily}
                      data-caption-animation={resolvedCaptionStyle.animation}
                      style={{
                        left: `${captionLayoutMetrics.horizontalSafePct}%`,
                        right: `${captionLayoutMetrics.horizontalSafePct}%`,
                        ...(resolvedCaptionStyle.position === 'top'
                          ? { top: `${captionLayoutMetrics.verticalSafePct}%` }
                          : resolvedCaptionStyle.position === 'center'
                            ? { top: '50%', transform: 'translateY(-50%)' }
                            : { bottom: `${captionLayoutMetrics.verticalSafePct}%` }),
                      }}
                      className={`pointer-events-none absolute z-20 flex max-w-full overflow-hidden ${
                        resolvedCaptionStyle.textAlign === 'left'
                          ? 'justify-start'
                          : resolvedCaptionStyle.textAlign === 'right'
                            ? 'justify-end'
                            : 'justify-center'
                      }`}
                    >
                      {isActiveSoundEventCaption ? (
                        <span
                          style={{
                            fontFamily: resolvedCaptionStyle.fontFamily,
                            fontSize: `${Math.max(
                              11,
                              Math.round(captionLayoutMetrics.previewFontSizePx * 0.85)
                            )}px`,
                          }}
                          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-sky-400/40 bg-slate-950/80 px-3 py-1 font-semibold italic text-sky-300 shadow-lg backdrop-blur-sm truncate"
                        >
                          <AudioLines className="h-3.5 w-3.5 text-sky-400 shrink-0" aria-hidden="true" />
                          {captionWords[0]}
                        </span>
                      ) : (
                        <div
                          data-testid="live-caption-box"
                          style={{
                            fontFamily: `"${resolvedCaptionStyle.fontFamily}", sans-serif`,
                            fontSize: `${captionLayoutMetrics.previewFontSizePx}px`,
                            fontWeight: resolvedCaptionStyle.fontWeight,
                            color: resolvedCaptionStyle.primaryColor,
                            textShadow: buildCaptionTextOutlineShadow(
                              resolvedCaptionStyle.strokeColor,
                              resolvedCaptionStyle.strokeWidthPx
                            ),
                            backgroundColor: hexToRgba(
                              resolvedCaptionStyle.backgroundColor,
                              resolvedCaptionStyle.backgroundOpacity
                            ),
                            textAlign: resolvedCaptionStyle.textAlign,
                            padding:
                              resolvedCaptionStyle.backgroundOpacity >= 0.12
                                ? '4px 10px'
                                : '2px 4px',
                            borderRadius:
                              resolvedCaptionStyle.backgroundOpacity >= 0.12 ? '6px' : '0px',
                          }}
                          className={`max-w-full overflow-hidden leading-snug break-words ${
                            resolvedCaptionStyle.uppercase ? 'uppercase tracking-wide' : ''
                          }`}
                        >
                          {(() => {
                            let runningWordIndex = 0;
                            return wrappedCaptionLines.map((lineWords, lineIdx) => (
                              <div
                                key={`line-${lineIdx}`}
                                className={`flex flex-wrap items-baseline gap-x-[0.3em] ${
                                  resolvedCaptionStyle.textAlign === 'left'
                                    ? 'justify-start'
                                    : resolvedCaptionStyle.textAlign === 'right'
                                      ? 'justify-end'
                                      : 'justify-center'
                                }`}
                              >
                                {lineWords.map((word) => {
                                  const idx = runningWordIndex;
                                  runningWordIndex += 1;
                                  const isCurrent = idx === highlightedWordIdx;
                                  const isKaraokeFilled =
                                    resolvedCaptionStyle.animation === 'karaoke' &&
                                    idx <= highlightedWordIdx;
                                  const highlightActive =
                                    resolvedCaptionStyle.animation === 'none'
                                      ? false
                                      : isCurrent || isKaraokeFilled;
                                  return (
                                    <span
                                      key={`${word}-${idx}`}
                                      data-active-word={highlightActive ? 'true' : 'false'}
                                      style={{
                                        color: highlightActive
                                          ? resolvedCaptionStyle.highlightColor
                                          : resolvedCaptionStyle.primaryColor,
                                        transform:
                                          isCurrent && resolvedCaptionStyle.animation === 'pop'
                                            ? 'scale(1.06)'
                                            : 'scale(1)',
                                        opacity:
                                          resolvedCaptionStyle.animation === 'fade' && !isCurrent
                                            ? 0.78
                                            : 1,
                                      }}
                                      className="inline-block transition-transform duration-150"
                                    >
                                      {word}
                                    </span>
                                  );
                                })}
                              </div>
                            ));
                          })()}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Multi-Track Timeline (Trim Handles + Waveform + Silence Cuts + Captions + Crop Curve) */}
            <div className="mt-5 space-y-4">
              <MultiTrackTimeline
                videoDurationSec={project.video.durationSec || activeClip.endSec}
                startSec={activeClip.startSec}
                endSec={activeClip.endSec}
                playheadOffsetSec={playheadOffsetSec}
                isPlaying={isPlaying}
                waveformBars={waveformBars}
                captionCues={captionTrackCues}
                skippedRanges={effectiveTimeline.skippedRanges}
                savedSec={effectiveTimeline.savedSec}
                effectiveDurationSec={effectiveTimeline.effectiveDurationSec}
                cropKeyframes={effectiveCropKeyframes}
                autoSpeakerTracking={activeClip.autoSpeakerTracking}
                onTogglePlay={handleTogglePlay}
                onSeekOffset={handleSeekOffset}
                onCommitTrim={(nextS, nextE) => commitTrimBounds(String(nextS), String(nextE))}
                onAddCropKeyframe={handleAddCropKeyframe}
              />

              {/* Duration Presets & Trim Inputs */}
              <div className="border-t border-white/10 pt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-slate-400 mr-1">Target length:</span>
                  {CLIP_DURATION_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => {
                        const range = applyDurationPreset(
                          activeClip.startSec,
                          preset,
                          Math.max(5, project.video.durationSec || 60)
                        );
                        applyPatchWithHistory(range);
                      }}
                      className="rounded-md border border-white/10 bg-[#0B0D11] px-2.5 py-1 font-mono text-xs text-slate-300 hover:border-amber-500/60 hover:text-white tabular-nums"
                    >
                      {preset}s
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-3 text-xs tabular-nums">
                  <label className="text-slate-400">
                    Start
                    <input
                      type="number"
                      step={0.5}
                      value={startDraft}
                      onChange={(e) => setStartDraft(e.target.value)}
                      onBlur={() => commitTrimBounds(startDraft, endDraft)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitTrimBounds(startDraft, endDraft);
                      }}
                      className="ml-1.5 w-20 rounded border border-white/15 bg-[#0B0D11] px-2 py-1 font-mono text-white"
                    />
                  </label>
                  <label className="text-slate-400">
                    End
                    <input
                      type="number"
                      step={0.5}
                      value={endDraft}
                      onChange={(e) => setEndDraft(e.target.value)}
                      onBlur={() => commitTrimBounds(startDraft, endDraft)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitTrimBounds(startDraft, endDraft);
                      }}
                      className="ml-1.5 w-20 rounded border border-white/15 bg-[#0B0D11] px-2 py-1 font-mono text-white"
                    />
                  </label>
                </div>
              </div>
              <p className="text-[11px] text-slate-500 font-mono">
                Shortcuts: Space play/pause · J/L ±1s · [ / ] set In/Out · Cmd/Ctrl+Z undo
              </p>
            </div>
          </div>
        </div>

        {/* Right: Inspector Tabs */}
        <div className="xl:col-span-5 rounded-xl border border-white/10 bg-[#131720] overflow-hidden">
          <div
            role="tablist"
            aria-label="Editor inspector panels"
            className="grid grid-cols-5 border-b border-white/10 bg-[#0E1117] text-xs font-medium"
          >
            {(
              [
                ['score', 'Score'],
                ['transcript', 'Transcript'],
                ['style', 'Captions'],
                ['metadata', 'AI Copy'],
                ['export', 'Export'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={inspectorTab === id}
                onClick={() => setInspectorTab(id)}
                className={`py-3 text-center transition-colors whitespace-nowrap ${
                  inspectorTab === id
                    ? 'border-b-2 border-amber-500 text-white bg-[#131720]'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="p-5 sm:p-6">
            {inspectorTab === 'score' && (
              <div className="space-y-5">
                {/* Live Phase 3 AI Analysis Controls & Stage Status for uploaded masters */}
                {!project.isDemo && (
                  <div className="rounded-lg border border-white/10 bg-[#0B0D11] p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-medium text-amber-400">
                        {project.status === 'processing'
                          ? 'Running 7-Stage AI Pipeline...'
                          : project.status === 'error'
                          ? 'Pipeline Paused on Error'
                          : project.transcript
                          ? 'Phase 3 AI Analysis Complete'
                          : 'Ready for Phase 3 AI Analysis'}
                      </span>

                      <div className="flex items-center gap-2">
                        <label htmlFor="editor-analysis-duration" className="sr-only">
                          Target clip duration
                        </label>
                        <select
                          id="editor-analysis-duration"
                          value={targetAnalysisDuration}
                          disabled={project.status === 'processing'}
                          onChange={(e) =>
                            setTargetAnalysisDuration(
                              Number(e.target.value) as ClipDurationPreset
                            )
                          }
                          className="rounded border border-white/15 bg-[#131720] px-2 py-1 text-xs font-mono text-white"
                        >
                          {CLIP_DURATION_PRESETS.map((p) => (
                            <option key={p} value={p}>
                              {p}s target
                            </option>
                          ))}
                        </select>

                        {project.status === 'error' ? (
                          <button
                            type="button"
                            onClick={() => void handleAnalyzeProject(true)}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 whitespace-nowrap"
                          >
                            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                            Retry Failed Stage
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={project.status === 'processing'}
                            onClick={() => void handleAnalyzeProject(!project.transcript)}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50 whitespace-nowrap"
                          >
                            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                            {project.status === 'processing'
                              ? 'Analyzing...'
                              : project.transcript
                              ? 'Re-run Analysis'
                              : 'Analyze with AI'}
                          </button>
                        )}
                      </div>
                    </div>

                    {project.processingStages.length > 0 && (
                      <div className="space-y-2 border-t border-white/10 pt-3">
                        {project.processingStages.map((stg) => (
                          <div key={stg.id} className="flex items-start gap-2.5 text-xs">
                            {stg.status === 'completed' ? (
                              <CheckCircle2
                                className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5"
                                aria-hidden="true"
                              />
                            ) : stg.status === 'failed' ? (
                              <AlertCircle
                                className="h-3.5 w-3.5 text-red-400 shrink-0 mt-0.5"
                                aria-hidden="true"
                              />
                            ) : (
                              <Clock
                                className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${
                                  stg.status === 'running' ? 'text-amber-400' : 'text-slate-500'
                                }`}
                                aria-hidden="true"
                              />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium text-slate-200 capitalize">
                                  {stg.stage.replace(/_/g, ' ')}
                                </span>
                                <span className="font-mono text-slate-400 tabular-nums">
                                  {stg.progressPct}%
                                </span>
                              </div>
                              <p
                                className={`text-[11px] mt-0.5 ${
                                  stg.status === 'failed' ? 'text-red-300' : 'text-slate-400'
                                }`}
                              >
                                {stg.message}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {analyzeStatusMsg && (
                      <div
                        role="status"
                        className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100"
                      >
                        {analyzeStatusMsg}
                      </div>
                    )}
                  </div>
                )}

                {activeClip.score.criteria.length > 0 ? (
                  <>
                    <div className="flex items-baseline justify-between">
                      <div>
                        <p className="text-xs font-medium text-amber-400">Viral Score Estimate</p>
                        <p className="mt-0.5 text-xs text-slate-400">
                          {activeClip.score.disclaimer}
                        </p>
                      </div>
                      <div className="text-right tabular-nums shrink-0 ml-4">
                        <span className="font-display text-3xl font-semibold text-white">
                          {activeClip.score.overallEstimate}
                        </span>
                        <span className="text-xs text-slate-400"> / 100</span>
                      </div>
                    </div>

                    <p className="text-xs leading-relaxed text-slate-300 border-y border-white/10 py-3">
                      {activeClip.score.summary}
                    </p>

                    <div className="space-y-3.5">
                      {activeClip.score.criteria.map((item) => (
                        <div key={item.key}>
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className="font-medium text-slate-200">
                              {item.label} ({Math.round(item.weight * 100)}%)
                            </span>
                            <span className="font-mono text-amber-400 tabular-nums">
                              {item.score}/100
                            </span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-amber-500"
                              style={{ width: `${item.score}%` }}
                            />
                          </div>
                          <p className="mt-1 text-xs text-slate-400">{item.rationale}</p>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="text-xs leading-relaxed text-slate-400">
                    {activeClip.score.summary}
                  </p>
                )}
              </div>
            )}

            {inspectorTab === 'transcript' && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
                  <div className="text-xs text-slate-400 tabular-nums">
                    {project.transcript ? (
                      <>
                        Language: <span className="text-white">{project.transcript.language}</span>
                        {' · '}
                        {displaySpeakers.length === 1 ? 'Speaker' : 'Speakers'}:{' '}
                        <span data-testid="transcript-speakers-list" className="text-white">
                          {displaySpeakers.join(', ')}
                        </span>
                        {transcriptWords.some((w) => w.kind === 'sound_event') && (
                          <>
                            {' · '}
                            Sound events:{' '}
                            <span className="text-sky-300">
                              {transcriptWords.filter((w) => w.kind === 'sound_event').length}
                            </span>
                          </>
                        )}
                      </>
                    ) : (
                      <span>
                        Speaker:{' '}
                        <span data-testid="transcript-speakers-list" className="text-white">
                          {displaySpeakers[0] ?? activeClip.speaker}
                        </span>{' '}
                        · {transcriptWords.filter((w) => w.kind !== 'sound_event').length} words
                        {transcriptWords.some((w) => w.kind === 'sound_event') && (
                          <>
                            {' · '}
                            <span className="text-sky-300">
                              {transcriptWords.filter((w) => w.kind === 'sound_event').length} sound
                              events
                            </span>
                          </>
                        )}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      data-testid="transcript-detect-voice-btn"
                      disabled={detectingVoice || project.status === 'processing'}
                      onClick={() => void handleDetectClipVoiceEnglish()}
                      className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-200 hover:bg-amber-500/25 disabled:opacity-60 whitespace-nowrap"
                    >
                      {detectingVoice ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" aria-hidden="true" />
                      ) : (
                        <Mic className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
                      )}
                      {detectingVoice ? 'Detecting...' : 'Detect Voice (English)'}
                    </button>

                    {transcriptWords.length > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          void handleCopy(
                            'transcript',
                            transcriptWords.map((w) => w.word).join(' ')
                          )
                        }
                        className="inline-flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 whitespace-nowrap"
                      >
                        {copiedKey === 'transcript' ? (
                          <>
                            <Check className="h-3.5 w-3.5" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" /> Copy text
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>

                {voiceDetectMsg && (
                  <p
                    role="status"
                    data-testid="transcript-voice-detect-feedback"
                    className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
                  >
                    {voiceDetectMsg}
                  </p>
                )}

                {project.sceneCutsSec && project.sceneCutsSec.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-slate-300">
                      Visual Scene Cuts ({project.sceneCutsSec.length})
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {project.sceneCutsSec.map((cut) => (
                        <button
                          key={cut}
                          type="button"
                          onClick={() => handleSeekToAbsoluteTime(cut)}
                          className="rounded border border-white/10 bg-[#0B0D11] px-2 py-1 font-mono text-[11px] text-slate-300 hover:border-amber-500/60 hover:text-white tabular-nums"
                        >
                          {formatTimecode(cut, true)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {transcriptWords.length > 0 ? (
                  <div className="max-h-[380px] overflow-y-auto rounded-lg border border-white/10 bg-[#0B0D11] p-4 leading-relaxed text-sm space-y-2">
                    <p className="text-[11px] text-slate-400 mb-2">
                      Click any spoken word or detected audio sound event to jump the playhead directly to that moment.
                    </p>
                    <div className="flex flex-wrap gap-x-1.5 gap-y-1.5 items-center">
                      {(() => {
                        const activeWordIdx = transcriptWords.findIndex(
                          (w, i) =>
                            playheadAbsSec >= w.startSec - 0.05 &&
                            (playheadAbsSec <= w.endSec + 0.05 || i === transcriptWords.length - 1)
                        );
                        return transcriptWords.map((w, idx) => {
                          const isActiveWord = idx === activeWordIdx;
                          const isSoundEvent = w.kind === 'sound_event';
                          const inClipRange =
                            w.startSec >= activeClip.startSec &&
                            w.endSec <= activeClip.endSec + 0.5;
                          return (
                            <button
                              key={`${w.startSec}-${idx}`}
                              type="button"
                              data-testid={
                                isSoundEvent
                                  ? `sound-event-token-${w.soundCategory ?? 'other'}`
                                  : undefined
                              }
                              onClick={() => handleSeekToAbsoluteTime(w.startSec)}
                              title={`${
                                isSoundEvent ? `Sound Event (${w.soundCategory ?? 'audio'})` : w.speaker
                              } · ${formatTimecode(w.startSec, true)}`}
                              className={`rounded px-1.5 py-0.5 text-left transition-colors ${
                                isSoundEvent
                                  ? isActiveWord
                                    ? 'inline-flex items-center gap-1 bg-sky-400 text-slate-950 font-semibold italic text-xs'
                                    : 'inline-flex items-center gap-1 border border-sky-400/35 bg-sky-500/15 text-sky-200 hover:bg-sky-500/25 italic text-xs font-medium'
                                  : isActiveWord
                                  ? 'bg-amber-500 text-slate-950 font-semibold'
                                  : inClipRange
                                  ? 'text-white hover:bg-white/10'
                                  : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
                              }`}
                            >
                              {isSoundEvent && (
                                <AudioLines className="h-3 w-3 shrink-0" aria-hidden="true" />
                              )}
                              {w.word}
                            </button>
                          );
                        });
                      })()}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-white/10 bg-[#0B0D11] p-4 space-y-3">
                    <p className="text-xs text-slate-300">
                      No audio transcript or sound events have been extracted for this upload yet.
                    </p>
                    {!project.isDemo && (
                      <button
                        type="button"
                        disabled={project.status === 'processing'}
                        onClick={() => {
                          setInspectorTab('score');
                          void handleAnalyzeProject(true);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400"
                      >
                        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                        Run AI Transcription &amp; Diarization
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {inspectorTab === 'style' && (
              <CaptionStylePanel
                clip={activeClip}
                resolvedStyle={resolvedCaptionStyle}
                activeCrop={activeCrop}
                silenceCountInClip={silenceCountInClip}
                savedSec={effectiveTimeline.savedSec}
                onPatchClip={applyPatchWithHistory}
                onTranscriptUpdated={(t) => onUpdateProjectTranscript?.(project.id, t)}
                onAddCropKeyframe={handleAddCropKeyframe}
                onResetCropKeyframes={handleResetCropKeyframes}
              />
            )}

            {inspectorTab === 'metadata' && (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-slate-400">Primary title</p>
                    <button
                      type="button"
                      onClick={() => void handleCopy('primary', activeClip.metadata.primaryTitle)}
                      className="inline-flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300"
                    >
                      {copiedKey === 'primary' ? (
                        <>
                          <Check className="h-3.5 w-3.5" /> Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" /> Copy
                        </>
                      )}
                    </button>
                  </div>
                  <p className="mt-1 text-sm font-medium text-white">
                    {activeClip.metadata.primaryTitle}
                  </p>
                </div>

                <div className="border-t border-white/10 pt-3">
                  <p className="text-xs font-medium text-slate-400 mb-2">Alternative Titles</p>
                  <ul className="space-y-1.5 text-xs text-slate-300">
                    {activeClip.metadata.alternativeTitles.map((title) => (
                      <li
                        key={title}
                        className="rounded bg-[#0B0D11] px-3 py-2 border border-white/5"
                      >
                        {title}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="border-t border-white/10 pt-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium text-slate-400">Platform copy</p>
                    <div className="inline-flex rounded-md border border-white/10 bg-[#0B0D11] p-0.5 text-[11px]">
                      {(['tiktok', 'reels', 'shorts', 'linkedin'] as const).map((plat) => (
                        <button
                          key={plat}
                          type="button"
                          onClick={() => setPlatformTab(plat)}
                          className={`rounded px-2 py-1 capitalize ${
                            platformTab === plat ? 'bg-[#1F2634] text-white' : 'text-slate-400'
                          }`}
                        >
                          {plat}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-[#0B0D11] p-3 text-xs text-slate-200 leading-relaxed">
                    {activeClip.metadata.platformCaptions[platformTab]}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs text-amber-400">
                    {activeClip.metadata.hashtags.map((tag, i) => (
                      <span key={`${tag}-${i}`}>{tag}</span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {inspectorTab === 'export' && (
              <ExportStudioPanel
                project={project}
                activeClip={activeClip}
                brandKit={brandKit}
                onPatchClip={applyPatchWithHistory}
                onDownloadSrt={handleDownloadSrt}
                onDownloadVtt={handleDownloadVtt}
                onExportCompleted={onExportCompleted}
                onPreviewRenderedVideo={(url, label) => {
                  setRenderedExportPreview({ url, label });
                  setPlayheadOffsetSec(0);
                  setIsPlaying(true);
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
