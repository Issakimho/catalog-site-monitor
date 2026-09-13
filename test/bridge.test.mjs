import test from "node:test";
import assert from "node:assert/strict";
import { verifyRepairBridge } from "../scripts/verify-repair-bridge.mjs";

function fixture({ state = "active", branch = "main", conclusion = "success", id = 123, event = "workflow_dispatch", status = "completed" } = {}) {
  const calls = [];
  const request = async (path, method, body) => {
    calls.push({ path, method, body });
    if (path.endsWith("/dispatches")) return { workflow_run_id: id };
    if (path.startsWith("actions/runs/")) return { workflow_id: 10, event, head_branch: branch, status, conclusion };
    return { id: 10, path: ".github/workflows/catalog-watchdog.yml", state };
  };
  return { request, calls };
}

test("bridge verifies a single exact main-branch controller run with limited API paths", async () => {
  const { request, calls } = fixture();
  assert.deepEqual(await verifyRepairBridge(request), { dispatchAccepted: true, privateControllerCompleted: true, conclusion: "success" });
  assert.deepEqual(calls[1], { path: "actions/workflows/catalog-watchdog.yml/dispatches", method: "POST", body: { ref: "main" } });
  assert.equal(calls[2].path, "actions/runs/123");
});

test("bridge fails closed on denied access, disabled workflow, unexpected run and failed controller", async () => {
  await assert.rejects(verifyRepairBridge(async () => { throw new Error("github_http_403"); }), /github_http_403/);
  for (const [options, error] of [
    [{ state: "disabled_manually" }, /repair_workflow_not_active/],
    [{ id: null }, /dispatch_not_confirmed/],
    [{ branch: "untrusted" }, /unexpected_repair_run/],
    [{ event: "pull_request" }, /unexpected_repair_run/],
    [{ conclusion: "failure" }, /private_controller_failed/]
  ]) await assert.rejects(verifyRepairBridge(fixture(options).request), error);
});

test("bridge bounds polling without repeated dispatch", async () => {
  const { request, calls } = fixture({ status: "in_progress" });
  let pauses = 0;
  await assert.rejects(verifyRepairBridge(request, { attempts: 3, pause: async () => { pauses++; } }), /private_controller_timeout/);
  assert.equal(pauses, 2);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});
