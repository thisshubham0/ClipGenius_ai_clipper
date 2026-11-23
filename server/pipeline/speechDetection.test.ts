import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildClipTranscriptionWindows,
  buildProjectTranscriptionWindows,
  buildVoiceClarityAudioFilter,
  detectAndRepairMmssSegments,
  extractConsolidatedSpeakers,
  isPlaceholderNonSpeechText,
  mergeSpeechAndSoundSegments,
  normalizeAndConsolidateSpeakers,
  parseTimestampToSeconds,
  sanitizeSegmentTimings,
  splitTranscriptIntoTimedSegments,
} from './speechDetection';

test('buildVoiceClarityAudioFilter includes speech band-pass, dynaudnorm, and optional silencedetect', () => {
  const withSilence = buildVoiceClarityAudioFilter(true);
  assert.match(withSilence, /highpass=f=80/);
  assert.match(withSilence, /lowpass=f=7800/);
  assert.match(withSilence, /dynaudnorm=/);
  assert.match(withSilence, /silencedetect=/);

  const withoutSilence = buildVoiceClarityAudioFilter(false);
  assert.match(withoutSilence, /dynaudnorm=/);
  assert.doesNotMatch(withoutSilence, /silencedetect=/);
});

test('isPlaceholderNonSpeechText distinguishes real English speech from non-speech sentinels', () => {
  assert.equal(isPlaceholderNonSpeechText(''), true);
  assert.equal(isPlaceholderNonSpeechText('[NON_SPEECH_AUDIO]'), true);
  assert.equal(isPlaceholderNonSpeechText('[Ambient audio]'), true);
  assert.equal(isPlaceholderNonSpeechText('[Music playing]'), true);
  assert.equal(isPlaceholderNonSpeechText('Welcome back to the channel everyone!'), false);
  assert.equal(isPlaceholderNonSpeechText('[Laughing] Wait, did that really happen?'), false);
});

test('splitTranscriptIntoTimedSegments distributes English sentences across non-silent gaps cleanly', () => {
  const text =
    'Welcome back to the podcast. Today we are fixing voice detection so every single English subtitle shows up cleanly.';
  const silences = [{ startSec: 4, endSec: 6, durationSec: 2 }];
  const segs = splitTranscriptIntoTimedSegments(text, 12, silences, 0);

  assert.ok(segs.length >= 2);
  assert.ok(segs[0].startSec >= 0 && segs[0].startSec < 1);
  assert.ok(segs[segs.length - 1].endSec <= 12);
  for (const s of segs) {
    assert.equal(s.kind, 'speech');
    assert.ok(s.endSec > s.startSec);
  }
});

test('mergeSpeechAndSoundSegments recovers English speech from verbatim transcript when diarization only emitted sound events', () => {
  const merged = mergeSpeechAndSoundSegments({
    diarizedSegments: [
      {
        startSec: 0,
        endSec: 15,
        speaker: 'Audio Event',
        text: '[Ambient audio]',
        kind: 'sound_event',
        soundCategory: 'ambient',
      },
      {
        startSec: 8,
        endSec: 9.5,
        speaker: 'Audio Event',
        text: '[Laughing]',
        kind: 'sound_event',
        soundCategory: 'laughing',
      },
    ],
    verbatimTranscript:
      'Hello everyone, welcome to this quick tutorial. In this clip I will show you how to build faster.',
    durationSec: 15,
    silences: [],
    offsetSec: 0,
  });

  const speechSegs = merged.filter((s) => s.kind === 'speech');
  const laughSegs = merged.filter((s) => s.text === '[Laughing]');
  const ambientSegs = merged.filter((s) => s.text === '[Ambient audio]');

  assert.ok(speechSegs.length >= 2, 'Expected recovered English speech segments');
  assert.equal(laughSegs.length, 1, 'Expected genuine [Laughing] sound event to be preserved');
  assert.equal(ambientSegs.length, 0, 'Expected generic [Ambient audio] placeholder to be dropped');
});

