import test from "node:test";
import assert from "node:assert/strict";
import { candidatePaths, publicationPlan, repairEnvironment, validatedPullRequest } from "../scripts/engine-auto-repair.mjs";

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
