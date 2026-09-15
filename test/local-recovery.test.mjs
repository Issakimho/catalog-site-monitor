import test from "node:test";
import assert from "node:assert/strict";
import { decideRecovery, assertChangedFiles, collectionEnvironment, pendingDisposition, needsBrowserProbe } from "../scripts/local-recovery.mjs";
const H = 3_600_000;
const now = 100 * H;
test("local monitor signal rechecks live browser without bypassing recovery limits", () => {
  assert.equal(needsBrowserProbe(true, false, { status: "healthy" }), true);
  assert.equal(needsBrowserProbe(true, false, { status: "critical" }), true);
  assert.equal(needsBrowserProbe(false, false, { status: "healthy" }), false);
  assert.equal(needsBrowserProbe(false, true, { status: "healthy" }), true);
  assert.equal(decideRecovery({ status: "healthy", ageHours: 5 }, {}, now), "healthy");
  assert.equal(decideRecovery({ status: "warning" }, { attempts: [now - H] }, now), "cooldown");
  assert.equal(decideRecovery({ status: "critical" }, { attempts: [now-H, now-3*H] }, now), "retry_limit");
});
test("healthy local checks do not collect", () => assert.equal(decideRecovery({ status: "healthy", ageHours: 10 }, {}, now), "healthy"));
test("a rejected or superseded push cannot permanently pin recovery", () => {
  assert.equal(pendingDisposition("a", "a", true), "verify");
  assert.equal(pendingDisposition("a", "b", false), "push_not_published");
  assert.equal(pendingDisposition("a", "b", true), "pending_superseded");
  const state = { pendingSha: null, attempts: [now - 4 * H] };
  assert.equal(decideRecovery({ status: "critical" }, state, now), "refresh");
  assert.equal(decideRecovery({ status: "healthy", ageHours: 2 }, state, now), "healthy");
});
test("renew before daily limit and repair incidents", () => {
  assert.equal(decideRecovery({ status: "healthy", ageHours: 20 }, {}, now), "refresh");
  assert.equal(decideRecovery({ status: "critical" }, {}, now), "refresh");
  assert.equal(decideRecovery({ status: "warning" }, {}, now), "refresh");
});
test("bound retries and preserve pending deployment", () => {
  assert.equal(decideRecovery({ status: "critical" }, { attempts: [now - H] }, now), "cooldown");
  assert.equal(decideRecovery({ status: "critical" }, { attempts: [now - 5 * H, now - 3 * H] }, now), "retry_limit");
  assert.equal(decideRecovery({ status: "critical" }, { attempts: [now - 25 * H] }, now), "refresh");
  assert.equal(decideRecovery({ status: "critical" }, { pendingSha: "x" }, now), "verify_pending");
});
test("publication cannot include code, credentials, or unexpected artifacts", () => {
  assertChangedFiles(["catalog.json"], ["catalog.json"]);
  for (const name of [".env", "src/selector.mjs", "../catalog.json", "README.md"]) assert.throws(() => assertChangedFiles([name], ["catalog.json"]));
});
test("supplier environment cannot inherit another market or paid model keys", () => {
  const env = collectionEnvironment({ PATH: "/bin", AMAZON_MARKETPLACE: "FR", AMAZON_QUERY_BATCH_INDEX: "9", OPENAI_API_KEY: "paid", GH_TOKEN: "private" },
    { marketplace: "DE", associateTag: "target", secret: "supplier" }, "/approved/.env", true);
  assert.equal(env.AMAZON_MARKETPLACE, "DE");
  assert.equal(env.AMAZON_CREATORS_SECRET, "supplier");
  assert.equal(env.AMAZON_QUERY_BATCH_SIZE, "0");
  for (const key of ["OPENAI_API_KEY", "GH_TOKEN", "AMAZON_QUERY_BATCH_INDEX"]) assert.equal(env[key], undefined);
});
