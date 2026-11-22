import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCloser } from './harness.mjs';

test('the chart compiles and runs to a final state on an empty list', async () => {
  const run = await runCloser({ issues: [], approve: () => false });
  assert.equal(run.finished, true);
});
