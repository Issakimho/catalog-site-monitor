// Runs only after a candidate failed a known selector invariant. Codex writes a
// patch in a disposable checkout; this controller owns Git, CI and deployment.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectSnapshot } from "./check.mjs";
import { repairCodexConfig, repairSandboxArgs } from "./repair-sandbox.mjs";
import {
  assertRepairChanges,
  repairPrompt
} from "./engine-repair-policy.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync("git", args, {
  cwd, encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
}).trim();
const gh = (args, cwd) => execFileSync("gh", args, {
  cwd, encoding: "utf8", timeout: 45_000, stdio: ["ignore", "pipe", "pipe"]
}).trim();
const ghJson = (path, cwd) => JSON.parse(gh(["api", path], cwd));

function repairEnvironment(env) {
  const allowed = ["PATH", "HOME", "CODEX_HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "SSL_CERT_FILE", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
  return { ...Object.fromEntries(allowed.filter(key => env[key]).map(key => [key, env[key]])), GIT_TERMINAL_PROMPT: "0" };
}

function candidatePaths(config, site) {
  return [config.demo, `public${site.data}catalog-current.json`, `public${site.data}catalog-manifest.json`];
}

async function hashFiles(root, files) {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(await readFile(join(root, file))).update("\0");
  return hash.digest("hex");
}

function changedPaths(work) {
  return [...new Set([
    ...git(work, "diff", "--name-only", "HEAD").split("\n"),
    ...git(work, "ls-files", "--others", "--exclude-standard").split("\n")
  ].filter(Boolean))];
}

function assertBoundedDiff(work, codePaths) {
  const numstat = git(work, "diff", "--numstat", "HEAD", "--", ...codePaths);
  let changedLines = 0;
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [added, removed] = line.split("\t");
    assert.ok(/^\d+$/.test(added) && /^\d+$/.test(removed), "binary_repair_diff");
    changedLines += Number(added) + Number(removed);
  }
  assert.ok(changedLines > 0 && changedLines <= 250, "repair_diff_too_large");
  git(work, "diff", "--check");
}

function assertPatch(work, expectedDataPaths, site) {
  const changed = changedPaths(work);
  const codePaths = changed.filter(path => !expectedDataPaths.includes(path));
  assertRepairChanges(codePaths, { site });
  assertBoundedDiff(work, codePaths);
  return { changed, codePaths };
}

async function assertRegularFiles(root, paths) {
  for (const path of paths) assert.ok((await lstat(join(root, path))).isFile(), "non_regular_repair_file");
}

function validatedPullRequest(checks, runs) {
  const ci = runs.filter(run => run.path === ".github/workflows/ci.yml" && run.event === "pull_request");
  if (ci.some(run => run.status === "completed" && run.conclusion !== "success")) throw new Error("repair_ci_failed");
  if (checks.some(check => check.status === "completed" && !["success", "skipped", "neutral"].includes(check.conclusion))) {
    throw new Error("repair_check_failed");
  }
  return ci.some(run => run.status === "completed" && run.conclusion === "success") &&
    checks.length > 0 && checks.every(check => check.status === "completed");
}

function publicationPlan(manifest) {
  const script = manifest.scripts?.["verify:publication"];
  const suffix = " && npm audit --omit=dev --audit-level=high";
  if (typeof script === "string" && script.endsWith(suffix)) {
    return { offline: script.slice(0, -suffix.length), audit: ["audit", "--omit=dev", "--audit-level=high"] };
  }
  if (script === "npm run quality && npm run audit:dependencies") {
    const audit = manifest.scripts["audit:dependencies"];
    if (audit === "npm audit --omit=dev --audit-level=high") {
      return { offline: "npm run quality", audit: ["audit", "--omit=dev", "--audit-level=high"] };
    }
    if (audit === "npm audit --audit-level=high") {
      return { offline: "npm run quality", audit: ["audit", "--audit-level=high"] };
    }
  }
  throw new Error("unknown_publication_gate");
}

