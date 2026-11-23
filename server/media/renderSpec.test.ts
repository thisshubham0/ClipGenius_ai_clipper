import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { SAMPLE_DEMO_PROJECT, CAPTION_STYLES } from '../../src/data/demoProject';
import {
  buildClipRenderFilterGraph,
  buildReframeFilterComplex,
  buildZipArchive,
  computeCrc32,
  computeKeepSegments,
  generateAssSubtitles,
  getTargetDimensions,
  hexToAssColor,
  remapTimeThroughKeepSegments,
} from './renderSpec';
import { isBrowserNativeVideo } from './ffprobe';

test('getTargetDimensions returns even dimensions for all aspect ratios and qualities', () => {
  const ratios = ['9:16', '16:9', '1:1', '4:5'] as const;
  const qualities = ['720p', '1080p'] as const;

  for (const r of ratios) {
    for (const q of qualities) {
      const dims = getTargetDimensions(r, q);
      assert.equal(dims.width % 2, 0);
      assert.equal(dims.height % 2, 0);
      assert.ok(dims.width >= 720 && dims.height >= 720);
    }
  }
  assert.deepEqual(getTargetDimensions('9:16', '1080p'), { width: 1080, height: 1920 });
  assert.deepEqual(getTargetDimensions('16:9', '720p'), { width: 1280, height: 720 });
  assert.deepEqual(getTargetDimensions('4:5', '1080p'), { width: 1080, height: 1350 });
});

test('hexToAssColor converts RGB hex to ASS BGR format safely', () => {
  assert.equal(hexToAssColor('#F59E0B'), '&H000B9EF5');
  assert.equal(hexToAssColor('#ffffff'), '&H00FFFFFF');
  assert.equal(hexToAssColor('invalid'), '&H00FFFFFF');
});

test('generateAssSubtitles builds valid ASS dialogue with karaoke tags, alignment, and watermark', () => {
  const clip = {
    ...SAMPLE_DEMO_PROJECT.clips[0],
    subtitleLanguage: 'es',
    translatedCues: {
      es: [
        { startSec: 412.4, endSec: 415.4, text: 'Deja de pedir diez preferencias' },
        { startSec: 415.4, endSec: 418.4, text: 'antes de mostrar valor real.' },
      ],
    },
  };
  const ass = generateAssSubtitles({
    clip,
    resolvedStyle: {
      ...CAPTION_STYLES[0],
      position: 'top',
      uppercase: true,
      animation: 'karaoke',
    },
    width: 1080,
    height: 1920,
    clipDurationSec: 12,
    brandKit: { watermarkPosition: 'top_right', watermarkText: '@northstarpod' },
  });

  assert.ok(ass.includes('[Script Info]'));
  assert.ok(ass.includes('PlayResX: 1080'));
  assert.ok(ass.includes('PlayResY: 1920'));
  // Top alignment is 8 in ASS
  assert.ok(ass.includes(',8,'));
  assert.ok(ass.includes('@northstarpod'));
  assert.ok(ass.includes('{\\k'));
  assert.ok(ass.includes('DEJA'));
});

test('generateAssSubtitles honors manual captionTextEdited override even when words exist', () => {
  const clip = {
    ...SAMPLE_DEMO_PROJECT.clips[0],
    captionText: 'Custom edited viral hook line right here',
    captionTextEdited: true,
  };
  const ass = generateAssSubtitles({
    clip,
    resolvedStyle: {
      ...CAPTION_STYLES[0],
      uppercase: false,
      animation: 'pop',
    },
    width: 720,
    height: 1280,
    clipDurationSec: 10,
  });

  assert.ok(ass.includes('Custom'));
  assert.ok(ass.includes('edited'));
  assert.ok(!ass.includes('preferences'));
});

test('computeKeepSegments and remapTimeThroughKeepSegments cut silences accurately', () => {
  const segs = computeKeepSegments(10, 22, [
    { startSec: 13, endSec: 15, reason: 'silence' },
    { startSec: 18, endSec: 19.5, reason: 'filler' },
  ]);
  assert.deepEqual(segs, [
    { relStart: 0, relEnd: 3 },
    { relStart: 5, relEnd: 8 },
    { relStart: 9.5, relEnd: 12 },
  ]);
  assert.equal(remapTimeThroughKeepSegments(2, segs), 2);
  assert.equal(remapTimeThroughKeepSegments(6, segs), 4);
  assert.equal(remapTimeThroughKeepSegments(11, segs), 7.5);
});

