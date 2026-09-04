import test from 'node:test';
import assert from 'node:assert/strict';
import { InferenceScheduler } from '../src/scheduler.mjs';

test('scheduler serializes work, coalesces previews, and prioritizes finals', async () => {
  const scheduler = new InferenceScheduler();
  const order = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const active = scheduler.enqueuePreview('active', async () => {
    concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent); order.push('active');
    await blocker; concurrent -= 1; return 'active';
  });
  const stale = scheduler.enqueuePreview('same', async () => { order.push('stale'); });
  const newest = scheduler.enqueuePreview('same', async () => { concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent); order.push('newest'); concurrent -= 1; return 'newest'; });
  const final = scheduler.enqueueFinal('final', async () => { concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent); order.push('final'); concurrent -= 1; return 'final'; });
  release();
  assert.deepEqual(await stale, { superseded: true });
  await Promise.all([active, newest, final]);
  assert.deepEqual(order, ['active', 'final', 'newest']);
  assert.equal(maxConcurrent, 1);
  scheduler.close();
});
