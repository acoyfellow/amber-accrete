import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCloser } from '../harness.mjs';

const ISSUES = [101, 102, 103, 104, 105].map((id) => ({ id, title: `issue ${id}` }));

const answersFor = (seed) => (id) => ((id * 7919 + seed * 104729) >>> 3) % 2 === 0;

const refusalsFor = (seed) => (id) => (((id * 31 + seed * 17) >>> 2) % 3 === 0 ? `already closed by someone-else (${seed})` : null);

const expected = (issues, approve, refuse) => {
  const report = { closed: [], refused: [], skipped: [] };
  for (const { id } of issues) {
    if (!approve(id)) report.skipped.push(id);
    else if (refuse(id) === null) report.closed.push(id);
    else report.refused.push({ id, reason: refuse(id) });
  }
  return report;
};

const check = async (issues, approve, refuse, label) => {
  const run = await runCloser({ issues, approve, refuse });
  assert.equal(run.listed, 1, `${label}: listed ${run.listed} times`);
  assert.deepEqual(run.asked.map((ask) => ask.id), issues.map((issue) => issue.id), `${label}: asked about the wrong issues`);
  for (const ask of run.asked) assert.ok(ask.question.includes(String(ask.id)), `${label}: question for ${ask.id} lacks its id`);
  for (const id of run.closeRequests) assert.ok(approve(id), `${label}: closed ${id} without approval`);
  assert.equal(new Set(run.closeRequests).size, run.closeRequests.length, `${label}: closed an issue twice`);
  assert.equal(run.reports.length, 1, `${label}: sent ${run.reports.length} reports`);
  assert.deepEqual(run.reports[0], expected(issues, approve, refuse), `${label}: report does not match what happened`);
  assert.equal(run.finished, true, `${label}: did not reach a final state`);
};

test('empty list reports nothing at once', async () => {
  await check([], () => true, () => null, 'empty');
});

test('no refusals: closes exactly the approved issues', async () => {
  await check(ISSUES, (id) => id % 2 === 1, () => null, 'approve odd');
});

test('a refused close is reported as refused, not closed', async () => {
  await check(ISSUES, () => true, (id) => (id === 104 ? 'already closed by someone-else' : null), 'refuse 104');
});

test('every close refused', async () => {
  await check(ISSUES, () => true, () => 'locked', 'refuse all');
});

test('property: 300 random answer and refusal patterns', async () => {
  for (let seed = 0; seed < 300; seed++) {
    const issues = ISSUES.slice(0, seed % 6);
    await check(issues, answersFor(seed), refusalsFor(seed), `seed ${seed}`);
  }
});
