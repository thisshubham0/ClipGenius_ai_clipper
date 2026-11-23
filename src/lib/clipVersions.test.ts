import assert from 'node:assert/strict';
import test from 'node:test';
import { SAMPLE_DEMO_CLIPS } from '../data/demoProject';
import {
  applyVersionPatchToClip,
  BACKGROUND_STYLE_OPTIONS,
  buildDefaultClipVersions,
  createNextClipVersionPatch,
  ensureClipVersions,
  formatSoundEventLabel,
  normalizeSoundCategory,
  SOUNDTRACK_OPTIONS,
  syncPatchIntoActiveVersion,
} from './clipVersions';

test('buildDefaultClipVersions creates Ver-1..Ver-4 with distinct caption, background & soundtrack setups', () => {
  const versions = buildDefaultClipVersions({ aspectRatio: '9:16', preferFramedBackground: true });
  assert.equal(versions.length, 4);
  assert.deepEqual(
    versions.map((v) => v.label),
    ['Ver-1', 'Ver-2', 'Ver-3', 'Ver-4']
  );

  // Distinct caption styles, backgrounds, and soundtracks across versions
  assert.equal(new Set(versions.map((v) => v.captionStyle)).size, 4);
  assert.equal(new Set(versions.map((v) => v.backgroundStyle)).size, 4);
  assert.equal(new Set(versions.map((v) => v.soundtrackId)).size, 4);
  assert.ok(BACKGROUND_STYLE_OPTIONS.length >= 6);
  assert.ok(SOUNDTRACK_OPTIONS.length >= 6);
});

test('applyVersionPatchToClip switches clip to target version caption, background & soundtrack', () => {
  const clip = SAMPLE_DEMO_CLIPS[0];
  const patch = applyVersionPatchToClip(clip, 'ver_3');
  assert.ok(patch);
  assert.equal(patch.activeVersionId, 'ver_3');
  assert.equal(patch.captionStyle, 'karaoke');
  assert.equal(patch.backgroundStyle, 'midnight_neon');
  assert.equal(patch.soundtrackId, 'energetic_synth');
  assert.equal(patch.backgroundBlurFill, false);
});

test('syncPatchIntoActiveVersion preserves edits on the currently active version without mutating others', () => {
  const clip = SAMPLE_DEMO_CLIPS[0];
  const synced = syncPatchIntoActiveVersion(clip, {
    backgroundStyle: 'warm_studio',
    soundtrackId: 'dramatic_pulse',
    soundtrackVolume: 0.35,
  });

  assert.equal(synced.backgroundStyle, 'warm_studio');
  assert.equal(synced.soundtrackId, 'dramatic_pulse');
  const activeVer = synced.versions?.find((v) => v.id === synced.activeVersionId);
  const otherVer = synced.versions?.find((v) => v.id === 'ver_2');
  assert.equal(activeVer?.backgroundStyle, 'warm_studio');
  assert.equal(activeVer?.soundtrackId, 'dramatic_pulse');
  assert.equal(activeVer?.soundtrackVolume, 0.35);
  assert.equal(otherVer?.backgroundStyle, 'dark_gradient');
});

test('createNextClipVersionPatch appends Ver-5 and activates it', () => {
  const clip = SAMPLE_DEMO_CLIPS[0];
  const { versions: before } = ensureClipVersions(clip);
  const patch = createNextClipVersionPatch(clip);

  assert.equal(patch.versions?.length, before.length + 1);
  const created = patch.versions?.[patch.versions.length - 1];
  assert.equal(created?.label, 'Ver-5');
  assert.equal(patch.activeVersionId, created?.id);
  assert.equal(patch.backgroundStyle, created?.backgroundStyle);
  assert.equal(patch.soundtrackId, created?.soundtrackId);
});

test('normalizeSoundCategory and formatSoundEventLabel classify laughing, crying, singing, humming cleanly', () => {
  assert.equal(normalizeSoundCategory('loud laughter'), 'laughing');
  assert.equal(normalizeSoundCategory('softly crying and sobbing'), 'crying');
  assert.equal(normalizeSoundCategory('melodic singing'), 'singing');
  assert.equal(normalizeSoundCategory('gentle humming'), 'humming');
  assert.equal(normalizeSoundCategory('crowd applause'), 'applause');
  assert.equal(normalizeSoundCategory('background noise'), 'ambient');
  assert.equal(normalizeSoundCategory('unclassified chime'), 'other');

  assert.equal(formatSoundEventLabel('laughing'), '[Laughing]');
  assert.equal(formatSoundEventLabel('crying'), '[Crying]');
  assert.equal(formatSoundEventLabel('singing', '[singing softly]'), '[Singing softly]');
  assert.equal(formatSoundEventLabel('humming'), '[Humming]');
});
