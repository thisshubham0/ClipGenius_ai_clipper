import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCaptionTrackCues,
  buildSpeakerCropKeyframes,
  computeEffectiveTimeline,
  evaluateCropAtTime,
  filterWordsForCaptions,
  findNextPlayableTime,
  generateSrtFromTranslatedCues,
  generateVttFromTranslatedCues,
  resolveActiveCaptionCueAtTime,
  smoothCropKeyframes,
} from './editorEngine';
import type { TranscriptWord } from '../types/clipgenius';

const SAMPLE_WORDS: TranscriptWord[] = [
  { word: 'Um,', startSec: 10.0, endSec: 10.35, speaker: 'Speaker 1', confidence: 0.9 },
  { word: 'founders', startSec: 10.4, endSec: 11.0, speaker: 'Speaker 1', confidence: 0.99 },
  { word: 'ship', startSec: 11.0, endSec: 11.4, speaker: 'Speaker 1', confidence: 0.98 },
  { word: 'too', startSec: 11.4, endSec: 11.7, speaker: 'Speaker 1', confidence: 0.99 },
  { word: 'fast.', startSec: 11.7, endSec: 12.2, speaker: 'Speaker 1', confidence: 0.99 },
  { word: 'Uh,', startSec: 15.0, endSec: 15.4, speaker: 'Speaker 2', confidence: 0.91 },
  { word: 'how', startSec: 15.5, endSec: 15.9, speaker: 'Speaker 2', confidence: 0.99 },
  { word: 'did', startSec: 15.9, endSec: 16.2, speaker: 'Speaker 2', confidence: 0.99 },
  { word: 'you', startSec: 16.2, endSec: 16.5, speaker: 'Speaker 2', confidence: 0.99 },
  { word: 'fix', startSec: 16.5, endSec: 17.0, speaker: 'Speaker 2', confidence: 0.98 },
  { word: 'it?', startSec: 17.0, endSec: 17.5, speaker: 'Speaker 2', confidence: 0.98 },
];

test('filterWordsForCaptions removes filler tokens when enabled', () => {
  const kept = filterWordsForCaptions(SAMPLE_WORDS, true);
  assert.equal(kept.some((w) => w.word.toLowerCase().startsWith('um')), false);
  assert.equal(kept.some((w) => w.word.toLowerCase().startsWith('uh')), false);
  assert.equal(kept.length, SAMPLE_WORDS.length - 2);
});

test('computeEffectiveTimeline merges silence gaps and filler words and skips playhead cleanly', () => {
  const result = computeEffectiveTimeline({
    startSec: 10,
    endSec: 20,
    silences: [{ startSec: 12.2, endSec: 14.8, durationSec: 2.6 }],
    removeSilences: true,
    words: SAMPLE_WORDS,
    removeFillers: true,
  });

  assert.equal(result.skippedRanges.length, 3);
  assert.ok(result.savedSec > 2.5);
  assert.ok(result.effectiveDurationSec < 7.5);

  const jumpTarget = findNextPlayableTime(13.0, result.skippedRanges);
  assert.ok(jumpTarget !== null && jumpTarget >= 14.7);
  assert.equal(findNextPlayableTime(16.0, result.skippedRanges), null);
});

test('smoothCropKeyframes dampens sudden horizontal spikes without jitter', () => {
  const jagged = [
    { timeSec: 0, xPct: 25, zoom: 1.0 },
    { timeSec: 2, xPct: 85, zoom: 1.15 },
    { timeSec: 4, xPct: 25, zoom: 1.0 },
    { timeSec: 6, xPct: 25, zoom: 1.0 },
  ];
  const smoothed = smoothCropKeyframes(jagged, 0.4);
  assert.equal(smoothed.length, 4);
  // Peak spike at index 1 must be softened strictly below 85
  assert.ok(smoothed[1].xPct < 75);
  assert.ok(smoothed[1].xPct > 30);
});

test('buildSpeakerCropKeyframes and evaluateCropAtTime pan smoothly across speaker turns', () => {
  const keyframes = buildSpeakerCropKeyframes({
    words: SAMPLE_WORDS,
    startSec: 10,
    endSec: 20,
    baseOffsetX: 50,
    autoZoom: true,
  });

  assert.ok(keyframes.length >= 3);
  const early = evaluateCropAtTime({ keyframes, timeSec: 10.5, fallbackX: 50, autoZoom: true });
  const late = evaluateCropAtTime({ keyframes, timeSec: 17.0, fallbackX: 50, autoZoom: true });

  assert.ok(early.xPct < late.xPct, 'Crop X should shift toward Speaker 2 later in clip');
  assert.ok(early.zoom >= 1 && late.zoom >= 1);
});

