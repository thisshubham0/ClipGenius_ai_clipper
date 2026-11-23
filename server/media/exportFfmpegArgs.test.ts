import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPlayableDownloadContentType,
  normalizeExportContainerFormat,
  normalizeExportQuality,
} from '../../src/lib/exportFormats';
import { appendGifPaletteFilter, buildContainerEncodingArgs } from './exportFfmpegArgs';
import { buildClipRenderFilterGraph, getTargetDimensions } from './renderSpec';

test('buildContainerEncodingArgs generates universal faststart H.264/AAC flags for MP4 and MOV', () => {
  const mp4Args = buildContainerEncodingArgs({
    containerFormat: 'mp4',
    quality: '1080p',
    hasAudio: true,
  });
  assert.ok(mp4Args.includes('-map_metadata'));
  assert.ok(mp4Args.includes('libx264'));
  assert.ok(mp4Args.includes('avc1'));
  assert.ok(mp4Args.includes('+faststart'));
  assert.ok(mp4Args.includes('48000'));
  assert.equal(mp4Args[mp4Args.length - 1], 'mp4');

  const movArgs = buildContainerEncodingArgs({
    containerFormat: 'mov',
    quality: '720p',
    hasAudio: true,
  });
  assert.ok(movArgs.includes('avc1'));
  assert.ok(movArgs.includes('+faststart'));
  assert.equal(movArgs[movArgs.length - 1], 'mov');
});

test('buildContainerEncodingArgs generates VP9/Opus for WebM, Matroska for MKV, GIF, and MP3', () => {
  const webmArgs = buildContainerEncodingArgs({
    containerFormat: 'webm',
    quality: '720p',
    hasAudio: true,
  });
  assert.ok(webmArgs.includes('libvpx-vp9'));
  assert.ok(webmArgs.includes('libopus'));
  assert.equal(webmArgs[webmArgs.length - 1], 'webm');

  const mkvArgs = buildContainerEncodingArgs({
    containerFormat: 'mkv',
    quality: '720p',
    hasAudio: false,
  });
  assert.ok(mkvArgs.includes('libx264'));
  assert.ok(mkvArgs.includes('-an'));
  assert.equal(mkvArgs[mkvArgs.length - 1], 'matroska');

  const gifArgs = buildContainerEncodingArgs({
    containerFormat: 'gif',
    quality: '480p',
    hasAudio: true,
  });
  assert.ok(gifArgs.includes('-an'));
  assert.equal(gifArgs[gifArgs.length - 1], 'gif');

  const mp3Args = buildContainerEncodingArgs({
    containerFormat: 'mp3',
    quality: '720p',
    hasAudio: true,
  });
  assert.ok(mp3Args.includes('-vn'));
  assert.ok(mp3Args.includes('libmp3lame'));
  assert.equal(mp3Args[mp3Args.length - 1], 'mp3');
});

test('appendGifPaletteFilter wraps [vout] with palettegen and paletteuse into [vgif]', () => {
  const res = appendGifPaletteFilter('[0:v]scale=480:854[vout]', '[vout]');
  assert.equal(res.videoMap, '[vgif]');
  assert.ok(res.filterComplex.includes('palettegen='));
  assert.ok(res.filterComplex.includes('paletteuse='));
});

test('buildClipRenderFilterGraph omits video filters when includeVideo is false (MP3) and omits audio for GIF', () => {
  const mp3WithTrack = buildClipRenderFilterGraph({
    width: 720,
    height: 1280,
    cropOffsetX: 0,
    backgroundBlurFill: false,
    includeVideo: false,
    hasAudio: true,
    hasSoundtrack: true,
    soundtrackVolume: 0.22,
    clipDurationSec: 10,
  });
  assert.equal(mp3WithTrack.videoMap, null);
  assert.equal(mp3WithTrack.audioMap, '[amixout]');
  assert.ok(!mp3WithTrack.filterComplex.includes('[vout]'));
  assert.ok(mp3WithTrack.filterComplex.includes('amix='));

  const mp3WithCuts = buildClipRenderFilterGraph({
    width: 720,
    height: 1280,
    cropOffsetX: 0,
    backgroundBlurFill: false,
    includeVideo: false,
    hasAudio: true,
    hasSoundtrack: false,
    clipDurationSec: 10,
    keepSegments: [
      { relStart: 0, relEnd: 4 },
      { relStart: 5, relEnd: 9 },
    ],
  });
  assert.equal(mp3WithCuts.videoMap, null);
  assert.equal(mp3WithCuts.audioMap, '[aout]');
  assert.ok(mp3WithCuts.filterComplex.includes('concat=n=2:v=0:a=1[aout]'));
  assert.ok(!mp3WithCuts.filterComplex.includes('[0:v]'));

  const gifGraph = buildClipRenderFilterGraph({
    width: 480,
    height: 854,
    cropOffsetX: 0,
    backgroundBlurFill: false,
    includeVideo: true,
    hasAudio: false,
    hasSoundtrack: false,
    clipDurationSec: 6,
  });
  assert.equal(gifGraph.videoMap, '[vout]');
  assert.equal(gifGraph.audioMap, null);
  assert.ok(!gifGraph.filterComplex.includes('[aout]'));
});

test('getTargetDimensions returns even dimensions for 480p, 720p, and 1080p across all ratios', () => {
  for (const quality of ['480p', '720p', '1080p'] as const) {
    for (const ratio of ['9:16', '16:9', '1:1', '4:5'] as const) {
      const dims = getTargetDimensions(ratio, quality);
      assert.equal(dims.width % 2, 0, `${ratio} ${quality} width must be even`);
      assert.equal(dims.height % 2, 0, `${ratio} ${quality} height must be even`);
      assert.ok(dims.width >= 480 && dims.height >= 480);
    }
  }
});

test('isPlayableDownloadContentType accepts media/zip MIME types and rejects HTML/JSON error responses', () => {
  assert.equal(isPlayableDownloadContentType('video/mp4', 'mp4', 'mp4'), true);
  assert.equal(isPlayableDownloadContentType('video/quicktime', 'mp4', 'mov'), true);
  assert.equal(isPlayableDownloadContentType('video/webm; codecs=vp9', 'mp4', 'webm'), true);
  assert.equal(isPlayableDownloadContentType('image/gif', 'mp4', 'gif'), true);
  assert.equal(isPlayableDownloadContentType('audio/mpeg', 'mp4', 'mp3'), true);
  assert.equal(isPlayableDownloadContentType('application/zip', 'batch_zip', 'mp4'), true);

  assert.equal(isPlayableDownloadContentType('application/json; charset=utf-8', 'mp4', 'mp4'), false);
  assert.equal(isPlayableDownloadContentType('text/html; charset=utf-8', 'mp4', 'mp4'), false);
  assert.equal(isPlayableDownloadContentType('', 'mp4', 'mp4'), false);
});

test('normalizeExportContainerFormat and normalizeExportQuality fall back safely', () => {
  assert.equal(normalizeExportContainerFormat('WEBM'), 'webm');
  assert.equal(normalizeExportContainerFormat('mov'), 'mov');
  assert.equal(normalizeExportContainerFormat('invalid'), 'mp4');
  assert.equal(normalizeExportQuality('480p'), '480p');
  assert.equal(normalizeExportQuality('4k'), '720p');
});