test('sanitizeSegmentTimings repairs millisecond timestamps and does NOT falsely subtract offsetSec on late relative speech', () => {
  const msRepaired = sanitizeSegmentTimings(
    [
      { startSec: 1000, endSec: 4500, speaker: 'Speaker 1', text: 'First sentence', kind: 'speech' },
      { startSec: 4600, endSec: 9200, speaker: 'Speaker 1', text: 'Second sentence', kind: 'speech' },
    ],
    10,
    0
  );
  assert.equal(msRepaired[0].startSec, 1);
  assert.equal(msRepaired[0].endSec, 4.5);
  assert.equal(msRepaired[1].startSec, 4.6);
  assert.equal(msRepaired[1].endSec, 9.2);

  // Regression test for 104s clip starting at In=51.50 where relative speech starts at 52.0s:
  // Previously `minScaledStart >= offsetSec - 1.5` wrongly subtracted 51.5s and bunched cues at 0.5s!
  const lateSpeechInLongClip = sanitizeSegmentTimings(
    [
      { startSec: 52.0, endSec: 60.0, speaker: 'Speaker 1', text: 'Middle of clip speech', kind: 'speech' },
      { startSec: 85.0, endSec: 98.0, speaker: 'Speaker 1', text: 'End of clip speech', kind: 'speech' },
    ],
    104,
    51.5,
    true
  );
  assert.equal(lateSpeechInLongClip[0].startSec, 103.5);
  assert.equal(lateSpeechInLongClip[0].endSec, 111.5);
  assert.equal(lateSpeechInLongClip[1].startSec, 136.5);
  assert.equal(lateSpeechInLongClip[1].endSec, 149.5);
});

test('splitTranscriptIntoTimedSegments applies clip offsetSec accurately', () => {
  const segs = splitTranscriptIntoTimedSegments(
    'This is the exact moment where everything changes for creators.',
    10,
    [],
    42.5
  );
  assert.ok(segs.length >= 1);
  assert.ok(segs[0].startSec >= 42.5);
  assert.ok(segs[segs.length - 1].endSec <= 52.5);
});

test('normalizeAndConsolidateSpeakers collapses 17+ inflated speakers into a single speaker while preserving genuine multi-speaker dialogue', () => {
  // Broken diarization: 17 different speakers, one per segment
  const inflated = Array.from({ length: 17 }, (_, i) => ({
    startSec: i * 5,
    endSec: i * 5 + 4,
    speaker: `Speaker ${i + 1}`,
    text: `Segment number ${i + 1} spoken here.`,
    kind: 'speech' as const,
  }));
  const consolidated = normalizeAndConsolidateSpeakers(inflated, 4);
  const speakers = extractConsolidatedSpeakers(consolidated);
  assert.deepEqual(speakers, ['Speaker 1']);

  // Genuine 2-speaker podcast back-and-forth
  const podcast = [
    { startSec: 0, endSec: 4, speaker: 'Speaker 1', text: 'Welcome to the show.', kind: 'speech' as const },
    { startSec: 4.5, endSec: 9, speaker: 'Speaker 2', text: 'Thanks for having me.', kind: 'speech' as const },
    { startSec: 9.5, endSec: 14, speaker: 'Speaker 1', text: 'Tell us how you built it.', kind: 'speech' as const },
    { startSec: 14.5, endSec: 20, speaker: 'Speaker 2', text: 'We started small and iterated fast.', kind: 'speech' as const },
  ];
  const podcastClean = normalizeAndConsolidateSpeakers(podcast, 4);
  assert.deepEqual(extractConsolidatedSpeakers(podcastClean), ['Speaker 1', 'Speaker 2']);
});

test('buildClipTranscriptionWindows chunks 104s clips into contiguous ~35s windows covering full duration', () => {
  const shortWin = buildClipTranscriptionWindows(25, 35);
  assert.equal(shortWin.length, 1);
  assert.equal(shortWin[0].relStartSec, 0);
  assert.equal(shortWin[0].durationSec, 25);

  const longWins = buildClipTranscriptionWindows(104, 35);
  assert.equal(longWins.length, 3);
  assert.equal(longWins[0].relStartSec, 0);
  const last = longWins[longWins.length - 1];
  assert.ok(Math.abs(last.relStartSec + last.durationSec - 104) < 0.05);
});