test('buildClipRenderFilterGraph applies silence cuts concat and autoZoom scaling', () => {
  const keepSegments = [
    { relStart: 0, relEnd: 4 },
    { relStart: 6, relEnd: 10 },
  ];
  const graph = buildClipRenderFilterGraph({
    width: 720,
    height: 1280,
    cropOffsetX: 35,
    backgroundBlurFill: false,
    autoZoom: true,
    keepSegments,
    clipDurationSec: 10,
    hasAudio: true,
  });

  assert.equal(graph.videoMap, '[vout]');
  assert.equal(graph.audioMap, '[aout]');
  assert.ok(graph.filterComplex.includes('trim=start=0.000:end=4.000'));
  assert.ok(graph.filterComplex.includes('atrim=start=6.000:end=10.000'));
  assert.ok(graph.filterComplex.includes('concat=n=2:v=1:a=1[vcut][aout]'));
  // autoZoom scales above 720x1280 before cropping back to 720x1280
  assert.ok(graph.filterComplex.includes('scale=778:1382'));
  assert.ok(graph.filterComplex.includes('crop=720:1280'));
});

test('isBrowserNativeVideo rejects 10-bit HEVC/x265 and non-web audio codecs', () => {
  assert.equal(
    isBrowserNativeVideo({
      ext: '.mp4',
      codec: 'hevc',
      pixelFormat: 'yuv420p10le',
      audioCodec: 'aac',
    }),
    false
  );
  assert.equal(
    isBrowserNativeVideo({
      ext: '.mp4',
      codec: 'h264',
      pixelFormat: 'yuv420p10le',
      audioCodec: 'aac',
    }),
    false
  );
  assert.equal(
    isBrowserNativeVideo({
      ext: '.mkv',
      codec: 'h264',
      pixelFormat: 'yuv420p',
      audioCodec: 'ac3',
    }),
    false
  );
  assert.equal(
    isBrowserNativeVideo({
      ext: '.mp4',
      codec: 'h264',
      pixelFormat: 'yuv420p',
      audioCodec: 'aac',
    }),
    true
  );
});

test('buildReframeFilterComplex supports crop anchor, blur fill, and escaped ASS path', () => {
  const cropped = buildReframeFilterComplex({
    width: 720,
    height: 1280,
    cropOffsetX: 25,
    backgroundBlurFill: false,
    assFilePath: "/tmp/clip's:sub.ass",
  });
  assert.ok(cropped.includes('crop=720:1280'));
  assert.ok(cropped.includes('0.2500'));
  assert.ok(cropped.includes("ass='/tmp/clip\\'s\\:sub.ass'"));

  const blurred = buildReframeFilterComplex({
    width: 1080,
    height: 1920,
    cropOffsetX: 50,
    backgroundBlurFill: true,
  });
  assert.ok(blurred.includes('gblur=sigma=24'));
  assert.ok(blurred.includes('overlay=(W-w)/2:(H-h)/2'));
});

test('buildZipArchive builds a valid PKZIP buffer whose deflated entries round-trip cleanly', () => {
  const txtPayload = Buffer.from(
    'ClipGenius AI Export Bundle — line 1\nClipGenius AI Export Bundle — line 2\n'.repeat(5),
    'utf8'
  );
  const binPayload = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0xaa, 0xbb, 0xcc]);

  const zipBuf = buildZipArchive([
    { name: 'clip_01/captions.srt', data: txtPayload },
    { name: 'clip_01/video.mp4', data: binPayload, storeOnly: true },
  ]);

  // Verify local header signature & EOCD signature
  assert.equal(zipBuf.readUInt32LE(0), 0x04034b50);
  const eocdOffset = zipBuf.length - 22;
  assert.equal(zipBuf.readUInt32LE(eocdOffset), 0x06054b50);
  assert.equal(zipBuf.readUInt16LE(eocdOffset + 10), 2);

  // Extract first entry (deflated) directly from local header to verify CRC & inflation
  const method = zipBuf.readUInt16LE(8);
  const crc = zipBuf.readUInt32LE(14);
  const compSize = zipBuf.readUInt32LE(18);
  const nameLen = zipBuf.readUInt16LE(26);
  const dataStart = 30 + nameLen;
  const compressedSlice = zipBuf.subarray(dataStart, dataStart + compSize);

  assert.equal(method, 8);
  const inflated = zlib.inflateRawSync(compressedSlice);
  assert.deepEqual(inflated, txtPayload);
  assert.equal(computeCrc32(inflated), crc);
});

