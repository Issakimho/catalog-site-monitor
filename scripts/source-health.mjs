import assert from 'node:assert/strict';
const HOUR = 3_600_000;
const copy = state => ({ ...state, sourceHealth: structuredClone(state.sourceHealth ?? { version: 1, queries: {}, events: [] }) });
const event = (health, entry) => { health.events = [...(health.events ?? []), entry].slice(-100); };

export function validateCollection(report, market) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.marketplace, market.toUpperCase());
  assert.match(report.collectionId, /^[a-f0-9-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(report.observedAt)) && Date.parse(report.observedAt) <= Date.now() + 60_000);
  assert.ok(Array.isArray(report.queries) && report.queries.length > 0 && report.queries.length <= 1000);
  assert.equal(new Set(report.queries.map(q => q.key)).size, report.queries.length);
  for (const query of report.queries) {
    assert.match(query.key, /^[a-f0-9]{64}$/);
    assert.ok(['healthy', 'failed'].includes(query.status));
    if (query.status === 'failed') assert.ok(['invalid_response', 'provider_error', 'invalid_items', 'request_failed'].includes(query.code));
  }
  return report;
}

// An observation can be replayed after a restart or after publication. It must
// count once; a healthy observation only clears its own query after live proof.
export function observeCollection(state, report, market, { verifiedSha } = {}) {
  validateCollection(report, market);
  if (verifiedSha) assert.match(verifiedSha, /^[a-f0-9]{40}$/);
  const next = copy(state), health = next.sourceHealth;
  for (const query of report.queries) {
    const old = health.queries[query.key];
    if (old && Date.parse(report.observedAt) < Date.parse(old.lastObservedAt)) continue;
    if (query.status === 'failed') {
      if (old?.collectionId === report.collectionId) continue;
      const ongoing = old && !old.resolvedAt;
      health.queries[query.key] = { firstFailedAt: ongoing ? old.firstFailedAt : report.observedAt,
        lastFailedAt: report.observedAt, lastObservedAt: report.observedAt, collectionId: report.collectionId,
        failures: ongoing ? old.failures + 1 : 1, code: query.code };
      event(health, { at: report.observedAt, query: query.key, status: 'failed', code: query.code, collectionId: report.collectionId });
    } else if (old && !old.resolvedAt && verifiedSha) {
      health.queries[query.key] = { ...old, resolvedAt: new Date().toISOString(), lastObservedAt: report.observedAt, verifiedSha };
      event(health, { at: report.observedAt, query: query.key, status: 'resolved', verifiedSha });
    }
  }
  // Keep unresolved incidents; cap resolved records and the event log.
  const resolved = Object.entries(health.queries).filter(([, q]) => q.resolvedAt).sort((a, b) => Date.parse(b[1].resolvedAt) - Date.parse(a[1].resolvedAt));
  for (const [key] of resolved.slice(100)) delete health.queries[key];
  health.lastObservation = { collectionId: report.collectionId, observedAt: report.observedAt };
  return next;
}

export function recordWorkflowFailure(state, failure, attempt) {
  const next = copy(state), health = next.sourceHealth;
  const old = health.workflow;
  if (old?.attempt === attempt && old?.step === failure.step && old?.code === failure.code) return next;
  health.workflow = { firstFailedAt: old?.firstFailedAt ?? failure.at, lastFailedAt: failure.at,
    failures: (old?.failures ?? 0) + 1, attempt, step: failure.step, code: failure.code };
  event(health, { at: failure.at, status: 'workflow_failed', step: failure.step, code: failure.code });
  return next;
}

export function recordVerifiedWorkflow(state, proof) {
  assert.match(proof.sha, /^[a-f0-9]{40}$/);
  const next = copy(state);
  if (next.sourceHealth.workflow || state.lastFailure) event(next.sourceHealth, { at: new Date().toISOString(), status: 'workflow_resolved', verifiedSha: proof.sha });
  delete next.sourceHealth.workflow;
  return { ...next, lastFailure: null, lastSuccess: new Date().toISOString(), proof, pendingSha: null, pendingWorkspace: null };
}

export function sourceHealthSummary(state, now = Date.now()) {
  const active = Object.values(state.sourceHealth?.queries ?? {}).filter(q => !q.resolvedAt);
  const workflow = state.sourceHealth?.workflow ?? state.lastFailure;
  const persistent = active.filter(q => q.failures >= 3 || now - Date.parse(q.firstFailedAt) >= 36 * HOUR);
  return { unresolvedQueries: active.length, persistentQueries: persistent.length,
    oldestFailureAt: active.map(q => q.firstFailedAt).sort()[0] ?? null,
    workflowFailure: Boolean(workflow), attentionRequired: Boolean(workflow) || persistent.length > 0,
    canCloseIncident: !workflow && active.length === 0 && Boolean(state.proof?.sha) };
}
