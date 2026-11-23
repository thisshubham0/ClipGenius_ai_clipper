import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeChunkProgressPct,
  summarizeUploadQueue,
  upsertQueueItem,
  type ActiveUploadState,
} from './uploadManager';

function makeItem(overrides: Partial<ActiveUploadState> = {}): ActiveUploadState {
  return {
    id: overrides.id ?? 'up_1',
    filename: overrides.filename ?? 'podcast.mp4',
    sizeBytes: overrides.sizeBytes ?? 6 * 1024 * 1024,
    mimeType: overrides.mimeType ?? 'video/mp4',
    progressPct: overrides.progressPct ?? 0,
    status: overrides.status ?? 'uploading',
    nextChunkIndex: overrides.nextChunkIndex ?? 0,
    ...overrides,
  };
}

test('summarizeUploadQueue returns empty defaults when queue is empty', () => {
  const summary = summarizeUploadQueue([]);
  assert.deepEqual(summary, {
    activeCount: 0,
    pausedCount: 0,
    completedCount: 0,
    errorCount: 0,
    overallProgressPct: 0,
    hasInFlight: false,
  });
});

test('summarizeUploadQueue aggregates active, validating, paused, completed, and errored uploads', () => {
  const queue: ActiveUploadState[] = [
    makeItem({ id: 'a', status: 'uploading', progressPct: 40 }),
    makeItem({ id: 'b', status: 'validating', progressPct: 98 }),
    makeItem({ id: 'c', status: 'paused', progressPct: 25 }),
    makeItem({ id: 'd', status: 'queued_phase2', progressPct: 100 }),
    makeItem({ id: 'e', status: 'error', progressPct: 10 }),
  ];

  const summary = summarizeUploadQueue(queue);
  assert.equal(summary.activeCount, 2);
  assert.equal(summary.pausedCount, 1);
  assert.equal(summary.completedCount, 1);
  assert.equal(summary.errorCount, 1);
  assert.equal(summary.overallProgressPct, 69); // round((40 + 98) / 2)
  assert.equal(summary.hasInFlight, true);
});

test('summarizeUploadQueue reports 100% when all items are completed and none are in flight', () => {
  const summary = summarizeUploadQueue([
    makeItem({ id: 'done', status: 'queued_phase2', progressPct: 100 }),
  ]);
  assert.equal(summary.hasInFlight, false);
  assert.equal(summary.completedCount, 1);
  assert.equal(summary.overallProgressPct, 100);
});

test('upsertQueueItem updates only the matching upload item immutably', () => {
  const original = [
    makeItem({ id: '1', progressPct: 10 }),
    makeItem({ id: '2', progressPct: 50 }),
  ];

  const next = upsertQueueItem(original, '2', (it) => ({
    ...it,
    progressPct: 80,
    nextChunkIndex: 2,
  }));

  assert.equal(next[0], original[0]);
  assert.equal(next[1].progressPct, 80);
  assert.equal(next[1].nextChunkIndex, 2);
  assert.equal(original[1].progressPct, 50);
});

test('computeChunkProgressPct scales chunks smoothly and caps at 96 before FFprobe validation', () => {
  assert.equal(computeChunkProgressPct(0, 4), 0);
  assert.equal(computeChunkProgressPct(1, 4), 24);
  assert.equal(computeChunkProgressPct(2, 4), 48);
  assert.equal(computeChunkProgressPct(4, 4), 95);
  assert.equal(computeChunkProgressPct(10, 4), 95);
  assert.equal(computeChunkProgressPct(1, 0), 95);
});