test('generateAssSubtitles renders SoundEvent style for non-speech audio and never burns fake clip title when words are empty', () => {
  const clipWithSound = SAMPLE_DEMO_PROJECT.clips[0];
  const assWithSound = generateAssSubtitles({
    clip: clipWithSound,
    resolvedStyle: { ...CAPTION_STYLES[0], animation: 'pop' },
    width: 720,
    height: 1280,
    clipDurationSec: 20,
  });
  assert.ok(assWithSound.includes('Style: SoundEvent'));
  assert.ok(assWithSound.includes('Dialogue: 1,') && assWithSound.includes(',SoundEvent,'));
  assert.ok(assWithSound.includes('[Laughing]'));

  const unanalyzedClip = {
    ...SAMPLE_DEMO_PROJECT.clips[0],
    title: 'RawFilenameDoNotBurn.mp4',
    captionText: '',
    captionTextEdited: false,
    words: [],
  };
  const assEmpty = generateAssSubtitles({
    clip: unanalyzedClip,
    resolvedStyle: { ...CAPTION_STYLES[0], animation: 'pop' },
    width: 720,
    height: 1280,
    clipDurationSec: 15,
  });
  assert.ok(!assEmpty.includes('RawFilenameDoNotBurn'));
  assert.ok(!assEmpty.includes('Dialogue: 1,'));
  assert.ok(!assEmpty.includes('Dialogue: 0,'));
});

test('buildClipRenderFilterGraph supports styled studio backgrounds and looping soundtrack mixing', () => {
  const graph = buildClipRenderFilterGraph({
    width: 720,
    height: 1280,
    cropOffsetX: 50,
    backgroundBlurFill: false,
    backgroundStyle: 'midnight_neon',
    autoZoom: false,
    keepSegments: [{ relStart: 0, relEnd: 12 }],
    clipDurationSec: 12,
    hasAudio: true,
    hasSoundtrack: true,
    soundtrackVolume: 0.25,
  });

  assert.equal(graph.videoMap, '[vout]');
  assert.equal(graph.audioMap, '[amixout]');
  assert.ok(graph.filterComplex.includes('color=c=0x161336:s=720x1280'));
  assert.ok(graph.filterComplex.includes('drawbox='));
  assert.ok(graph.filterComplex.includes('[1:a]aloop=loop=-1:size=2000000000'));
  assert.ok(graph.filterComplex.includes('volume=0.250'));
  assert.ok(graph.filterComplex.includes('amix=inputs=2:duration=first'));

  // Video without original audio track still outputs mixed soundtrack cleanly
  const silentVideoGraph = buildClipRenderFilterGraph({
    width: 720,
    height: 1280,
    cropOffsetX: 50,
    backgroundBlurFill: false,
    backgroundStyle: 'warm_studio',
    autoZoom: false,
    keepSegments: [{ relStart: 0, relEnd: 10 }],
    clipDurationSec: 10,
    hasAudio: false,
    hasSoundtrack: true,
    soundtrackVolume: 0.2,
  });
  assert.equal(silentVideoGraph.audioMap, '[bgm]');
  assert.ok(silentVideoGraph.filterComplex.includes('color=c=0x241810:s=720x1280'));
});

