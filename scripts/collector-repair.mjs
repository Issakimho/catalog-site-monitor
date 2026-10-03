// Trusted, bounded recipes for collector defects. Supplier/authentication errors
// must never become permission to rewrite code or change market configuration.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { repairSandboxArgs } from "./repair-sandbox.mjs";
import { finishEngineRepair, assertRepairPullRequest } from "./engine-auto-repair.mjs";

export const COLLECTOR_REPAIR_VERSION = "entrypoint-v1";
const REGRESSION = "scripts/test-catalog-autonomy.mjs";
const MARKETS = { de: "de-DE", es: "es-ES", it: "it-IT", us: "en-US" };
const EVIDENCE_ERRORS = new Set(["collection_report_missing", "collection_report_not_current", "collection_output_unchanged"]);
const git = (work, ...args) => execFileSync("git", args, { cwd: work, encoding: "utf8", timeout: 90000 }).trim();
const gh = (work, args) => execFileSync("gh", args, { cwd: work, encoding: "utf8", timeout: 45000 }).trim();

export function collectorRecipe(id, source, script) {
  if (!Object.hasOwn(MARKETS, id)) return null;
  const file = `scripts/fetch-amazon-${id}-catalog.mjs`;
  if (script !== `node ${file}`) return null;
  // Match the entire launcher, not a substring in arbitrary supplier/code text.
  const original = `process.env.AMAZON_ENV_PATH ??= ".env.amazon.${id}.local";\n` +
    `process.env.AMAZON_CATALOG_LOCALE ??= "${MARKETS[id]}";\n\nawait import("./fetch-amazon-catalog.mjs");\n`;
  if (source !== original) return null;
  const replacement = original.replace('await import("./fetch-amazon-catalog.mjs");',
    'const { main } = await import("./fetch-amazon-catalog.mjs");\nawait main();');
  return { version: COLLECTOR_REPAIR_VERSION, file, original, replacement, regression: REGRESSION };
}

export function mayRepairCollector({ step, code, beforeHash, afterHash, previous, base, now = Date.now() }) {
  return step === "collection_evidence" && EVIDENCE_ERRORS.has(code) && beforeHash === afterHash &&
    !(previous?.base === base && now - Date.parse(previous.startedAt) < 24 * 3600000);
}

// Runs the actual CLI with an empty cwd and no credentials. The broken wrapper
// exits zero; the corrected wrapper must enter main and reject missing config.
export function entrypointProbe(file, mode) {
  assert.match(file, /^scripts\/fetch-amazon-(de|es|it|us)-catalog\.mjs$/);
  assert.ok(["broken", "fixed"].includes(mode));
  return `
const { spawnSync } = await import("node:child_process");
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { resolve, join } = await import("node:path");
const assert = (await import("node:assert/strict")).default;
const file = resolve(${JSON.stringify(file)});
const cwd = mkdtempSync(join(tmpdir(), "collector-entrypoint-"));
try {
  const result = spawnSync(process.execPath, [file], { cwd, encoding: "utf8", timeout: 10000,
    env: { PATH: process.env.PATH, AMAZON_ENV_PATH: join(cwd, "absent.env") } });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, ${mode === "broken" ? 0 : 1}, "collector_entrypoint_exit");
  ${mode === "broken" ? 'assert.equal(result.stdout, ""); assert.equal(result.stderr, "");' : 'assert.match(result.stderr, /Amazon-Konfiguration unvollständig|Missing Amazon|configuration.*Amazon|Amazon.*configuration|Amazon.*configur/i);'}
} finally { rmSync(cwd, { recursive: true, force: true }); }
`;
}

export function collectorRegression(recipe) {
  return `\n// ${COLLECTOR_REPAIR_VERSION}: the public collector must execute main.\n{\n${entrypointProbe(recipe.file, "fixed")}\n}\n`;
}

export function publicationRunsCollectorTest(scripts, name = "verify:publication", seen = new Set()) {
  if (seen.has(name) || typeof scripts?.[name] !== "string") return false;
  seen.add(name);
  return /(?:^|&&)\s*node scripts\/test-catalog-autonomy\.mjs\s*(?:&&|$)/.test(scripts[name]) ||
    [...scripts[name].matchAll(/(?:^|&&)\s*npm (?:run )?([a-z:-]+)(?=\s*(?:&&|$))/g)]
      .some(([, child]) => publicationRunsCollectorTest(scripts, child, seen));
}

