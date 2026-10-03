import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runEngineAutoRepair } from "../scripts/engine-auto-repair.mjs";

const engine = "src/modules/recommendation/selection/fixture.mjs";
const regression = "scripts/test-recommendation-selector.mjs";
const failure = "> node scripts/test-recommendation-selector.mjs\nAssertionError [ERR_ASSERTION]: missing eligible product\n";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

for (const tamper of [false, true]) test(`controller escalation uses fresh candidate and respects boundaries (tamper=${tamper})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "model-repair-"));
  try {
    const origin = join(root, "origin");
    const baseDir = join(root, "attempts");
    await mkdir(origin); await mkdir(baseDir);
    git(origin, "init", "-q", "-b", "main");
    git(origin, "config", "user.email", "test@example.com");
    git(origin, "config", "user.name", "Test");
    for (const [path, value] of Object.entries({
      [engine]: "export const eligible = false;\n",
      [regression]: "// protected existing test\n",
      "config/engine-calibration.json": JSON.stringify({ sha256: "a".repeat(64), sourceRevision: "protected" }),
      "package.json": JSON.stringify({ scripts: { "verify:publication": "npm test && npm audit --omit=dev --audit-level=high" } }),
      "demo/amazon-products.mjs": "old supplier",
      "public/data/catalog-current.json": "old snapshot",
      "public/data/catalog-manifest.json": "old manifest"
    })) {
      await mkdir(dirname(join(origin, path)), { recursive: true });
      await writeFile(join(origin, path), value);
    }
    git(origin, "add", "."); git(origin, "commit", "-qm", "fixture");
    const source = join(baseDir, "attempt-source");
    git(root, "clone", "-q", origin, source);
    await writeFile(join(source, "demo/amazon-products.mjs"), "original candidate");
    const calls = [];
    const workspaces = [];
    const auditStop = new Error("stop_at_audit_before_publication");
    await assert.rejects(runEngineAutoRepair({
      id: "es", site: { id: "es", data: "/data/" },
      config: { repository: "fixture/site", demo: "demo/amazon-products.mjs", build: "build:catalog" },
      baseDir, source, report: { category: "engine_behavior", invariant: "recommendation-selector" },
      assertRepository() {}, sandboxArgs() { return []; },
      onPullRequest() { assert.fail("must not publish"); },
      onMerged() { assert.fail("must not merge"); },
      async runCommand({ cwd, program, args, logPath }) {
        if (program === "git") {
          assert.equal(args[0], "clone");
          git(cwd, "clone", "-q", origin, args.at(-1));
        } else if (program === "codex") {
          calls.push(args[args.indexOf("--model") + 1] + ":" + args.find(v => v.startsWith("model_reasoning_effort=")));
          workspaces.push(cwd);
          assert.equal(await readFile(join(cwd, engine), "utf8"), "export const eligible = false;\n");
          assert.equal(await readFile(join(cwd, "demo/amazon-products.mjs"), "utf8"), "original candidate");
          await writeFile(join(cwd, engine), "export const eligible = true;\n");
          await writeFile(join(cwd, regression), "// protected existing test\n// appended regression\n");
          if (tamper) await writeFile(join(cwd, "demo/amazon-products.mjs"), "tampered");
        } else if (program === "bwrap" && logPath.endsWith(".reproduction.log")) {
          await writeFile(logPath, failure); throw new Error("reproduced");
        } else if (program === "bwrap" && logPath.endsWith(".validation.log") && calls.length === 1) {
          await writeFile(logPath, failure); throw new Error("medium_failed");
        } else if (program === "npm" && args[0] === "audit") {
          throw auditStop;
        }
      }
    }), error => tamper ? /agent_changed_catalog_data/.test(error.message) : error === auditStop);
    assert.deepEqual(calls, tamper ? ['gpt-6.1-sol:model_reasoning_effort="medium"'] :
      ['gpt-6.1-sol:model_reasoning_effort="medium"', 'gpt-6.1-sol:model_reasoning_effort="high"']);
    assert.equal(new Set(workspaces).size, calls.length);
    assert.equal(await readFile(join(source, "demo/amazon-products.mjs"), "utf8"), "original candidate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
