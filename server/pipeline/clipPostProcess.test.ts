import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignSegmentWords,
  buildRankedClipsFromCandidates,
  parseSceneDetectLog,
  parseSilenceDetectLog,
  snapBoundsToWords,
} from './clipPostProcess';

test('parseSilenceDetectLog extracts start, end, and duration intervals', () => {
  const stderr = `
[silencedetect @ 0x55] silence_start: 12.40
[silencedetect @ 0x55] silence_end: 13.85 | silence_duration: 1.45
[silencedetect @ 0x55] silence_start: 40.10
[silencedetect @ 0x55] silence_end: 41.00 | silence_duration: 0.90
  `;
  const parsed = parseSilenceDetectLog(stderr);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { startSec: 12.4, endSec: 13.85, durationSec: 1.45 });
  assert.deepEqual(parsed[1], { startSec: 40.1, endSec: 41, durationSec: 0.9 });
});

test('parseSceneDetectLog extracts deduplicated scene-cut pts_time values', () => {
  const stderr = `
[Parsed_showinfo_1 @ 0x1] n:   0 pts:  12000 pts_time:4.250
[Parsed_showinfo_1 @ 0x1] n:   1 pts:  12100 pts_time:4.350
[Parsed_showinfo_1 @ 0x1] n:   2 pts:  45000 pts_time:18.750
  `;
  const cuts = parseSceneDetectLog(stderr);
  assert.deepEqual(cuts, [4.25, 18.75]);
});

test('alignSegmentWords and snapBoundsToWords snap to sentence boundaries without cutting mid-word', () => {
  const words = alignSegmentWords([
    {
      startSec: 0,
      endSec: 4,
      speaker: 'Speaker 1',
      text: 'Intro words here. Why onboarding fails fast.',
    },
    {
      startSec: 4,
      endSec: 8,
      speaker: 'Speaker 1',
      text: 'Remove extra screens today. That is all.',
    },
  ]);

  const snapped = snapBoundsToWords(1.5, 6.2, words, 10);
  assert.equal(snapped.clipWords[0]?.word, 'Why');
  assert.equal(snapped.clipWords[snapped.clipWords.length - 1]?.word, 'today.');
});

test('buildRankedClipsFromCandidates sorts clips by weighted Viral Score estimate', () => {
  const words = alignSegmentWords([
    { startSec: 0, endSec: 20, speaker: 'Speaker 1', text: 'First hook sentence. Second deep insight sentence.' },
  ]);

  const clips = buildRankedClipsFromCandidates({
    projectId: 'p1',
    words,
    maxDurationSec: 30,
    thumbnailUrl: '/thumb.jpg',
    width: 1920,
    height: 1080,
    candidates: [
      {
        title: 'Lower Clip',
        startSec: 0,
        endSec: 10,
        speaker: 'Speaker 1',
        summary: 'Ok summary',
        criteria: {
          hookStrength: { score: 60, rationale: 'Mild' },
          emotionalImpact: { score: 60, rationale: 'Mild' },
          informationValue: { score: 60, rationale: 'Mild' },
          audienceInterest: { score: 60, rationale: 'Mild' },
          storyCompleteness: { score: 60, rationale: 'Mild' },
          shareability: { score: 60, rationale: 'Mild' },
        },
        metadata: {
          primaryTitle: 'Lower Clip',
          alternativeTitles: ['Alt 1', 'Alt 2', 'Alt 3'],
          description: 'Desc',
          hooks: ['Hook'],
          hashtags: ['#clip'],
          platformCaptions: { tiktok: 't', reels: 'r', shorts: 's', linkedin: 'l' },
        },
      },
      {
        title: 'Top Clip',
        startSec: 10,
        endSec: 20,
        speaker: 'Speaker 1',
        summary: 'Strong summary',
        criteria: {
          hookStrength: { score: 95, rationale: 'Strong' },
          emotionalImpact: { score: 90, rationale: 'Strong' },
          informationValue: { score: 92, rationale: 'Strong' },
          audienceInterest: { score: 88, rationale: 'Strong' },
          storyCompleteness: { score: 90, rationale: 'Strong' },
          shareability: { score: 85, rationale: 'Strong' },
        },
        metadata: {
          primaryTitle: 'Top Clip',
          alternativeTitles: ['Alt A', 'Alt B', 'Alt C'],
          description: 'Desc',
          hooks: ['Hook'],
          hashtags: ['#clip'],
          platformCaptions: { tiktok: 't', reels: 'r', shorts: 's', linkedin: 'l' },
        },
      },
    ],
  });

  assert.equal(clips[0].title, 'Top Clip');
  assert.equal(clips[0].score.overallEstimate > clips[1].score.overallEstimate, true);
  assert.match(clips[0].score.disclaimer, /not a performance guarantee/);
  assert.equal(clips[0].isAiRecommended, true);
  assert.equal(clips[0].versions?.length, 4);
  assert.equal(clips[0].versions?.[0].label, 'Ver-1');
  assert.equal(clips[0].captionTextEdited, false);
  assert.notEqual(clips[0].captionText, clips[0].title);
});

