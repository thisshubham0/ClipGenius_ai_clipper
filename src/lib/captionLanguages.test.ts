import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCaptionTranslationPrompt,
  buildDiarizationLanguageInstruction,
  CAPTION_LANGUAGES,
  FEATURED_CAPTION_LANGUAGES,
  getCaptionLanguageLabel,
  isSoundEventCaptionText,
  mergeTranslatedCuesWithTimings,
  normalizeCaptionLanguageCode,
} from './captionLanguages';

test('CAPTION_LANGUAGES includes Original, English, and Hinglish as featured options', () => {
  const featuredCodes = FEATURED_CAPTION_LANGUAGES.map((l) => l.code);
  assert.deepEqual(featuredCodes, ['original', 'en', 'hinglish']);
  assert.ok(CAPTION_LANGUAGES.some((l) => l.code === 'hi'));
  assert.equal(getCaptionLanguageLabel('en'), 'English');
  assert.equal(getCaptionLanguageLabel('hinglish'), 'Hinglish');
});

test('normalizeCaptionLanguageCode normalizes aliases for English and Hinglish', () => {
  assert.equal(normalizeCaptionLanguageCode('English'), 'en');
  assert.equal(normalizeCaptionLanguageCode('en-US'), 'en');
  assert.equal(normalizeCaptionLanguageCode('Hinglish'), 'hinglish');
  assert.equal(normalizeCaptionLanguageCode('hi-Latn'), 'hinglish');
  assert.equal(normalizeCaptionLanguageCode('roman-hindi'), 'hinglish');
  assert.equal(normalizeCaptionLanguageCode('auto'), 'original');
  assert.equal(normalizeCaptionLanguageCode(undefined), 'original');
});

test('buildCaptionTranslationPrompt generates Roman-script Hinglish and idiomatic English prompts', () => {
  const sampleCues = [
    { startSec: 10, endSec: 13, text: 'Stop asking new users for ten preferences.' },
    { startSec: 13, endSec: 14.5, text: '[Laughing]' },
  ];

  const hinglish = buildCaptionTranslationPrompt({
    langCode: 'hinglish',
    cues: sampleCues,
  });
  assert.ok(hinglish.systemInstruction.includes('Roman/Latin'));
  assert.ok(hinglish.userPrompt.includes('NO Devanagari'));
  assert.ok(hinglish.userPrompt.includes('[Laughing]'));

  const english = buildCaptionTranslationPrompt({
    langCode: 'en',
    cues: sampleCues,
  });
  assert.ok(english.systemInstruction.includes('English'));
  assert.ok(english.userPrompt.includes('Hindi, Hinglish'));
  assert.ok(english.userPrompt.includes('[Laughing]'));
});

test('buildDiarizationLanguageInstruction produces targeted instructions for English and Hinglish only', () => {
  assert.equal(buildDiarizationLanguageInstruction('original'), '');
  assert.ok(buildDiarizationLanguageInstruction('hinglish').includes('HINGLISH'));
  assert.ok(buildDiarizationLanguageInstruction('hinglish').includes('NEVER Devanagari'));
  assert.ok(buildDiarizationLanguageInstruction('en').includes('ENGLISH'));
});

test('mergeTranslatedCuesWithTimings preserves exact timings and keeps sound-event tags verbatim', () => {
  const base = [
    { startSec: 10, endSec: 13.5, text: 'Stop asking new users for preferences.' },
    { startSec: 13.5, endSec: 15, text: '[Laughing]' },
    { startSec: 15, endSec: 18, text: 'Show them one real result first.' },
  ];
  const modelOutput = [
    { startSec: 0, endSec: 1, text: 'Naye users se preferences poochna band karo.' },
    { startSec: 1, endSec: 2, text: '[Haste hue]' },
    { startSec: 2, endSec: 3, text: 'Pehle unhe ek real result dikhao.' },
  ];

  const merged = mergeTranslatedCuesWithTimings(base, modelOutput);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged[0], {
    startSec: 10,
    endSec: 13.5,
    text: 'Naye users se preferences poochna band karo.',
  });
  // Sound-event tag must stay verbatim even if model attempted to translate it
  assert.deepEqual(merged[1], {
    startSec: 13.5,
    endSec: 15,
    text: '[Laughing]',
  });
  assert.deepEqual(merged[2], {
    startSec: 15,
    endSec: 18,
    text: 'Pehle unhe ek real result dikhao.',
  });
});

test('isSoundEventCaptionText accurately identifies bracketed audio events', () => {
  assert.equal(isSoundEventCaptionText('[Laughing]'), true);
  assert.equal(isSoundEventCaptionText(' [Singing] '), true);
  assert.equal(isSoundEventCaptionText('[Music playing]'), true);
  assert.equal(isSoundEventCaptionText('Hello world'), false);
  assert.equal(isSoundEventCaptionText('[a]'), false);
});
