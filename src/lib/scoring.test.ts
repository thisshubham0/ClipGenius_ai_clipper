import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDurationPreset,
  clampClipTrimRange,
  computeWeightedViralScore,
  formatTimecode,
  generateSrtFromWords,
  generateVttFromWords,
} from './scoring';
import type { ScoreCriterion, TranscriptWord } from '../types/clipgenius';

test('computeWeightedViralScore calculates weighted average clamped 0-100', () => {
  const criteria: ScoreCriterion[] = [
    { key: 'hookStrength', label: 'Hook', weight: 0.25, score: 92, rationale: 'Strong opener' },
    { key: 'emotionalImpact', label: 'Emotion', weight: 0.15, score: 80, rationale: 'High conviction' },
    { key: 'informationValue', label: 'Info', weight: 0.2, score: 88, rationale: 'Actionable insight' },
    { key: 'audienceInterest', label: 'Audience', weight: 0.15, score: 84, rationale: 'Broad appeal' },
    { key: 'storyCompleteness', label: 'Story', weight: 0.15, score: 90, rationale: 'Clean arc' },
    { key: 'shareability', label: 'Share', weight: 0.1, score: 85, rationale: 'Quotable takeaway' },
  ];

  // 92*0.25 + 80*0.15 + 88*0.2 + 84*0.15 + 90*0.15 + 85*0.1 = 23 + 12 + 17.6 + 12.6 + 13.5 + 8.5 = 87.2 -> 87
  assert.equal(computeWeightedViralScore(criteria), 87);
  assert.equal(computeWeightedViralScore([]), 0);
});

test('formatTimecode formats MM:SS, HH:MM:SS, and optional centiseconds', () => {
  assert.equal(formatTimecode(65), '01:05');
  assert.equal(formatTimecode(3661), '01:01:01');
  assert.equal(formatTimecode(12.5, true), '00:12.50');
});

test('clampClipTrimRange and applyDurationPreset enforce clip bounds', () => {
  assert.deepEqual(clampClipTrimRange(-4, 2, 120, 5), { startSec: 0, endSec: 5 });
  assert.deepEqual(applyDurationPreset(100, 30, 120), { startSec: 90, endSec: 120 });
});

test('generateSrtFromWords builds valid SRT blocks offset to clip start', () => {
  const words: TranscriptWord[] = [
    { word: 'Most', startSec: 10.0, endSec: 10.3, speaker: 'Host', confidence: 0.98 },
    { word: 'founders', startSec: 10.3, endSec: 10.7, speaker: 'Host', confidence: 0.97 },
    { word: 'ship', startSec: 10.7, endSec: 11.0, speaker: 'Host', confidence: 0.99 },
  ];
  const srt = generateSrtFromWords(words, 10.0, 5);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,000\nMost founders ship/m);
});

test('generateVttFromWords builds valid WEBVTT cue blocks offset to clip start', () => {
  const words: TranscriptWord[] = [
    { word: 'Always', startSec: 5.0, endSec: 5.4, speaker: 'Host', confidence: 0.98 },
    { word: 'ship', startSec: 5.4, endSec: 5.8, speaker: 'Host', confidence: 0.97 },
    { word: 'early.', startSec: 5.8, endSec: 6.2, speaker: 'Host', confidence: 0.99 },
  ];
  const vtt = generateVttFromWords(words, 5.0, 5);
  assert.match(vtt, /^WEBVTT\n\n00:00:00\.000 --> 00:00:01\.200\nAlways ship early\./m);
});