test('alignSegmentWords emits atomic sound_event tokens for laughing, crying, singing & humming alongside speech', () => {
  const words = alignSegmentWords([
    { startSec: 0, endSec: 2, speaker: 'Speaker 1', text: 'Watch this moment', kind: 'speech' },
    { startSec: 2.1, endSec: 3.4, speaker: 'Sound Event', text: '[Laughing]', kind: 'sound_event', soundCategory: 'laughing' },
    { startSec: 3.6, endSec: 5.0, speaker: 'Sound Event', text: 'softly crying', kind: 'sound_event', soundCategory: 'crying' },
    { startSec: 5.2, endSec: 7.0, speaker: 'Sound Event', text: '[Singing]', kind: 'sound_event', soundCategory: 'singing' },
    { startSec: 7.2, endSec: 8.5, speaker: 'Sound Event', text: '[Humming]', kind: 'sound_event', soundCategory: 'humming' },
  ]);

  const soundEvents = words.filter((w) => w.kind === 'sound_event');
  assert.equal(soundEvents.length, 4);
  assert.deepEqual(
    soundEvents.map((s) => s.soundCategory),
    ['laughing', 'crying', 'singing', 'humming']
  );
  assert.equal(soundEvents[0].word, '[Laughing]');
  assert.equal(soundEvents[1].word, '[Softly crying]');
  assert.equal(soundEvents[2].word, '[Singing]');
  assert.equal(soundEvents[3].word, '[Humming]');
});

test('buildRankedClipsFromCandidates deduplicates overlapping highlight ranges so recommendations stay distinct', () => {
  const words = alignSegmentWords([
    { startSec: 0, endSec: 120, speaker: 'Speaker 1', text: 'One two three four five six seven eight nine ten eleven twelve.' },
  ]);

  const makeCriteria = (s: number) => ({
    hookStrength: { score: s, rationale: 'r' },
    emotionalImpact: { score: s, rationale: 'r' },
    informationValue: { score: s, rationale: 'r' },
    audienceInterest: { score: s, rationale: 'r' },
    storyCompleteness: { score: s, rationale: 'r' },
    shareability: { score: s, rationale: 'r' },
  });

  const makeMeta = (title: string) => ({
    primaryTitle: title,
    alternativeTitles: ['A', 'B', 'C'],
    description: 'D',
    hooks: ['H'],
    hashtags: ['#tag'],
    platformCaptions: { tiktok: 't', reels: 'r', shorts: 's', linkedin: 'l' },
  });

  const clips = buildRankedClipsFromCandidates({
    projectId: 'p2',
    words,
    maxDurationSec: 120,
    thumbnailUrl: '/t.jpg',
    width: 1920,
    height: 1080,
    candidates: [
      {
        title: 'Best Moment',
        startSec: 10,
        endSec: 40,
        speaker: 'Speaker 1',
        summary: 'Best',
        recommendationReason: 'Strong peak',
        criteria: makeCriteria(92),
        metadata: makeMeta('Best Moment'),
      },
      {
        title: 'Duplicate Overlap Moment',
        startSec: 12,
        endSec: 42,
        speaker: 'Speaker 1',
        summary: 'Almost identical window',
        criteria: makeCriteria(85),
        metadata: makeMeta('Duplicate Overlap Moment'),
      },
      {
        title: 'Second Distinct Moment',
        startSec: 75,
        endSec: 105,
        speaker: 'Speaker 1',
        summary: 'Later strong section',
        recommendationReason: 'Emotional payoff',
        criteria: makeCriteria(84),
        metadata: makeMeta('Second Distinct Moment'),
      },
    ],
  });

  assert.equal(clips.length, 2);
  assert.equal(clips[0].title, 'Best Moment');
  assert.equal(clips[1].title, 'Second Distinct Moment');
  assert.equal(clips[0].recommendationReason, 'Strong peak');
});
