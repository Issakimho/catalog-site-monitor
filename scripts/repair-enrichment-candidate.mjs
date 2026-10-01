// Invoked only by the serialized private enrichment controller after a failed
// publication gate. Supplier collection and review decisions are never rerun.
import assert from "node:assert/strict";
import { readFile, writeFile, rename, realpath } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { sites } from "../config/sites.mjs";
import { command, assertRepository, verifyCandidateBrowser, verifyProduction } from "./local-recovery.mjs";
import { mayAttemptRepair, parseEngineFailure, repairFingerprint } from "./engine-repair-policy.mjs";
import { runEngineAutoRepair, resumeEngineAutoRepair } from "./engine-auto-repair.mjs";

export async function repairEnrichmentCandidate(id, source) {
  const settings = JSON.parse(await readFile(join(homedir(), ".codex/catalog-autonomy/sites.json"), "utf8"));
  const site = sites.find(site => site.id === id && site.id !== "fr");
  const config = settings.sites[id];
  assert.ok(site && config, "unsupported_enrichment_site");
  assert.equal(await realpath(process.cwd()), await realpath(config.root), "wrong_scheduler_project");
  assertRepository(config.root, config.repository);
  const baseDir = await realpath(join(settings.stateRoot, `enrichment-${id}`));
  source = await realpath(source);
  assert.ok(source.startsWith(`${baseDir}/attempt-`), "untrusted_enrichment_candidate");
  assertRepository(source, config.repository);
  const report = parseEngineFailure(await readFile(`${source}.publication-failure.log`, "utf8"));
  assert.ok(report, "not_an_engine_failure");
  const statePath = join(baseDir, "engine-repair.json");
  let state = {};
  try { state = JSON.parse(await readFile(statePath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const save = async () => {
    await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    await rename(`${statePath}.tmp`, statePath);
  };
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8", timeout: 30_000 }).trim();
  const fingerprint = repairFingerprint(config.repository, base, report);
  const onMerged = async ({ sha, workspace, prUrl }) => {
    state = { ...state, status: "pending_production", sha, workspace, prUrl }; await save();
  };
  try {
    let result;
    if (["pr_checks", "pending_production"].includes(state.status)) {
      result = await resumeEngineAutoRepair({ id, config, site, baseDir, saved: state, assertRepository, onMerged, verifyProduction });
    } else {
      assert.ok(mayAttemptRepair({ engineRepair: state }, fingerprint), "engine_repair_cooldown");
      state = { kind: "enrichment", fingerprint, base, source, invariant: report.invariant,
        startedAt: new Date().toISOString(), status: "running" }; await save();
      result = await runEngineAutoRepair({ id, config, site, baseDir, source, kind: "enrichment", report,
        assertRepository, verifyCandidateBrowser, verifyProduction, onMerged,
        runCommand: ({ cwd, program, args, logPath, env, timeout }) => command(cwd, program, args, logPath, env, timeout),
        onPullRequest: async ({ prUrl, prNumber, head, workspace }) => {
          state = { ...state, status: "pr_checks", prUrl, prNumber, head, workspace }; await save();
        }
      });
    }
    state = { ...state, status: "recovered", sha: result.sha, proof: result.proof, finishedAt: new Date().toISOString() }; await save();
    return result;
  } catch (error) {
    // A cooldown must not replace the preserved PR or candidate identity.
    if (error.message !== "engine_repair_cooldown") {
      const code = /^[a-z_]+$/.test(error.message) ? error.message : "validation_failed";
      state = { ...state, status: state.sha ? "pending_production" : code === "repair_ci_timeout" ? "pr_checks" : "needs_attention", code }; await save();
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await repairEnrichmentCandidate(process.argv[2], process.argv[3]))); }
  catch (error) { console.error(JSON.stringify({ status: "failed", code: /^[a-z_]+$/.test(error.message) ? error.message : "validation_failed" })); process.exitCode = 1; }
}