async function waitForPullRequestChecks(repository, sha, work, { attempts = 80, pauseMs = 15_000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const checks = ghJson(`repos/${repository}/commits/${sha}/check-runs?per_page=100`, work).check_runs;
    const runs = ghJson(`repos/${repository}/actions/runs?head_sha=${sha}&event=pull_request&per_page=100`, work).workflow_runs;
    if (validatedPullRequest(checks, runs)) return;
    if (attempt + 1 < attempts) await pause(pauseMs);
  }
  throw new Error("repair_ci_timeout");
}

async function runEngineAutoRepair({ id, report, config, site, baseDir, source, runCommand, assertRepository, onPullRequest, onMerged, verifyCandidateBrowser, verifyProduction }) {
  assert.ok(id === site.id && /^[a-z]{2}$/.test(id), "wrong_repair_site");
  assert.ok(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository), "wrong_repair_repository");
  const sourceRoot = await realpath(source);
  assert.ok(sourceRoot.startsWith(`${await realpath(baseDir)}/attempt-`), "untrusted_repair_candidate");
  assertRepository(sourceRoot, config.repository);
  const dataPaths = candidatePaths(config, site);
  const sourceChanges = changedPaths(sourceRoot);
  assert.ok(sourceChanges.length > 0 && sourceChanges.every(path => dataPaths.includes(path)), "untrusted_repair_candidate_diff");
  await assertRegularFiles(sourceRoot, dataPaths);
  const base = git(sourceRoot, "rev-parse", "HEAD");
  const work = join(baseDir, `attempt-${Date.now()}-engine`);
  const logPath = `${work}.log`;
  const environment = repairEnvironment(process.env);
  const run = (cwd, program, args, timeout = 1_200_000) => runCommand({ cwd, program, args, logPath, env: environment, timeout });
  await mkdir(baseDir, { recursive: true, mode: 0o700 });
  await run(baseDir, "git", ["clone", "--quiet", "--single-branch", "--branch", "main", `https://github.com/${config.repository}.git`, work], 180_000);
  assertRepository(work, config.repository);
  assert.equal(git(work, "rev-parse", "HEAD"), base, "repair_base_advanced");
  assert.equal(git(work, "status", "--porcelain=v1", "--untracked-files=all"), "", "dirty_repair_checkout");
  const branch = `codex/engine-repair-${id}-${Date.now().toString(36)}`;
  git(work, "checkout", "-b", branch);
  for (const file of dataPaths) await copyFile(join(sourceRoot, file), join(work, file));
  const originalCandidateHash = await hashFiles(work, dataPaths);
  await run(work, "npm", ["ci", "--ignore-scripts"]);
  await run(work, "codex", [
    "--ask-for-approval", "never", "exec", "--ephemeral", "--ignore-user-config",
    ...repairCodexConfig(dataPaths), "-C", work,
    repairPrompt({ site: id, report })
  ], 2_400_000);
  assert.equal(git(work, "rev-parse", "HEAD"), base, "agent_changed_git_history");
  assert.equal(git(work, "diff", "--cached", "--name-only"), "", "agent_staged_changes");
  assert.equal(await hashFiles(work, dataPaths), originalCandidateHash, "agent_changed_catalog_data");
  const { codePaths } = assertPatch(work, dataPaths, id);
  await assertRegularFiles(work, [...dataPaths, ...codePaths]);
  for (const path of codePaths) git(work, "ls-files", "--error-unmatch", "--", path);
  // Discard ignored build output from the coding session and reinstall the
  // pinned dependencies before executing any generated patch.
  git(work, "clean", "-fdX");
  await run(work, "npm", ["ci", "--ignore-scripts"]);
  await run(work, "bwrap", [...repairSandboxArgs(work), "npm", "run", config.build]);
  const plan = publicationPlan(JSON.parse(await readFile(join(work, "package.json"), "utf8")));
  await run(work, "bwrap", [...repairSandboxArgs(work), "sh", "-c", plan.offline]);
  await run(work, "npm", plan.audit);
  const snapshot = await readFile(join(work, `public${site.data}catalog-current.json`));
  const manifest = await readFile(join(work, `public${site.data}catalog-manifest.json`));
  assert.equal(inspectSnapshot(snapshot, manifest, site).status, "healthy", "repair_candidate_not_fresh");
  await verifyCandidateBrowser(work, site, { sandboxedPreview: true });
  const finalPatch = assertPatch(work, dataPaths, id);
  assert.deepEqual(finalPatch.codePaths, codePaths, "repair_code_changed_during_validation");
  await assertRegularFiles(work, [...dataPaths, ...codePaths]);
  git(work, "fetch", "--no-tags", "origin", "main");
  assert.equal(git(work, "rev-parse", "origin/main"), base, "repair_base_advanced");
  git(work, "add", "--", ...finalPatch.changed);
  assert.deepEqual(git(work, "diff", "--cached", "--name-only").split("\n").filter(Boolean).sort(), [...finalPatch.changed].sort(), "repair_staging_mismatch");
  git(work, "commit", "-m", `fix(recommendations): repair ${id.toUpperCase()} selector invariant`);
  const head = git(work, "rev-parse", "HEAD");
  assert.equal(git(work, "status", "--porcelain=v1", "--untracked-files=all"), "", "dirty_repair_commit");
  await run(work, "git", ["push", "origin", `${head}:refs/heads/${branch}`], 180_000);
  const bodyPath = `${work}.pr.md`;
  await writeFile(bodyPath, [
    `The ${id.toUpperCase()} catalog failed the blocking ${report.invariant} selector invariant.`,
    `This patch repairs the selector, adds a regression test, and publishes the verified candidate collected by the Raspberry.`,
    "", "Validation: npm run verify:publication; local current and 12-hour browser journeys.",
    "Automated scope: selector source, selector regression test, calibration digest, and the three collector-produced catalog artifacts."
  ].join("\n") + "\n", { mode: 0o600 });
  const prUrl = gh(["pr", "create", "--repo", config.repository, "--base", "main", "--head", branch,
    "--title", `fix(recommendations): recover ${id.toUpperCase()} catalog`, "--body-file", bodyPath], work);
  const prAddress = new URL(prUrl);
  assert.equal(prAddress.origin, "https://github.com", "repair_pr_not_confirmed");
  const [owner, repo, kind, number, extra] = prAddress.pathname.split("/").filter(Boolean);
  assert.equal(`${owner}/${repo}`, config.repository, "repair_pr_not_confirmed");
  assert.ok(kind === "pull" && /^\d+$/.test(number) && !extra && !prAddress.search && !prAddress.hash,
    "repair_pr_not_confirmed");
  const prNumber = Number(number);
  await onPullRequest({ prUrl, prNumber, head, workspace: work });
  await waitForPullRequestChecks(config.repository, head, work);
  git(work, "fetch", "--no-tags", "origin", "main");
  assert.equal(git(work, "rev-parse", "origin/main"), base, "repair_base_advanced");
  assert.equal(inspectSnapshot(await readFile(join(work, `public${site.data}catalog-current.json`)),
    await readFile(join(work, `public${site.data}catalog-manifest.json`)), site).status, "healthy", "repair_candidate_expired");
  const pr = ghJson(`repos/${config.repository}/pulls/${prNumber}`, work);
  assert.equal(pr.state, "open", "repair_pr_not_open");
  assert.equal(pr.head.sha, head, "repair_pr_head_changed");
  assert.equal(pr.base.sha, base, "repair_pr_base_changed");
  const merged = JSON.parse(gh(["api", `repos/${config.repository}/pulls/${prNumber}/merge`, "--method", "PUT",
    "-f", "merge_method=squash", "-f", `commit_title=fix(recommendations): recover ${id.toUpperCase()} catalog`], work));
  assert.equal(merged.merged, true, "repair_merge_failed");
  const sha = merged.sha;
  assert.match(sha, /^[a-f0-9]{40}$/);
  git(work, "fetch", "--no-tags", "origin", "main");
  assert.equal(git(work, "rev-parse", "origin/main"), sha, "repair_merge_not_on_main");
  git(work, "checkout", "--detach", sha);
  await onMerged({ sha, workspace: work, prUrl });
  let proof;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { proof = await verifyProduction(config, site, sha, work); break; }
    catch { if (attempt === 39) throw new Error("production_verification_failed"); await pause(15_000); }
  }
  return { status: "recovered", sha, workspace: work, prUrl, proof };
}

export { assertBoundedDiff, candidatePaths, publicationPlan, repairEnvironment, runEngineAutoRepair, validatedPullRequest };