test('buildCaptionTrackCues computes normalized percentage tracks and translated exports', () => {
  const cues = buildCaptionTrackCues({
    words: SAMPLE_WORDS,
    startSec: 10,
    endSec: 20,
    wordsPerCue: 5,
  });
  assert.equal(cues.length, 3);
  assert.ok(cues[0].leftPct >= 0 && cues[0].leftPct <= 100);
  assert.ok(cues[0].widthPct > 0);

  const translated = [
    { startSec: 10.4, endSec: 12.2, text: 'Los fundadores lanzan muy rapido.' },
    { startSec: 15.5, endSec: 17.5, text: 'Como lo resolviste?' },
  ];
  const srt = generateSrtFromTranslatedCues(translated, 10);
  const vtt = generateVttFromTranslatedCues(translated, 10);

  assert.ok(srt.includes('00:00:00,400 --> 00:00:02,200'));
  assert.ok(srt.includes('Los fundadores lanzan muy rapido.'));
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.ok(vtt.includes('00:00:05.500 --> 00:00:07.500'));
});

test('layoutCaptionTrackBlocks maps cues across full 104s segment with zero overlap and clean narrow-block labels', async () => {
  const { layoutCaptionTrackBlocks } = await import('./editorEngine');
  const startSec = 51.5;
  const endSec = 155.5; // 104s segment

  const cues = [
    { id: 'c1', startSec: 52.0, endSec: 53.0, text: 'Welcome everyone to the show', leftPct: 0.48, widthPct: 0.96 },
    { id: 'c2', startSec: 53.1, endSec: 54.0, text: 'My name is Alex Rivera', leftPct: 1.54, widthPct: 0.87 },
    { id: 'c3', startSec: 54.2, endSec: 55.2, text: 'and today we break down', leftPct: 2.6, widthPct: 0.96 },
    { id: 'c4', startSec: 103.5, endSec: 112.5, text: 'the exact mid-clip insight here', leftPct: 50.0, widthPct: 8.65 },
    { id: 'c5', startSec: 145.0, endSec: 154.0, text: 'and the final closing takeaway', leftPct: 89.9, widthPct: 8.65 },
  ];

  const laidOut = layoutCaptionTrackBlocks(cues, startSec, endSec);
  assert.equal(laidOut.length, 5);

  // Strictly non-overlapping and bounded inside [0, 100]
  for (let i = 0; i < laidOut.length; i += 1) {
    assert.ok(laidOut[i].visualLeftPct >= 0);
    assert.ok(laidOut[i].visualWidthPct >= 0.4);
    assert.ok(laidOut[i].visualLeftPct + laidOut[i].visualWidthPct <= 100.05);
    if (i > 0) {
      const prevRight = laidOut[i - 1].visualLeftPct + laidOut[i - 1].visualWidthPct;
      assert.ok(
        laidOut[i].visualLeftPct >= prevRight,
        `Cue ${i} (${laidOut[i].visualLeftPct}%) overlapped previous right (${prevRight}%)`
      );
    }
  }

  // Ultra-narrow cues (<5.5%) suppress garbled single-letter inline text while wider cues show inline text
  assert.equal(laidOut[0].showInlineText, false);
  assert.equal(laidOut[3].showInlineText, true);
  assert.equal(laidOut[4].showInlineText, true);

  // Mid and late cues remain anchored near 50% and ~90% of the 104s timeline
  assert.ok(laidOut[3].visualLeftPct >= 49 && laidOut[3].visualLeftPct <= 51);
  assert.ok(laidOut[4].visualLeftPct >= 89 && laidOut[4].visualLeftPct <= 91);
});

test('consolidateDisplaySpeakers collapses 17 inflated legacy speakers to Speaker 1 while preserving genuine 2-speaker dialogue', async () => {
  const { consolidateDisplaySpeakers } = await import('./editorEngine');

  // 17 inflated speakers, each with one short segment
  const inflatedWords: TranscriptWord[] = Array.from({ length: 17 }, (_, i) => ({
    word: `Segment${i + 1}`,
    startSec: i * 4,
    endSec: i * 4 + 2,
    speaker: `Speaker ${i + 1}`,
    confidence: 0.9,
  }));
  const collapsed = consolidateDisplaySpeakers(
    inflatedWords,
    inflatedWords.map((w) => w.speaker)
  );
  assert.deepEqual(collapsed, ['Speaker 1']);

  // Genuine 2-speaker podcast with recurring turns
  const twoSpeakerWords: TranscriptWord[] = [
    ...Array.from({ length: 6 }, (_, i) => ({ word: `a${i}`, startSec: i, endSec: i + 0.5, speaker: 'Speaker 1', confidence: 0.95 })),
    ...Array.from({ length: 6 }, (_, i) => ({ word: `b${i}`, startSec: 10 + i, endSec: 10.5 + i, speaker: 'Speaker 2', confidence: 0.95 })),
    ...Array.from({ length: 6 }, (_, i) => ({ word: `c${i}`, startSec: 20 + i, endSec: 20.5 + i, speaker: 'Speaker 1', confidence: 0.95 })),
    ...Array.from({ length: 6 }, (_, i) => ({ word: `d${i}`, startSec: 30 + i, endSec: 30.5 + i, speaker: 'Speaker 2', confidence: 0.95 })),
  ];
  assert.deepEqual(consolidateDisplaySpeakers(twoSpeakerWords), ['Speaker 1', 'Speaker 2']);
});

