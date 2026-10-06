import assert from "node:assert/strict";
import { recordVerifiedWorkflow } from "./source-health.mjs";

export function canReconcilePublishedSource(health, state, candidateDate, sha) {
  return health.status === "healthy" && /^[a-f0-9]{40}$/.test(sha ?? "")
    && Number.isFinite(Date.parse(candidateDate))
    && !state.pendingSha && state.lastFailure?.step === "run verify:publication"
    && candidateDate === health.generatedAt
    && state.externalReconciliationSha !== sha;
}

export async function reconcilePublishedSource(state, { sourceBytes, publishedBytes, verify, observe }) {
  assert.deepEqual(publishedBytes, sourceBytes, "published_supplier_evidence_mismatch");
  const proof = await verify();
  assert.match(proof.sha, /^[a-f0-9]{40}$/);
  // Collection budgets and unresolved query incidents are retained. Only the
  // verified published observations can resolve their corresponding failures.
  return { state: recordVerifiedWorkflow(await observe(state, proof.sha), proof), proof };
}
