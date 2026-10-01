import test from "node:test";
import assert from "node:assert/strict";
import { assertRepairPullRequest, assertProtectedContracts, candidatePaths, publicationPlan, repairEnvironment, validatedPullRequest } from "../scripts/engine-auto-repair.mjs";

test("the coding process does not inherit supplier or GitHub credentials", () => {
  const env = repairEnvironment({ PATH: "/bin", HOME: "/home/imho", CODEX_HOME: "/home/imho/.codex", LANG: "en_US.UTF-8",
    AMAZON_CREATORS_SECRET: "supplier", AMAZON_ENV_PATH: "/private/it.env", GH_TOKEN: "github", OPENAI_API_KEY: "paid" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/imho", CODEX_HOME: "/home/imho/.codex", LANG: "en_US.UTF-8", GIT_TERMINAL_PROMPT: "0" });
});

test("candidate files are exact market-local catalog artifacts", () => {
  assert.deepEqual(candidatePaths({ demo: "demo/amazon-products.mjs" }, { data: "/data/" }), [
    "demo/amazon-products.mjs", "public/data/catalog-current.json", "public/data/catalog-manifest.json"
  ]);
  assert.deepEqual(candidatePaths({ demo: "demo/amazon-products.mjs" }, { data: "/data/de-DE/" })[1], "public/data/de-DE/catalog-current.json");
});

test("automatic merge waits for the PR CI workflow and every check", () => {
  const passed = [{ path: ".github/workflows/ci.yml", event: "pull_request", status: "completed", conclusion: "success" }];
  const success = [{ status: "completed", conclusion: "success" }];
  assert.equal(validatedPullRequest(success, passed), true);
  assert.equal(validatedPullRequest(success, []), false);
  assert.equal(validatedPullRequest([{ status: "in_progress", conclusion: null }], passed), false);
  assert.throws(() => validatedPullRequest(success, [{ ...passed[0], conclusion: "failure" }]));
  assert.throws(() => validatedPullRequest([{ status: "completed", conclusion: "failure" }], passed));
});

test("publication tests stay offline while the fixed dependency audit runs separately", () => {
  const it = publicationPlan({ scripts: { "verify:publication": "npm test && npm run build && npm audit --omit=dev --audit-level=high" } });
  assert.equal(it.offline, "npm test && npm run build");
  assert.deepEqual(it.audit, ["audit", "--omit=dev", "--audit-level=high"]);
  const de = publicationPlan({ scripts: { "verify:publication": "npm run quality && npm run audit:dependencies",
    "audit:dependencies": "npm audit --audit-level=high" } });
  assert.equal(de.offline, "npm run quality");
  assert.deepEqual(de.audit, ["audit", "--audit-level=high"]);
  assert.throws(() => publicationPlan({ scripts: { "verify:publication": "npm test && curl https://example.com" } }));
});


test("repairs append regression coverage and cannot weaken tests or replace the digest command", () => {
  const before = { sha256: "a".repeat(64), digestCommand: "trusted command", scope: "engine", sourceRevision: "base" };
  assertProtectedContracts("old test\n", "old test\nnew assertion\n", before, { ...before, sha256: "b".repeat(64), note: "fix" });
  assert.throws(() => assertProtectedContracts("old test\n", "weaker test\n", before, before));
  assert.throws(() => assertProtectedContracts("old test\n", "old test\n", before, before));
  assert.throws(() => assertProtectedContracts("test", "test plus", before, { ...before, digestCommand: "untrusted" }));
  assert.throws(() => assertProtectedContracts("test", "test plus", before, { ...before, sourceRevision: "fake" }));
});


test("resuming a repair never accepts a replaced head, advanced base or an unmerged closed PR", () => {
  const expected = { head: 'a'.repeat(40), base: 'b'.repeat(40) };
  const pr = { state: 'open', head: { sha: expected.head }, base: { sha: expected.base }, merged: false };
  assert.equal(assertRepairPullRequest(pr, expected), 'wait_and_merge');
  assert.throws(() => assertRepairPullRequest({ ...pr, head: { sha: 'x' } }, expected));
  assert.throws(() => assertRepairPullRequest({ ...pr, base: { sha: 'x' } }, expected));
  assert.throws(() => assertRepairPullRequest({ ...pr, state: 'closed' }, { ...expected, allowMerged: true }));
  const merged = { ...pr, state: 'closed', merged: true, merge_commit_sha: 'c'.repeat(40) };
  assert.equal(assertRepairPullRequest(merged, { ...expected, allowMerged: true }), 'verify_merged');
  assert.throws(() => assertRepairPullRequest(merged, expected));
});


test("market-specific calibration digests can be renewed without changing their protected provenance", () => {
  const runtime = { sha256: 'a'.repeat(64), runtimeVerification: { baseRevision: 'old', sha256: 'b'.repeat(64), files: ['engine.mjs'] } };
  const revised = { ...runtime, runtimeVerification: { ...runtime.runtimeVerification, sha256: 'c'.repeat(64), updatedAt: '2026-10-01' } };
  assertProtectedContracts('old', 'old plus regression', runtime, revised);
  assert.throws(() => assertProtectedContracts('old', 'old plus', runtime, { ...revised, runtimeVerification: { ...revised.runtimeVerification, files: [] } }));
  const spanish = { invariantLogic: { sourceDigest: 'a'.repeat(64), targetDigest: 'b'.repeat(64), files: ['engine.mjs'] } };
  assertProtectedContracts('old', 'old plus', spanish, { invariantLogic: { ...spanish.invariantLogic, targetDigest: 'c'.repeat(64) } });
  assert.throws(() => assertProtectedContracts('old', 'old plus', spanish, { invariantLogic: { ...spanish.invariantLogic, sourceDigest: 'c'.repeat(64) } }));
  assert.throws(() => assertProtectedContracts('old', 'old plus', runtime, { ...runtime, runtimeVerification: { files: ['engine.mjs'], baseRevision: 'old' } }));
});


test("enrichment repair freezes only the six review artifacts and rejects unknown sources", () => {
  for (const data of ["/data/", "/data/de-DE/"]) {
    assert.deepEqual(candidatePaths({ demo: "demo/amazon-products.mjs" }, { data }, "enrichment"), [
      "config/product-enrichment-codex.json", "exports/catalog-review/pending.json",
      "exports/catalog-review/reviewed.json", "exports/catalog-review/report.json",
      `public${data}catalog-current.json`, `public${data}catalog-manifest.json`
    ]);
  }
  assert.throws(() => candidatePaths({}, {}, "other"), /unknown_candidate_kind/);
});