test('buildCaptionTrackCues breaks on silence gaps and sentence punctuation without bridging unrelated lines', () => {
  const gappedWords: TranscriptWord[] = [
    { word: 'Watch', startSec: 10.0, endSec: 10.4, speaker: 'Speaker 1', confidence: 0.99 },
    { word: 'out!', startSec: 10.4, endSec: 10.8, speaker: 'Speaker 1', confidence: 0.99 },
    // 5-second silent gap before next sentence
    { word: 'I', startSec: 15.8, endSec: 16.0, speaker: 'Speaker 1', confidence: 0.99 },
    { word: 'am', startSec: 16.0, endSec: 16.25, speaker: 'Speaker 1', confidence: 0.99 },
    { word: 'just', startSec: 16.25, endSec: 16.6, speaker: 'Speaker 1', confidence: 0.99 },
    { word: 'a', startSec: 16.6, endSec: 16.75, speaker: 'Speaker 1', confidence: 0.99 },
    { word: 'hero.', startSec: 16.75, endSec: 17.3, speaker: 'Speaker 1', confidence: 0.99 },
    { word: 'Next', startSec: 17.4, endSec: 17.8, speaker: 'Speaker 1', confidence: 0.99 },
    { word: 'line', startSec: 17.8, endSec: 18.2, speaker: 'Speaker 1', confidence: 0.99 },
  ];

  const cues = buildCaptionTrackCues({
    words: gappedWords,
    startSec: 10,
    endSec: 20,
    wordsPerCue: 5,
  });

  assert.equal(cues.length, 3);
  assert.equal(cues[0].text, 'Watch out!');
  assert.equal(cues[0].endSec, 10.8);
  assert.equal(cues[1].text, 'I am just a hero.');
  assert.equal(cues[1].startSec, 15.8);
  assert.equal(cues[2].text, 'Next line');
  assert.equal(cues[1].words?.length, 5);
});

test('resolveActiveCaptionCueAtTime highlights exact words without intra-cue flicker and clears during silence', () => {
  const words: TranscriptWord[] = [
    { word: 'Always', startSec: 50.0, endSec: 50.3, speaker: 'Speaker 1', confidence: 0.99 },
    // Brief 0.25s intra-cue breathing pause between word 0 and word 1
    { word: 'stay', startSec: 50.55, endSec: 50.9, speaker: 'Speaker 1', confidence: 0.99 },
    { word: 'ready.', startSec: 50.9, endSec: 51.4, speaker: 'Speaker 1', confidence: 0.99 },
    // 3s silence before next cue
    { word: 'Strike', startSec: 54.4, endSec: 54.9, speaker: 'Speaker 1', confidence: 0.99 },
    { word: 'now.', startSec: 54.9, endSec: 55.4, speaker: 'Speaker 1', confidence: 0.99 },
  ];
  const cues = buildCaptionTrackCues({ words, startSec: 48, endSec: 58, wordsPerCue: 5 });

  // Idle at clip start (48.0s before first cue at 50.0s): shows preview cue only when allowIdlePreviewFallback=true
  const idlePreview = resolveActiveCaptionCueAtTime({
    cues,
    playheadAbsSec: 48.0,
    allowIdlePreviewFallback: true,
  });
  assert.equal(idlePreview?.words.join(' '), 'Always stay ready.');
  assert.equal(idlePreview?.highlightedIdx, 0);

  // During playback before first cue: must be null (no stuck caption)
  assert.equal(
    resolveActiveCaptionCueAtTime({ cues, playheadAbsSec: 48.5, allowIdlePreviewFallback: false }),
    null
  );

  // During brief intra-cue gap at 50.42s: stays visible with word 0 highlighted (zero flicker!)
  const midGap = resolveActiveCaptionCueAtTime({
    cues,
    playheadAbsSec: 50.42,
    allowIdlePreviewFallback: false,
  });
  assert.equal(midGap?.words.join(' '), 'Always stay ready.');
  assert.equal(midGap?.highlightedIdx, 0);

  // On word 2 ('ready.' at 51.05s): highlights exact index 2
  const onWord2 = resolveActiveCaptionCueAtTime({
    cues,
    playheadAbsSec: 51.05,
    allowIdlePreviewFallback: false,
  });
  assert.equal(onWord2?.highlightedIdx, 2);

  // During 3s silence at 52.8s: clears cleanly to null
  assert.equal(
    resolveActiveCaptionCueAtTime({ cues, playheadAbsSec: 52.8, allowIdlePreviewFallback: false }),
    null
  );

  // On second cue ('Strike now.' at 55.0s): highlights 'now.' (index 1)
  const secondCue = resolveActiveCaptionCueAtTime({
    cues,
    playheadAbsSec: 55.0,
    allowIdlePreviewFallback: false,
  });
  assert.equal(secondCue?.words.join(' '), 'Strike now.');
  assert.equal(secondCue?.highlightedIdx, 1);
});


