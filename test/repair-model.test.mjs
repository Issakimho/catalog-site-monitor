import test from "node:test";
import assert from "node:assert/strict";
import { EngineValidationFailure, repairModelArgs, withRepairEscalation } from "../scripts/repair-model.mjs";

test("successful medium repair spends no escalation call", async () => {
  const calls = [];
  const result = await withRepairEscalation(async (effort, failure) => {
    calls.push([effort, failure, repairModelArgs(effort)]);
    return "verified";
  });
  assert.equal(result, "verified");
  assert.deepEqual(calls, [["medium", null, ["--model", "gpt-6.1-sol", "-c", 'model_reasoning_effort="medium"']]]);
});

test("a recognized validation failure gets exactly one high attempt with diagnostic", async () => {
  const calls = [];
  const report = { category: "engine_behavior", invariant: "recommendation-selector" };
  const result = await withRepairEscalation(async (effort, failure) => {
    calls.push([effort, failure]);
    if (effort === "medium") throw new EngineValidationFailure(report);
    assert.ok(repairModelArgs(effort).includes('model_reasoning_effort="high"'));
    return "verified";
  });
  assert.equal(result, "verified");
  assert.deepEqual(calls, [["medium", null], ["high", report]]);
});

test("a second failed validation stops, with no third or cheaper-model fallback", async () => {
  const calls = [];
  await assert.rejects(withRepairEscalation(async effort => {
    calls.push(effort);
    throw new EngineValidationFailure({});
  }), /engine_repair_validation_failed/);
  assert.deepEqual(calls, ["medium", "high"]);
});

test("access, audit, publication and guard errors never escalate", async () => {
  for (const reason of ["model_not_available", "quota_exceeded", "audit_failed", "out_of_scope_repair_diff", "repair_ci_failed", "repair_candidate_expired", "engine_repair_validation_failed"]) {
    let calls = 0;
    const error = new Error(reason);
    await assert.rejects(withRepairEscalation(async () => { calls++; throw error; }), actual => actual === error);
    assert.equal(calls, 1);
  }
  assert.throws(() => repairModelArgs("xhigh"), /unsupported_repair_effort/);
});
