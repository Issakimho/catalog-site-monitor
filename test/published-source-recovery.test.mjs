import test from "node:test";
import assert from "node:assert/strict";
import { canReconcilePublishedSource, reconcilePublishedSource } from "../scripts/published-source-recovery.mjs";
import { sourceHealthSummary, observeCollection } from "../scripts/source-health.mjs";

const sha = "a".repeat(40);
const date = "2026-10-06T15:52:39.137Z";
const state = { attempts: [1, 2], resumeAttempts: [3, 4], lastWorkspace: "/private/attempt-original", lastFailure: { step: "run verify:publication" },
  sourceHealth: { version: 1, queries: {}, events: [], workflow: { firstFailedAt: date, lastFailedAt: date, failures: 1 } } };
test("externally published Spanish source can reconcile once without reopening collection budgets", async () => {
  const health = { status: "healthy", generatedAt: date };
  assert.equal(canReconcilePublishedSource(health, state, date, sha), true);
  assert.equal(canReconcilePublishedSource({ status: "healthy" }, state, undefined, sha), false);
  assert.equal(canReconcilePublishedSource(health, state, date, "invalid-sha"), false);
  for (const [h, s, d] of [[{ ...health, status: "warning" }, state, date], [health, { ...state, pendingSha: sha }, date], [health, { ...state, externalReconciliationSha: sha }, date], [health, state, "2026-10-05T15:50:23.889Z"], [health, { ...state, lastFailure: { step: "run fetch:amazon-catalog" } }, date]]) {
    assert.equal(canReconcilePublishedSource(h, s, d, sha), false);
  }
  const original = structuredClone(state);
  const calls = [];
  const recovered = await reconcilePublishedSource(state, { sourceBytes: Buffer.from("original supplier observation"), publishedBytes: Buffer.from("original supplier observation"),
    verify: async () => { calls.push("exact CI, deployment, bytes and browser"); return { sha }; }, observe: async (current) => { calls.push("supplier observation"); return current; } });
  assert.deepEqual(calls, ["exact CI, deployment, bytes and browser", "supplier observation"]);
  assert.equal(sourceHealthSummary(recovered.state).workflowFailure, false);
  assert.deepEqual(recovered.state.attempts, original.attempts);
  assert.deepEqual(recovered.state.resumeAttempts, original.resumeAttempts);
  assert.deepEqual(state, original);
});
test("changed evidence or failed production proof never resolves the original incident", async () => {
  let verified = false;
  await assert.rejects(reconcilePublishedSource(state, { sourceBytes: Buffer.from("original"), publishedBytes: Buffer.from("changed"), verify: async () => { verified = true; } }), /supplier_evidence_mismatch/);
  assert.equal(verified, false);
  await assert.rejects(reconcilePublishedSource(state, { sourceBytes: Buffer.from("original"), publishedBytes: Buffer.from("original"), verify: async () => { throw new Error("failed CI/deployment/browser"); } }), /failed CI/);
  assert.equal(sourceHealthSummary(state).workflowFailure, true);
});
test("an externally repaired publication preserves unresolved supplier query failures", async () => {
  const current = observeCollection(structuredClone(state), { schemaVersion: 1,
    collectionId: "00000000-0000-0000-0000-000000000001", marketplace: "ES", observedAt: date,
    queries: [{ key: "b".repeat(64), status: "failed", code: "request_failed" }] }, "es");
  const result = await reconcilePublishedSource(current, { sourceBytes: Buffer.from("same"), publishedBytes: Buffer.from("same"),
    verify: async () => ({ sha }), observe: async (s) => s });
  assert.equal(sourceHealthSummary(result.state).workflowFailure, false);
  assert.equal(sourceHealthSummary(result.state).unresolvedQueries, 1);
  assert.equal(sourceHealthSummary(result.state).canCloseIncident, false);
});