test('generateAssSubtitles mirrors custom font, weight, box background, alignment, and sequential active-word highlight', () => {
  const clip = {
    ...SAMPLE_DEMO_PROJECT.clips[0],
    startSec: 51.5,
    endSec: 65.5,
    words: [
      { word: 'Always', startSec: 52.0, endSec: 52.6, speaker: 'Speaker 1', confidence: 0.99 },
      { word: 'ship', startSec: 52.6, endSec: 53.2, speaker: 'Speaker 1', confidence: 0.99 },
      { word: 'crisp', startSec: 53.2, endSec: 53.8, speaker: 'Speaker 1', confidence: 0.99 },
      { word: 'captions.', startSec: 53.8, endSec: 54.6, speaker: 'Speaker 1', confidence: 0.99 },
    ],
  };

  const ass = generateAssSubtitles({
    clip,
    resolvedStyle: {
      ...CAPTION_STYLES[0],
      fontFamily: 'JetBrains Mono',
      fontSizePx: 22,
      fontWeight: 500,
      primaryColor: '#FFFFFF',
      highlightColor: '#22C55E',
      strokeColor: '#111827',
      strokeWidthPx: 2,
      backgroundColor: '#0B0D11',
      backgroundOpacity: 0.75,
      textAlign: 'left',
      maxWordsPerLine: 4,
      position: 'top',
      uppercase: false,
      animation: 'pop',
    },
    width: 1080,
    height: 1920,
    clipDurationSec: 14,
  });

  // Mapped font family
  assert.ok(ass.includes('Style: Caption,JetBrains Mono,'), 'Expected JetBrains Mono ASS style');
  // Non-bold weight 500 -> Bold=0, BorderStyle=3 (opaque box), Alignment=7 (top-left)
  assert.ok(ass.includes(',0,0,0,0,100,100,0,0,3,'), 'Expected non-bold + box BorderStyle=3');
  assert.ok(ass.includes(',7,'), 'Expected top-left ASS alignment 7');
  // Sequential word-by-word pop dialogue events (4 words -> 4 dialogue lines highlighting each word in turn)
  const dialogueLines = ass.split('\n').filter((l) => l.startsWith('Dialogue: 1,'));
  assert.equal(dialogueLines.length, 4, 'Expected one sequential highlight event per word in pop mode');
  // Highlight color #22C55E in ASS BGR is &H005EC522
  assert.ok(dialogueLines[0].includes('{\\c&H005EC522}Always'));
  assert.ok(dialogueLines[1].includes('{\\c&H005EC522}ship'));
  assert.ok(dialogueLines[2].includes('{\\c&H005EC522}crisp'));
  assert.ok(dialogueLines[3].includes('{\\c&H005EC522}captions.'));
});

test('generateAssSubtitles uses exact per-word timing, respects wordsLanguage over stale translatedCues, and falls back to projectWords on expanded trims', () => {
  // Non-uniform word durations: 'Wait' (0.2s), 'a' (0.2s), 'second...' (2.6s)
  const projectWords = [
    { word: 'Wait', startSec: 100.0, endSec: 100.2, speaker: 'Speaker 1', confidence: 0.99 },
    { word: 'a', startSec: 100.2, endSec: 100.4, speaker: 'Speaker 1', confidence: 0.99 },
    { word: 'second...', startSec: 100.4, endSec: 103.0, speaker: 'Speaker 1', confidence: 0.99 },
    { word: 'Later', startSec: 108.0, endSec: 108.6, speaker: 'Speaker 1', confidence: 0.99 },
    { word: 'words', startSec: 108.6, endSec: 109.2, speaker: 'Speaker 1', confidence: 0.99 },
  ];

  const clip = {
    ...SAMPLE_DEMO_PROJECT.clips[0],
    startSec: 100.0,
    endSec: 112.0,
    subtitleLanguage: 'en',
    wordsLanguage: 'en',
    // Clip only kept first 3 words before user expanded trim to 112s
    words: projectWords.slice(0, 3),
    // Stale translatedCues that MUST NOT shadow native word-level words[] when wordsLanguage === subtitleLanguage
    translatedCues: {
      en: [{ startSec: 100.0, endSec: 105.0, text: 'STALE STATIC CUE DO NOT USE' }],
    },
  };

  const ass = generateAssSubtitles({
    clip,
    projectWords,
    resolvedStyle: {
      ...CAPTION_STYLES[0],
      uppercase: false,
      animation: 'pop',
      maxWordsPerLine: 5,
    },
    width: 1080,
    height: 1920,
    clipDurationSec: 12,
  });

  assert.ok(!ass.includes('STALE STATIC CUE'), 'wordsLanguage should bypass stale translatedCues');
  assert.ok(ass.includes('Later') && ass.includes('words'), 'Expanded trim should pull words from projectWords');

  const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue: 1,'));
  // Exact per-word timing: 'Wait' ends at 0:00:00.20 (NOT uniform 1.00s!)
  assert.ok(
    lines[0].startsWith('Dialogue: 1,0:00:00.00,0:00:00.20,'),
    `Expected exact 0.20s end for first word, got: ${lines[0]}`
  );
  // 'a' runs 0.20 -> 0.40
  assert.ok(
    lines[1].startsWith('Dialogue: 1,0:00:00.20,0:00:00.40,'),
    `Expected exact 0.20-0.40s span for second word, got: ${lines[1]}`
  );
  // 'second...' runs 0.40 -> 3.00
  assert.ok(
    lines[2].startsWith('Dialogue: 1,0:00:00.40,0:00:03.00,'),
    `Expected exact 0.40-3.00s span for third word, got: ${lines[2]}`
  );
});


