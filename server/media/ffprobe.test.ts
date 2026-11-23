import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFfprobeJson, parseFrameRate } from './ffprobe';
import { parseHttpRange } from '../storage/storageAdapter';

test('parseFrameRate handles fractional and integer rates safely', () => {
  assert.equal(parseFrameRate('30000/1001'), 29.97);
  assert.equal(parseFrameRate('60/1'), 60);
  assert.equal(parseFrameRate('0/0'), 30);
});

test('parseFfprobeJson extracts video metadata when valid video stream exists', () => {
  const sample = JSON.stringify({
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1920,
        height: 1080,
        avg_frame_rate: '30/1',
      },
      {
        codec_type: 'audio',
        codec_name: 'aac',
      },
    ],
    format: {
      duration: '124.5',
      size: '52428800',
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    },
  });

  const parsed = parseFfprobeJson(sample);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.width, 1920);
  assert.equal(parsed.height, 1080);
  assert.equal(parsed.fps, 30);
  assert.equal(parsed.durationSec, 124.5);
  assert.equal(parsed.codec, 'H264 / AAC');
  assert.equal(parsed.hasAudio, true);
});

test('parseFfprobeJson rejects non-video files lacking video stream', () => {
  const audioOnly = JSON.stringify({
    streams: [{ codec_type: 'audio', codec_name: 'mp3' }],
    format: { duration: '45.0', size: '1024000' },
  });
  const parsed = parseFfprobeJson(audioOnly);
  assert.equal(parsed.valid, false);
  assert.match(parsed.error ?? '', /valid video stream/);
});

test('parseHttpRange parses single, open-ended, and suffix byte ranges', () => {
  assert.deepEqual(parseHttpRange('bytes=0-1023', 5000), { start: 0, end: 1023 });
  assert.deepEqual(parseHttpRange('bytes=1000-', 5000), { start: 1000, end: 4999 });
  assert.deepEqual(parseHttpRange('bytes=-500', 5000), { start: 4500, end: 4999 });
  assert.equal(parseHttpRange('bytes=6000-7000', 5000), null);
});