export async function repairCollectorLauncher({ work, id, run, onStart, sandbox = repairSandboxArgs }) {
  const file = `scripts/fetch-amazon-${id}-catalog.mjs`;
  let source;
  try { source = await readFile(join(work, file), "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  const manifest = JSON.parse(await readFile(join(work, "package.json"), "utf8"));
  const recipe = collectorRecipe(id, source, manifest.scripts?.["fetch:amazon-catalog"]);
  if (!recipe) return null;
  for (const path of [recipe.file, recipe.regression]) assert.ok((await lstat(join(work, path))).isFile(), "non_regular_collector_file");
  const test = await readFile(join(work, recipe.regression), "utf8");
  const probe = async mode => run("bwrap", [...sandbox(work), "node", "--input-type=module", "-e", entrypointProbe(file, mode)]);
  await onStart(); // Persist the budget before any repair attempt.
  await probe("broken");
  await writeFile(join(work, file), recipe.replacement);
  await writeFile(join(work, recipe.regression), test + collectorRegression(recipe));
  try {
    await probe("fixed");
    // Preserve all existing tests; this also proves the new assertion runs in CI.
    assert.ok(publicationRunsCollectorTest(manifest.scripts), "collector_regression_not_in_ci");
    await run("bwrap", [...sandbox(work), "node", recipe.regression]);
  } catch (error) {
    await writeFile(join(work, file), source);
    await writeFile(join(work, recipe.regression), test);
    throw error;
  }
  return recipe;
}

export async function assertCollectorPatch(work, id, base, dataPaths, head = "HEAD") {
  const file = `scripts/fetch-amazon-${id}-catalog.mjs`;
  const original = execFileSync("git", ["show", `${base}:${file}`], { cwd: work, encoding: "utf8" });
  const manifest = JSON.parse(git(work, "show", `${base}:package.json`));
  const recipe = collectorRecipe(id, original, manifest.scripts?.["fetch:amazon-catalog"]);
  assert.ok(recipe, "unrecognized_collector_base");
  for (const path of [file, REGRESSION, ...dataPaths]) assert.ok((await lstat(join(work, path))).isFile(), "non_regular_collector_file");
  assert.equal(await readFile(join(work, file), "utf8"), recipe.replacement, "collector_patch_changed");
  const originalTest = execFileSync("git", ["show", `${base}:${REGRESSION}`], { cwd: work, encoding: "utf8" });
  assert.equal(await readFile(join(work, REGRESSION), "utf8"), originalTest + collectorRegression(recipe), "collector_tests_changed");
  const changed = git(work, "diff", "--name-only", base, ...(head === "HEAD" ? [] : [head])).split("\n").filter(Boolean);
  const allowed = [...dataPaths, file, REGRESSION];
  assert.ok(changed.includes(file) && changed.includes(REGRESSION), "collector_patch_missing");
  assert.ok(changed.every(path => allowed.includes(path)), "collector_patch_out_of_scope");
  for (const line of git(work, "diff", "--raw", "--no-abbrev", base, ...(head === "HEAD" ? [] : [head])).split("\n").filter(Boolean)) {
    assert.match(line, /^:100644 100644 [a-f0-9]{40} [a-f0-9]{40} M\t/, "collector_file_mode_changed");
  }
  assert.equal(git(work, "ls-files", "--others", "--exclude-standard"), "", "collector_untracked_files");
  git(work, "diff", "--check", base);
  return [file, REGRESSION];
}

export async function publishCollectorRepair({ work, id, base, config, site, onPullRequest, onMerged, verifyProduction }) {
  const head = git(work, "rev-parse", "HEAD");
  const branch = `codex/collector-repair-${id}-${head.slice(0, 12)}`;
  // Save the branch/head before pushing so an interrupted PR creation can be resumed.
  await onPullRequest({ status: "publishing", head, base, branch, workspace: work });
  return resumeCollectorPublication({ work, id, base, head, branch, config, site, onPullRequest, onMerged, verifyProduction });
}

export async function resumeCollectorPublication({ work, id, base, head, branch, config, site, onPullRequest, onMerged, verifyProduction }) {
  assert.equal(branch, `codex/collector-repair-${id}-${head.slice(0, 12)}`, "foreign_collector_branch");
  assert.match(head, /^[a-f0-9]{40}$/);
  assert.match(base, /^[a-f0-9]{40}$/);
  const pulls = JSON.parse(gh(work, ["api", `repos/${config.repository}/pulls?state=all&head=${config.repository.split('/')[0]}:${branch}`]));
  assert.ok(pulls.length <= 1, "ambiguous_collector_pr");
  const existing = pulls.length ? JSON.parse(gh(work, ["api", `repos/${config.repository}/pulls/${pulls[0].number}`])) : null;
  if (existing) assertRepairPullRequest(existing, { head, base, allowMerged: true });
  const checkout = git(work, "rev-parse", "HEAD");
  assert.ok(checkout === head || (existing?.merged && checkout === existing.merge_commit_sha), "collector_head_changed");
  assert.equal(git(work, "rev-parse", `${head}^`), base, "collector_base_changed");
  assert.equal(git(work, "status", "--porcelain"), "", "collector_dirty_resume");
  const dataPaths = [config.demo, `public${site.data}catalog-current.json`, `public${site.data}catalog-manifest.json`];
  await assertCollectorPatch(work, id, base, dataPaths, head);
  const remote = git(work, "ls-remote", "--heads", "origin", `refs/heads/${branch}`).split(/\s/)[0];
  assert.ok(!remote || remote === head, "collector_remote_head_changed");
  if (!remote && !pulls.length) git(work, "push", "origin", `${head}:refs/heads/${branch}`);
  let url = pulls[0]?.html_url;
  if (!url) {
    const bodyPath = `${work}.collector-pr.md`;
    await writeFile(bodyPath, "The collector launcher returned success without acquiring data. The controller reproduced the no-op without credentials, applied its exact entrypoint recipe and appended a CLI regression. A real supplier collection, publication tests and current/+12h browser checks passed before this PR. Supplier dates and market settings are unchanged.\n");
    url = gh(work, ["pr", "create", "--repo", config.repository, "--base", "main", "--head", branch,
      "--title", `fix(catalog): repair ${id.toUpperCase()} collector entrypoint`, "--body-file", bodyPath]);
  }
  const prefix = `https://github.com/${config.repository}/pull/`;
  assert.ok(url.startsWith(prefix) && /^\d+$/.test(url.slice(prefix.length)), "collector_pr_not_confirmed");
  const prNumber = Number(url.slice(prefix.length));
  await onPullRequest({ status: "pr_checks", head, base, branch, workspace: work, prUrl: url, prNumber });
  return finishEngineRepair({ id, config, site, work, base, head, prUrl: url, prNumber, onMerged, verifyProduction,
    commitTitle: `fix(catalog): repair ${id.toUpperCase()} collector entrypoint` });
}
