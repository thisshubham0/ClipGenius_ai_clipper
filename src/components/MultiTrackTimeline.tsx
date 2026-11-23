import { useMemo, useRef, useState } from 'react';
import { Pause, Play, Plus } from 'lucide-react';
import {
  layoutCaptionTrackBlocks,
  type CaptionTrackCue,
  type SkippedRange,
} from '../lib/editorEngine';
import { formatTimecode } from '../lib/scoring';
import type { CropKeyframe } from '../types/clipgenius';

interface MultiTrackTimelineProps {
  videoDurationSec: number;
  startSec: number;
  endSec: number;
  playheadOffsetSec: number;
  isPlaying: boolean;
  waveformBars: number[];
  captionCues: CaptionTrackCue[];
  skippedRanges: SkippedRange[];
  savedSec: number;
  effectiveDurationSec: number;
  cropKeyframes: CropKeyframe[];
  autoSpeakerTracking: boolean;
  onTogglePlay: () => void;
  onSeekOffset: (offsetSec: number) => void;
  onCommitTrim: (nextStartSec: number, nextEndSec: number) => void;
  onAddCropKeyframe: () => void;
}

export function MultiTrackTimeline({
  videoDurationSec,
  startSec,
  endSec,
  playheadOffsetSec,
  isPlaying,
  waveformBars,
  captionCues,
  skippedRanges,
  savedSec,
  effectiveDurationSec,
  cropKeyframes,
  autoSpeakerTracking,
  onTogglePlay,
  onSeekOffset,
  onCommitTrim,
  onAddCropKeyframe,
}: MultiTrackTimelineProps) {
  const trimTrackRef = useRef<HTMLDivElement | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<'start' | 'end' | null>(null);
  const [draftTrim, setDraftTrim] = useState<{ startSec: number; endSec: number } | null>(null);
  const [hoveredCueId, setHoveredCueId] = useState<string | null>(null);

  const activeStart = draftTrim?.startSec ?? startSec;
  const activeEnd = draftTrim?.endSec ?? endSec;
  const clipDurationSec = Math.max(3, Number((activeEnd - activeStart).toFixed(2)));
  const maxVideoSec = Math.max(5, videoDurationSec || activeEnd);

  const laidOutCaptionCues = useMemo(
    () => layoutCaptionTrackBlocks(captionCues, activeStart, activeEnd),
    [captionCues, activeStart, activeEnd]
  );
  const hoveredCue = hoveredCueId
    ? laidOutCaptionCues.find((c) => c.id === hoveredCueId) ?? null
    : null;

  // Contextual trim ruler window around clip so handles have comfortable drag precision even on 45-min podcasts
  const padSec = Math.max(10, Math.min(30, clipDurationSec * 0.45));
  const windowStartSec = Math.max(0, Number((startSec - padSec).toFixed(2)));
  const windowEndSec = Math.min(maxVideoSec, Number((endSec + padSec).toFixed(2)));
  const windowSpanSec = Math.max(5, windowEndSec - windowStartSec);

  const startHandlePct = Math.max(
    0,
    Math.min(100, ((activeStart - windowStartSec) / windowSpanSec) * 100)
  );
  const endHandlePct = Math.max(
    0,
    Math.min(100, ((activeEnd - windowStartSec) / windowSpanSec) * 100)
  );
  const progressRatio = clipDurationSec > 0 ? Math.min(1, playheadOffsetSec / clipDurationSec) : 0;

  function clientXToWindowSec(clientX: number): number {
    const rect = trimTrackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return activeStart;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Number((windowStartSec + ratio * windowSpanSec).toFixed(2));
  }

  function handleTrimPointerDown(handle: 'start' | 'end', e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraggingHandle(handle);
    setDraftTrim({ startSec, endSec });
  }

  function handleTrimPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingHandle || !draftTrim) return;
    const pointerSec = clientXToWindowSec(e.clientX);
    if (draggingHandle === 'start') {
      const nextStart = Math.max(0, Math.min(pointerSec, draftTrim.endSec - 3));
      setDraftTrim({ startSec: Number(nextStart.toFixed(2)), endSec: draftTrim.endSec });
    } else {
      const nextEnd = Math.min(maxVideoSec, Math.max(pointerSec, draftTrim.startSec + 3));
      setDraftTrim({ startSec: draftTrim.startSec, endSec: Number(nextEnd.toFixed(2)) });
    }
  }

  function handleTrimPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingHandle || !draftTrim) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    onCommitTrim(draftTrim.startSec, draftTrim.endSec);
    setDraggingHandle(null);
    setDraftTrim(null);
  }

  // Build smoothed crop sparkline points normalized to [0..100] x [0..28]
  const cropPolylinePoints = cropKeyframes
    .filter((k) => k.timeSec >= activeStart - 0.5 && k.timeSec <= activeEnd + 0.5)
    .map((k) => {
      const x = Math.max(0, Math.min(100, ((k.timeSec - activeStart) / clipDurationSec) * 100));
      const y = 26 - (Math.max(0, Math.min(100, k.xPct)) / 100) * 22;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <div className="space-y-3" data-testid="multitrack-timeline">
      {/* Row 1: Play/Pause + Waveform & Silence Cut Track */}
      <div className="flex items-start gap-3">
        <button
          type="button"
          aria-label={isPlaying ? 'Pause clip preview' : 'Play clip preview'}
          onClick={onTogglePlay}
          className="mt-5 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500 text-slate-950 hover:bg-amber-400 transition-colors shrink-0"
        >
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>

        <div className="flex-1 min-w-0 space-y-2.5">
          {/* Interactive Trim Range Bar with Draggable In / Out Handles */}
          <div>
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1 tabular-nums">
              <span>Trim Window ({formatTimecode(windowStartSec)} – {formatTimecode(windowEndSec)})</span>
              <span className="font-mono text-slate-300">
                In {formatTimecode(activeStart, true)} · Out {formatTimecode(activeEnd, true)}
              </span>
            </div>

            <div
              ref={trimTrackRef}
              onPointerMove={handleTrimPointerMove}
              onPointerUp={handleTrimPointerUp}
              className="relative h-6 rounded-md border border-white/10 bg-[#0B0D11] select-none touch-none"
            >
              {/* Active trimmed span fill */}
              <div
                aria-hidden="true"
                className="absolute top-0 bottom-0 bg-amber-500/20 border-y border-amber-500/60"
                style={{
                  left: `${startHandlePct}%`,
                  width: `${Math.max(1, endHandlePct - startHandlePct)}%`,
                }}
              />

              {/* Start Trim Handle */}
              <div
                role="slider"
                tabIndex={0}
                aria-label="Trim clip start"
                aria-valuemin={0}
                aria-valuemax={Math.round(activeEnd - 3)}
                aria-valuenow={Math.round(activeStart)}
                data-testid="trim-handle-start"
                onPointerDown={(e) => handleTrimPointerDown('start', e)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    onCommitTrim(Math.min(activeEnd - 3, activeStart + 1), activeEnd);
                  } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    onCommitTrim(Math.max(0, activeStart - 1), activeEnd);
                  }
                }}
                style={{ left: `${startHandlePct}%` }}
                className="absolute top-0 bottom-0 -ml-2 w-4 flex items-center justify-center cursor-ew-resize group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 rounded"
              >
                <span className="h-4 w-1.5 rounded-sm bg-amber-400 group-hover:bg-amber-300" />
              </div>

              {/* End Trim Handle */}
              <div
                role="slider"
                tabIndex={0}
                aria-label="Trim clip end"
                aria-valuemin={Math.round(activeStart + 3)}
                aria-valuemax={Math.round(maxVideoSec)}
                aria-valuenow={Math.round(activeEnd)}
                data-testid="trim-handle-end"
                onPointerDown={(e) => handleTrimPointerDown('end', e)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    onCommitTrim(activeStart, Math.min(maxVideoSec, activeEnd + 1));
                  } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    onCommitTrim(activeStart, Math.max(activeStart + 3, activeEnd - 1));
                  }
                }}
                style={{ left: `${endHandlePct}%` }}
                className="absolute top-0 bottom-0 -ml-2 w-4 flex items-center justify-center cursor-ew-resize group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 rounded"
              >
                <span className="h-4 w-1.5 rounded-sm bg-amber-400 group-hover:bg-amber-300" />
              </div>
            </div>
          </div>

          {/* Audio Waveform Track + Silence/Filler Skip Overlays */}
          <div
            role="slider"
            tabIndex={0}
            aria-label="Clip waveform timeline"
            aria-valuemin={0}
            aria-valuemax={Math.round(clipDurationSec)}
            aria-valuenow={Math.round(playheadOffsetSec)}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const ratio = Math.max(
                0,
                Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width))
              );
              onSeekOffset(ratio * clipDurationSec);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') onSeekOffset(playheadOffsetSec + 1);
              if (e.key === 'ArrowLeft') onSeekOffset(playheadOffsetSec - 1);
            }}
            className="relative h-12 rounded-lg border border-white/10 bg-[#0B0D11] px-2 flex items-center gap-[3px] cursor-pointer overflow-hidden"
          >
            {waveformBars.map((peak, idx) => {
              const barPos = idx / waveformBars.length;
              const activeBar = barPos <= progressRatio;
              return (
                <span
                  key={idx}
                  className={`flex-1 rounded-sm transition-colors ${
                    activeBar ? 'bg-amber-400' : 'bg-slate-700'
                  }`}
                  style={{ height: `${Math.max(14, peak * 0.72)}%` }}
                />
              );
            })}

            {/* Skipped Silence / Filler Cut Bands */}
            {skippedRanges.map((cut, idx) => {
              const leftPct = Math.max(
                0,
                Math.min(100, ((cut.startSec - activeStart) / clipDurationSec) * 100)
              );
              const widthPct = Math.max(
                0.8,
                Math.min(100 - leftPct, ((cut.endSec - cut.startSec) / clipDurationSec) * 100)
              );
              return (
                <div
                  key={`${cut.startSec}-${idx}`}
                  title={`Auto-skip ${cut.reason}: ${formatTimecode(cut.startSec, true)} – ${formatTimecode(cut.endSec, true)}`}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  className="pointer-events-none absolute top-0 bottom-0 bg-red-500/30 border-x border-red-400/60"
                />
              );
            })}

            {/* Playhead Needle */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-white"
              style={{ left: `${progressRatio * 100}%` }}
            />
          </div>

          {/* Caption Cue Track */}
          <div className="space-y-1 relative">
            <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
              <span>
                Caption Track ({laidOutCaptionCues.length}{' '}
                {laidOutCaptionCues.length === 1 ? 'cue' : 'cues'})
              </span>
              {savedSec > 0 ? (
                <span className="font-mono text-emerald-400 tabular-nums">
                  Skipping {savedSec.toFixed(1)}s · Effective {effectiveDurationSec.toFixed(1)}s
                </span>
              ) : (
                <span className="font-mono text-[10px] text-slate-500 tabular-nums">
                  00:00 – {formatTimecode(clipDurationSec)}
                </span>
              )}
            </div>

            {hoveredCue && (
              <div
                role="tooltip"
                data-testid="caption-cue-tooltip"
                className="pointer-events-none absolute -top-11 left-0 right-0 z-30 flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-[#131720]/95 px-2.5 py-1.5 text-[11px] shadow-xl backdrop-blur-sm"
              >
                <span className="text-white font-medium truncate">{hoveredCue.text}</span>
                <span className="font-mono text-[10px] text-amber-300 shrink-0 tabular-nums">
                  {formatTimecode(hoveredCue.startSec, true)}–{formatTimecode(hoveredCue.endSec, true)}{' '}
                  (+{formatTimecode(hoveredCue.relStartSec, true)})
                </span>
              </div>
            )}

            <div
              data-testid="caption-cue-track"
              className="relative h-8 rounded-md border border-white/10 bg-[#0B0D11] overflow-hidden"
            >
              {/* Subtle quarter-duration reference ticks across the full segment */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 left-1/4 w-px bg-white/[0.04]"
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-white/[0.06]"
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 left-3/4 w-px bg-white/[0.04]"
              />

              {laidOutCaptionCues.length > 0 ? (
                laidOutCaptionCues.map((cue) => {
                  const playheadAbs = activeStart + playheadOffsetSec;
                  const isActiveCue =
                    playheadAbs >= cue.startSec - 0.08 && playheadAbs <= cue.endSec + 0.08;
                  const cueLabel = `${formatTimecode(cue.startSec, true)}–${formatTimecode(
                    cue.endSec,
                    true
                  )}: ${cue.text}`;
                  return (
                    <button
                      key={cue.id}
                      type="button"
                      data-testid="caption-cue-block"
                      data-cue-id={cue.id}
                      aria-label={cueLabel}
                      onMouseEnter={() => setHoveredCueId(cue.id)}
                      onMouseLeave={() =>
                        setHoveredCueId((prev) => (prev === cue.id ? null : prev))
                      }
                      onFocus={() => setHoveredCueId(cue.id)}
                      onBlur={() =>
                        setHoveredCueId((prev) => (prev === cue.id ? null : prev))
                      }
                      onClick={() => onSeekOffset(Math.max(0, cue.startSec - activeStart))}
                      title={cueLabel}
                      style={{
                        left: `${cue.visualLeftPct}%`,
                        width: `${cue.visualWidthPct}%`,
                      }}
                      className={`absolute top-1 bottom-1 min-w-[4px] rounded text-[10px] text-left transition-colors overflow-hidden flex items-center ${
                        cue.showInlineText ? 'px-1.5' : 'px-0.5 justify-center'
                      } ${
                        isActiveCue
                          ? 'bg-amber-500/35 border border-amber-400 text-amber-100 z-10'
                          : cue.isSoundEvent
                            ? 'bg-sky-500/20 border border-sky-400/40 text-sky-200 hover:border-sky-300'
                            : 'bg-[#1A202C] border border-white/15 text-slate-300 hover:border-amber-400/60 hover:text-white'
                      }`}
                    >
                      {cue.showInlineText ? (
                        <span className="block w-full truncate leading-none">{cue.text}</span>
                      ) : (
                        <span
                          aria-hidden="true"
                          className="block h-1.5 w-full rounded-full bg-current opacity-60"
                        />
                      )}
                    </button>
                  );
                })
              ) : (
                <div className="flex h-full items-center px-3 text-[11px] text-slate-500">
                  Run AI analysis or click Detect Voice (English) to populate cue blocks
                </div>
              )}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute top-0 bottom-0 z-20 w-0.5 bg-white/80"
                style={{ left: `${progressRatio * 100}%` }}
              />
            </div>
          </div>

          {/* Smoothed Crop Keyframe Curve Track */}
          {(autoSpeakerTracking || cropKeyframes.length > 0) && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>
                  Reframe Crop Curve ({cropKeyframes.length} smoothed keyframe
                  {cropKeyframes.length === 1 ? '' : 's'})
                </span>
                <button
                  type="button"
                  onClick={onAddCropKeyframe}
                  className="inline-flex items-center gap-1 text-[11px] text-amber-400 hover:text-amber-300 whitespace-nowrap"
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  Add Keyframe
                </button>
              </div>
              <div
                data-testid="crop-curve-track"
                className="relative h-7 rounded-md border border-white/10 bg-[#0B0D11] overflow-hidden"
              >
                <svg
                  viewBox="0 0 100 28"
                  preserveAspectRatio="none"
                  className="h-full w-full"
                  aria-hidden="true"
                >
                  <line
                    x1="0"
                    y1="14"
                    x2="100"
                    y2="14"
                    stroke="rgba(255,255,255,0.08)"
                    strokeDasharray="2 2"
                    strokeWidth="0.5"
                  />
                  {cropPolylinePoints && (
                    <polyline
                      fill="none"
                      stroke="#F59E0B"
                      strokeWidth="1.4"
                      points={cropPolylinePoints}
                    />
                  )}
                </svg>
                {cropKeyframes
                  .filter((k) => k.timeSec >= activeStart - 0.5 && k.timeSec <= activeEnd + 0.5)
                  .map((k, idx) => {
                    const leftPct = Math.max(
                      0,
                      Math.min(100, ((k.timeSec - activeStart) / clipDurationSec) * 100)
                    );
                    const topPct = 92 - Math.max(0, Math.min(100, k.xPct)) * 0.78;
                    return (
                      <button
                        key={`${k.timeSec}-${idx}`}
                        type="button"
                        onClick={() => onSeekOffset(Math.max(0, k.timeSec - activeStart))}
                        title={`Crop X=${k.xPct}% · Zoom ${k.zoom}x @ ${formatTimecode(k.timeSec, true)}`}
                        style={{ left: `${leftPct}%`, top: `${topPct}%` }}
                        className="absolute -ml-1.5 -mt-1.5 h-3 w-3 rounded-full border border-[#0B0D11] bg-amber-400 hover:scale-125 transition-transform"
                      />
                    );
                  })}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-white/80"
                  style={{ left: `${progressRatio * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* Footer Timecode Readout */}
          <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 tabular-nums">
            <span>{formatTimecode(playheadOffsetSec)}</span>
            <span>
              Segment: {clipDurationSec.toFixed(1)}s
              {savedSec > 0 ? ` (${effectiveDurationSec.toFixed(1)}s after cuts)` : ''}
            </span>
            <span>{formatTimecode(clipDurationSec)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