test('parseTimestampToSeconds parses HH:MM:SS.cc, MM:SS.cc, seconds strings, and finite numbers', () => {
  assert.equal(parseTimestampToSeconds('08:41.52'), 521.52);
  assert.equal(parseTimestampToSeconds('00:14:28.53'), 868.53);
  assert.equal(parseTimestampToSeconds('01:02:03.5'), 3723.5);
  assert.equal(parseTimestampToSeconds('12.75s'), 12.75);
  assert.equal(parseTimestampToSeconds(42.5), 42.5);
  assert.equal(parseTimestampToSeconds('not-a-time'), null);
});

test('detectAndRepairMmssSegments repairs MMSS-as-number corruption without altering real seconds', () => {
  // Real MMSS corruption observed on 24-min video: 02:24 -> 224.63, 05:20 -> 520.16, 08:41 -> 841.52, 14:28 -> 1428.53
  const mmssCorrupted = [
    { startSec: 105.0, endSec: 112.5, speaker: 'Speaker 1', text: 'Line 1', kind: 'speech' as const },
    { startSec: 224.63, endSec: 230.12, speaker: 'Speaker 1', text: 'Line 2', kind: 'speech' as const },
    { startSec: 345.1, endSec: 355.4, speaker: 'Speaker 1', text: 'Line 3', kind: 'speech' as const },
    { startSec: 520.16, endSec: 530.4, speaker: 'Speaker 1', text: 'Line 4', kind: 'speech' as const },
    { startSec: 841.52, endSec: 848.1, speaker: 'Speaker 1', text: 'You know what?', kind: 'speech' as const },
    { startSec: 1428.53, endSec: 1435.2, speaker: 'Speaker 1', text: 'Having overwhelming strength', kind: 'speech' as const },
    { startSec: 1505.0, endSec: 1518.5, speaker: 'Speaker 1', text: 'After 15 minutes', kind: 'speech' as const },
  ];

  const repaired = detectAndRepairMmssSegments(mmssCorrupted, 1460.16);
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.segments[1].startSec, 144.63);
  assert.equal(repaired.segments[3].startSec, 320.16);
  assert.equal(repaired.segments[4].startSec, 521.52);
  assert.equal(repaired.segments[5].startSec, 868.53);
  assert.equal(repaired.segments[6].startSec, 905);

  // Genuine seconds spanning 0..1400 with plenty of values where (v % 100) >= 60 must remain untouched
  const normalSeconds = Array.from({ length: 20 }, (_, i) => ({
    startSec: 160 + i * 37,
    endSec: 165 + i * 37,
    speaker: 'Speaker 1',
    text: `Normal line ${i}`,
    kind: 'speech' as const,
  }));
  const untouched = detectAndRepairMmssSegments(normalSeconds, 1460.16);
  assert.equal(untouched.repaired, false);
  assert.deepEqual(
    untouched.segments.map((s) => s.startSec),
    normalSeconds.map((s) => s.startSec)
  );
});

test('buildProjectTranscriptionWindows partitions long videos into bounded contiguous windows', () => {
  const shortWins = buildProjectTranscriptionWindows(42);
  assert.equal(shortWins.length, 1);
  assert.equal(shortWins[0].durationSec, 42);

  const epWins = buildProjectTranscriptionWindows(1460.16);
  assert.ok(epWins.length >= 16 && epWins.length <= 20);
  assert.equal(epWins[0].startSec, 0);
  for (let i = 0; i < epWins.length; i += 1) {
    assert.ok(epWins[i].durationSec <= 86, `Window ${i} exceeded max safe duration`);
    if (i > 0) {
      const prevEnd = epWins[i - 1].startSec + epWins[i - 1].durationSec;
      assert.ok(Math.abs(epWins[i].startSec - prevEnd) < 0.05);
    }
  }
  const last = epWins[epWins.length - 1];
  assert.ok(Math.abs(last.startSec + last.durationSec - 1460.16) < 0.05);
});

