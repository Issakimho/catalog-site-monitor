import test from 'node:test';
import assert from 'node:assert/strict';
import { observeCollection, sourceHealthSummary, recordWorkflowFailure, recordVerifiedWorkflow } from '../scripts/source-health.mjs';
import { decideRecovery } from '../scripts/local-recovery.mjs';
const H = 3_600_000, now = Date.now(), sha = 'a'.repeat(40), key = 'b'.repeat(64), other = 'c'.repeat(64);
const report = (n, status = 'failed', query = key) => ({ schemaVersion: 1, collectionId: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`, marketplace: 'DE', observedAt: new Date(now - (10 - n) * H).toISOString(), queries: [{ key: query, status, ...(status === 'failed' ? { code: 'request_failed' } : {}) }] });
test('partial failure survives healthy publication, restart and replay', () => {
  let state = observeCollection({}, report(1), 'de');
  state = JSON.parse(JSON.stringify(state));
  state = observeCollection(state, report(1), 'de');
  assert.equal(state.sourceHealth.queries[key].failures, 1);
  state = observeCollection(state, report(2, 'healthy', other), 'de', { verifiedSha: sha });
  state = recordVerifiedWorkflow(state, { sha });
  assert.equal(sourceHealthSummary(state, now).unresolvedQueries, 1);
  assert.equal(sourceHealthSummary(state, now).canCloseIncident, false);
  assert.equal(decideRecovery({ status: 'healthy', ageHours: 1 }, state, now), 'refresh');
  assert.equal(decideRecovery({ status: 'healthy', ageHours: 1 }, { ...state, attempts: [now-H, now-3*H] }, now), 'retry_limit');
});
test('three actual failures or 36 hours request attention while public catalog is healthy', () => {
  let state = {};
  for (let n = 1; n <= 3; n++) state = observeCollection(state, report(n), 'de');
  assert.equal(sourceHealthSummary(state, now).persistentQueries, 1);
  assert.equal(sourceHealthSummary(state, now).attentionRequired, true);
  const first = observeCollection({}, report(1), 'de');
  assert.equal(sourceHealthSummary(first, now).attentionRequired, false);
  assert.equal(sourceHealthSummary(first, now + 37*H).attentionRequired, true);
});
test('only a later observation of the failed query with production proof resolves it', () => {
  let state = observeCollection({}, report(3), 'de');
  state = observeCollection(state, report(4, 'healthy'), 'de');
  assert.equal(sourceHealthSummary(state, now).unresolvedQueries, 1);
  state = observeCollection(state, report(2, 'healthy'), 'de', { verifiedSha: sha });
  assert.equal(sourceHealthSummary(state, now).unresolvedQueries, 1);
  state = observeCollection(state, report(4, 'healthy'), 'de', { verifiedSha: sha });
  state = recordVerifiedWorkflow(state, { sha });
  assert.equal(sourceHealthSummary(state, now).unresolvedQueries, 0);
  assert.equal(sourceHealthSummary(state, now).canCloseIncident, true);
  assert.ok(state.sourceHealth.events.some(e => e.status === 'resolved'));
});
test('workflow failure stays active across a healthy no-op and keeps bounded history', () => {
  let state = { lastFailure: { at: new Date(now-H).toISOString(), step: 'run fetch:amazon-catalog', code: 'command_failed' } };
  assert.equal(decideRecovery({ status: 'healthy', ageHours: 1 }, state, now), 'refresh');
  for (let n = 0; n < 120; n++) state = recordWorkflowFailure(state, state.lastFailure, `attempt-${n}`);
  assert.equal(state.sourceHealth.events.length, 100);
  assert.equal(state.sourceHealth.workflow.failures, 120);
  assert.equal(sourceHealthSummary(state).canCloseIncident, false);
  state = recordVerifiedWorkflow(state, { sha });
  assert.equal(sourceHealthSummary(state).attentionRequired, false);
  assert.equal(sourceHealthSummary(state).canCloseIncident, true);
});
test('wrong-market or malformed reports cannot resolve an incident', () => {
  assert.throws(() => observeCollection({}, report(1), 'it'));
  assert.throws(() => observeCollection({}, { ...report(1), queries: [] }, 'de'));
  assert.throws(() => observeCollection({}, report(1), 'de', { verifiedSha: 'unverified' }));
});
