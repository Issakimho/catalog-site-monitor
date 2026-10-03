// Local-only recovery worker. Private configuration and credentials never enter this repository.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, realpath, rename, open, access, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { sites } from "../config/sites.mjs";
import { fetchBytes, inspectSnapshot, checkSite, browserEnvironment, browserLaunchOptions } from "./check.mjs";
import { mayAttemptRepair, parseEngineFailure, repairFingerprint, REPAIR_POLICY_VERSION } from "./engine-repair-policy.mjs";
import { runEngineAutoRepair, resumeEngineAutoRepair } from "./engine-auto-repair.mjs";
import { repairSandboxArgs } from "./repair-sandbox.mjs";
import { mayRepairCollector, repairCollectorLauncher, assertCollectorPatch, publishCollectorRepair, resumeCollectorPublication } from "./collector-repair.mjs";

import { observeCollection, recordWorkflowFailure, recordVerifiedWorkflow, sourceHealthSummary, validateCollection } from "./source-health.mjs";

async function observeWork(state, work, config, id, verifiedSha) {
  const reportPath = join(work, "exports/audits/amazon-collection-health.json");
  let report;
  if (await exists(reportPath)) report = await json(reportPath);
  else {
    const demo = await import(pathToFileURL(join(work, config.demo)).href);
    report = demo.amazonDemoProductStats?.collectionHealth;
  }
  return report ? observeCollection(state, report, id, { verifiedSha }) : state;
}

const HOUR = 3_600_000;
const pause = ms => new Promise(r => setTimeout(r, ms));
const json = async path => JSON.parse(await readFile(path, "utf8"));
const save = async (path, value) => { await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await rename(`${path}.tmp`, path); };
const exists = async path => { try { await access(path); return true; } catch { return false; } };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
const gh = path => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", timeout: 45_000, stdio: ["ignore", "pipe", "pipe"] }));

export function assertCollectionEvidence(report, market, startedAt, beforeHash, afterHash) {
  assert.ok(report, "collection_report_missing");
  validateCollection(report, market);
  assert.ok(Date.parse(report.observedAt) >= startedAt - 1000, "collection_report_not_current");
  assert.notEqual(afterHash, beforeHash, "collection_output_unchanged");
}

export function decideRecovery(health, state = {}, now = Date.now()) {
  if (state.pendingSha) return "verify_pending";
  if (["publishing", "pr_checks"].includes(state.collectorRepair?.status) && state.collectorRepair.workspace) return "resume_collector_pr";
  if (state.engineRepair?.status === "pr_checks" && state.engineRepair.prNumber && state.engineRepair.workspace) return "resume_engine_pr";
  const attempts = (state.attempts ?? []).filter(t => now - t < 24 * HOUR);
  if (health.status === "healthy" && health.ageHours < 12 && !state.lastFailure && !sourceHealthSummary(state, now).unresolvedQueries && !sourceHealthSummary(state, now).workflowFailure) return "healthy";
  if (attempts.length >= 2) return "retry_limit";
  if (attempts.some(t => now - t < 2 * HOUR)) return "cooldown";
  return "refresh";
}

export function canResumeCandidate(state, now = Date.now(), { newCodeRevision = false, newRepairPolicy = false } = {}) {
  if (state.pendingSha || !state.lastWorkspace || !state.lastFailure) return false;
  if (state.lastFailure.step === "engine_repair") return newCodeRevision || newRepairPolicy;
  if (!/^(run (build[:a-z-]*|verify:publication)|candidate_integrity|candidate_browser)$/.test(state.lastFailure.step ?? "")) return false;
  if (newCodeRevision || newRepairPolicy) return true;
  const attempts = (state.resumeAttempts ?? []).filter(t => now - t < 24 * HOUR);
  return attempts.length < 2 && !attempts.some(t => now - t < 30 * 60_000);
}

export function assertChangedFiles(changed, allowed) {
  assert.ok(changed.every(file => allowed.includes(file)), "unexpected_changed_files");
}

export function pendingDisposition(pendingSha, remoteSha, isAncestor) {
  if (pendingSha === remoteSha) return "verify";
  return isAncestor ? "pending_superseded" : "push_not_published";
}

export function hasTerminalCheckFailure(checks) {
  return checks.length > 0
    && checks.every(check => check.status === "completed")
    && checks.some(check => !["success", "skipped", "neutral"].includes(check.conclusion));
}

export function assertRepository(cwd, repository) {
  const allowed = [`https://github.com/${repository}.git`, `https://github.com/${repository}`, `git@github.com:${repository}.git`];
  for (const args of [["--all"], ["--push", "--all"]]) {
    assert.ok(git(cwd, "remote", "get-url", ...args, "origin").split("\n").every(url => allowed.includes(url)), "unexpected_repository");
  }
}

async function browserHealth(site) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch(browserLaunchOptions());
  try { return await checkSite(site, browser); } finally { await browser.close(); }
}

async function publicHealth(site) {
  const [snapshot, manifest] = await Promise.all([fetchBytes(`${site.origin}${site.data}catalog-current.json`), fetchBytes(`${site.origin}${site.data}catalog-manifest.json`)]);
  return inspectSnapshot(snapshot, manifest, site);
}

export function collectionEnvironment(env, creds, credentialsPath, complete = false) {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("AMAZON_") && !/OPENAI|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key))),
    AMAZON_ENV_PATH: credentialsPath, AMAZON_CREATORS_APPLICATION_ID: creds.applicationId, AMAZON_CREATORS_CREDENTIAL_ID: creds.credentialId,
    AMAZON_CREATORS_SECRET: creds.secret, AMAZON_CREATORS_VERSION: creds.version, AMAZON_ASSOCIATE_TAG: creds.associateTag, AMAZON_MARKETPLACE: creds.marketplace,
    GIT_TERMINAL_PROMPT: "0", ...(complete ? { AMAZON_QUERY_BATCH_SIZE: "0" } : {}) };
}

export async function command(cwd, executable, args, logPath, env = process.env, timeout = 1_200_000, lockPath) {
  const log = await open(logPath, "a", 0o600);
  return new Promise((done, fail) => {
    const child = spawn(executable, args, { cwd, env, stdio: ["ignore", log.fd, log.fd], detached: true });
    const registered = lockPath ? json(lockPath).then(lock => save(lockPath, { ...lock, childPid: child.pid })) : Promise.resolve();
    let killer, finished = false;
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      killer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 5000);
    }, timeout);
    const finish = async code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(killer); await log.close();
      await registered;
      if (lockPath) await save(lockPath, { ...await json(lockPath), childPid: null });
      code === 0 ? done() : fail(new Error("command_failed"));
    };
    child.once("error", () => finish(1).catch(fail));
    child.once("exit", code => finish(code).catch(fail));
  });
}

export async function verifyProduction(config, site, sha, work) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  const checks = gh(`repos/${config.repository}/commits/${sha}/check-runs`).check_runs;
  const status = gh(`repos/${config.repository}/commits/${sha}/status`);
  assert.ok(checks.length > 0 && checks.every(r => r.status === "completed" && ["success", "skipped", "neutral"].includes(r.conclusion)), "ci_pending_or_failed");
  assert.ok(status.statuses.some(s => s.context === "Vercel" && s.state === "success"), "deployment_pending_or_failed");
  for (const name of ["catalog-current.json", "catalog-manifest.json"]) {
    assert.deepEqual(await fetchBytes(`${site.origin}${site.data}${name}`), await readFile(join(work, "public", site.data, name)), "live_snapshot_mismatch");
  }
  const health = await browserHealth(site);
  assert.equal(health.status, "healthy", "live_browser_or_forecast_failed");
  return { sha, products: health.products, current: health.probes.filter(p => p.forecastHours === 0).map(p => p.cards), forecast: health.probes.filter(p => p.forecastHours === 12).map(p => p.cards) };
}

export async function verifyCandidateBrowser(work, site, { sandboxedPreview = false } = {}) {
  const reservation = createServer();
  await new Promise(r => reservation.listen(0, "127.0.0.1", r));
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const preview = spawn(sandboxedPreview ? "bwrap" : "npm",
    [...(sandboxedPreview ? repairSandboxArgs(work, { network: true }) : []),
      ...(sandboxedPreview ? ["npm"] : []), "run", "preview", "--", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: work, env: browserEnvironment(), stdio: "ignore", detached: true
  });
  try {
    const local = { ...site, origin: `http://127.0.0.1:${port}` };
    for (let n = 0; n < 40; n++) {
      try { await fetch(`${local.origin}/`, { signal: AbortSignal.timeout(1000) }); break; }
      catch { if (n === 39) throw new Error("preview_unavailable"); await pause(250); }
    }
    assert.equal((await browserHealth(local)).status, "healthy", "candidate_browser_or_forecast_failed");
  } finally { try { process.kill(-preview.pid, "SIGTERM"); } catch {} }
}

export async function recordVerifiedRecovery(id, sha, work) {
  const settings = await json(join(homedir(), ".codex", "catalog-autonomy", "sites.json"));
  const config = settings.sites[id];
  const site = sites.find(s => s.id === id && s.id !== "fr");
  assert.ok(config && site);
  const baseDir = join(settings.stateRoot, id);
  assert.ok((await realpath(work)).startsWith(`${await realpath(baseDir)}/attempt-`));
  assertRepository(work, config.repository);
  assert.equal(git(work, "rev-parse", "HEAD"), sha);
  const proof = await verifyProduction(config, site, sha, work);
  const statePath = join(baseDir, "state.json");
  const state = await exists(statePath) ? await json(statePath) : {};
  await save(statePath, recordVerifiedWorkflow(await observeWork(state, work, config, id, sha), proof));
  return proof;
}

export function needsBrowserProbe(probeBrowser, incident, health) {
  return probeBrowser === true || (incident && health.status === "healthy");
}

export async function recover(id, { apply = false, force = false, probeBrowser = false, configPath } = {}) {
  const site = sites.find(s => s.id === id && s.id !== "fr");
  assert.ok(site, "unsupported_local_site");
  const settings = await json(configPath ?? join(homedir(), ".codex", "catalog-autonomy", "sites.json"));
  const config = settings.sites[id];
  assert.ok(config && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository), "invalid_local_config");
  assert.equal(await realpath(process.cwd()), await realpath(config.root), "wrong_scheduler_project");
  assertRepository(config.root, config.repository);
  const baseDir = join(settings.stateRoot, id);
  await mkdir(baseDir, { recursive: true, mode: 0o700 });
  const statePath = join(baseDir, "state.json");
  let state = await exists(statePath) ? await json(statePath) : { attempts: [] };
  let health;
  try { health = await publicHealth(site); } catch { health = { status: "critical", codes: ["public_fetch_failed"] }; }
  // The monitor's authenticated bot-created incident is only a signal; never execute its text.
  try {
    const issues = gh("repos/Issakimho/catalog-site-monitor/issues?state=open&per_page=100");
    const incident = issues.some(i => !i.pull_request && i.user?.login === "github-actions[bot]" && i.title === `[Catalogue] ${new URL(site.origin).hostname}` && i.body?.includes(`<!-- catalog-site-monitor-v1:${id} -->`));
    if (needsBrowserProbe(probeBrowser, incident, health)) health = await browserHealth(site);
  } catch { health = { ...health, status: "warning", codes: [...(health.codes ?? []), "incident_read_failed"] }; }
  // A local signal requests an independent live recheck, never a forced refresh.
  // Keep the recheck available even when the GitHub issue lookup failed.
  if (probeBrowser && health.codes?.includes("incident_read_failed")) health = await browserHealth(site);
  let decision = decideRecovery(health, state);
  // Revalidate already-collected data before spending another supplier attempt.
  // A resume never manufactures dates or bypasses publication/market checks.
  let resumeSource = null;
  let codeRevisionResumeSha = null;
  let newRepairPolicy = false;
  if (["run verify:publication", "engine_repair"].includes(state.lastFailure?.step) &&
      state.repairPolicyResumeVersion !== REPAIR_POLICY_VERSION) {
    try {
      const source = state.lastFailure?.step === "engine_repair" ? state.engineRepair?.source : state.lastWorkspace;
      newRepairPolicy = Boolean(parseEngineFailure(await readFile(`${source}.log`, "utf8")));
    } catch { /* No diagnostic means no extra retry. */ }
  }
  const savedSource = state.lastFailure?.step === "engine_repair" ? state.engineRepair?.source : state.lastWorkspace;
  if (!state.pendingSha && ["run verify:publication", "engine_repair"].includes(state.lastFailure?.step) && savedSource) {
    try {
      const source = await realpath(savedSource);
      assert.ok(source.startsWith(`${await realpath(baseDir)}/attempt-`));
      assertRepository(source, config.repository);
      const sourceBase = git(source, "rev-parse", "HEAD");
      const remoteBase = gh(`repos/${config.repository}/git/ref/heads/main`).object.sha;
      if (sourceBase !== remoteBase && state.codeRevisionResumeSha !== remoteBase) codeRevisionResumeSha = remoteBase;
    } catch { /* Normal retry limits remain in force if the revision cannot be verified. */ }
  }
  if (!["resume_engine_pr", "resume_collector_pr"].includes(decision) && !state.pendingSha && canResumeCandidate(state, Date.now(), { newCodeRevision: Boolean(codeRevisionResumeSha), newRepairPolicy })) {
    try {
      const source = await realpath(savedSource);
      assert.ok(source.startsWith(`${await realpath(baseDir)}/attempt-`));
      assertRepository(source, config.repository);
      const candidate = inspectSnapshot(await readFile(join(source, `public${site.data}catalog-current.json`)),
        await readFile(join(source, `public${site.data}catalog-manifest.json`)), site);
      if (candidate.status === "healthy" && Date.parse(candidate.generatedAt) > Date.parse(health.generatedAt ?? "1970-01-01")) {
        resumeSource = source;
        decision = "resume_candidate";
      }
    } catch { /* Unusable candidates remain archived; normal collection rules apply. */ }
  }
  if (force && !state.pendingSha && decision !== "resume_collector_pr") decision = "refresh"; // Never abandon a persisted collector PR.
  if (!apply || ["healthy", "cooldown", "retry_limit"].includes(decision)) return { site: id, decision, status: health.status, codes: health.codes, statePath, ...sourceHealthSummary(state) };

  const lockPath = join(baseDir, "lock.json");
  if (await exists(lockPath)) {
    const lock = await json(lockPath);
    assert.equal(lock.worker, "catalog-local-recovery-v1", "unknown_lock");
    assert.ok(Number.isSafeInteger(lock.pid) && lock.pid > 0, "invalid_lock");
    if (lock.childPid) {
      try { process.kill(lock.childPid, 0); throw new Error("recovery_child_still_running"); }
      catch (e) { if (e.code !== "ESRCH") throw e; }
    }
    try { process.kill(lock.pid, 0); throw new Error("recovery_already_running"); }
    catch (e) { if (e.code !== "ESRCH") throw e; }
    // Preserve the dead owner's evidence; do not remove arbitrary locks or candidates.
    await rename(lockPath, join(baseDir, `interrupted-${Date.now()}.json`));
  }
  const lock = await open(lockPath, "wx", 0o600);
  await lock.writeFile(JSON.stringify({ worker: "catalog-local-recovery-v1", pid: process.pid, startedAt: new Date().toISOString() })); await lock.close();
  let step = "start";
  const collectorCallbacks = {
    onPullRequest: async saved => {
      state.collectorRepair = { ...state.collectorRepair, ...saved };
      await save(statePath, state);
    },
    onMerged: async ({ sha, workspace, prUrl }) => {
      state.collectorRepair = { ...state.collectorRepair, status: "pending_production", sha, prUrl };
      state.pendingSha = sha; state.pendingWorkspace = workspace; state.lastWorkspace = workspace;
      await save(statePath, state);
    },
    verifyProduction
  };
  try {
    if (decision === "resume_collector_pr") {
      step = "collector_repair";
      const saved = state.collectorRepair;
      const work = await realpath(saved.workspace);
      assert.ok(work.startsWith(`${await realpath(baseDir)}/attempt-`), "untrusted_collector_workspace");
      assertRepository(work, config.repository);
      await resumeCollectorPublication({ work, id, config, site, base: saved.base, head: saved.head,
        branch: saved.branch, ...collectorCallbacks });
    }
    if (decision === "verify_pending") {
      step = "reconcile_pending";
      const work = state.pendingWorkspace;
      assert.ok((await realpath(work)).startsWith(`${await realpath(baseDir)}/attempt-`));
      assertRepository(work, config.repository);
      assert.equal(git(work, "rev-parse", "HEAD"), state.pendingSha);
      git(work, "fetch", "--no-tags", "origin", "main");
      const remoteSha = git(work, "rev-parse", "origin/main");
      let ancestor = false;
      try { git(work, "merge-base", "--is-ancestor", state.pendingSha, remoteSha); ancestor = true; }
      catch (error) { if (error.status !== 1) throw error; }
      const disposition = pendingDisposition(state.pendingSha, remoteSha, ancestor);
      if (disposition !== "verify") {
        // A rejected push or a newer publication must not pin every later run
        // to an unreachable snapshot. Preserve the clone and retry budget.
        state.lastPending = { sha: state.pendingSha, workspace: work, disposition };
        state.pendingSha = null; state.pendingWorkspace = null;
        await save(statePath, state);
        throw new Error(disposition);
      }
      const checks = gh(`repos/${config.repository}/commits/${state.pendingSha}/check-runs`).check_runs;
      if (hasTerminalCheckFailure(checks)) {
        state.lastPending = { sha: state.pendingSha, workspace: work, disposition: "ci_failed" };
        state.pendingSha = null; state.pendingWorkspace = null;
        await save(statePath, state);
        throw new Error("ci_failed");
      }
    }
    if (decision === "resume_engine_pr") {
      step = "engine_repair";
      const repair = await resumeEngineAutoRepair({ id, config, site, baseDir, saved: state.engineRepair,
        assertRepository, verifyProduction,
        onMerged: async ({ sha, workspace, prUrl }) => {
          state.pendingSha = sha; state.pendingWorkspace = workspace; state.lastWorkspace = workspace;
          state.engineRepair = { ...state.engineRepair, status: "pending_production", sha, prUrl };
          await save(statePath, state);
        }
      });
      state.engineRepair = { ...state.engineRepair, status: "recovered", sha: repair.sha };
      // The common exact-SHA production check records success below.
    }
    if (["refresh", "resume_candidate"].includes(decision)) {
      if (decision === "resume_candidate") {
        state.resumeAttempts = [...(state.resumeAttempts ?? []).filter(t => Date.now() - t < 24 * HOUR), Date.now()];
        if (codeRevisionResumeSha) state.codeRevisionResumeSha = codeRevisionResumeSha;
        if (newRepairPolicy) state.repairPolicyResumeVersion = REPAIR_POLICY_VERSION;
      }
      else state.attempts = [...(state.attempts ?? []).filter(t => Date.now() - t < 24 * HOUR), Date.now()];
      await save(statePath, state);
      const work = join(baseDir, `attempt-${Date.now()}`);
      const log = `${work}.log`;
      state.lastWorkspace = work;
      step = "clone";
      await command(baseDir, "git", ["clone", "--quiet", "--single-branch", "--branch", "main", "--reference-if-able", config.root, "--dissociate", `https://github.com/${config.repository}.git`, work], log, process.env, 180_000, lockPath);
      assertRepository(work, config.repository);
      assert.equal(git(work, "branch", "--show-current"), "main");
      assert.equal(git(work, "status", "--porcelain=v1", "--untracked-files=all"), "");
      const base = git(work, "rev-parse", "HEAD");
      let collectorPatch = null;
      const manifest = await json(join(work, "config/variant-manifest.json"));
      assert.equal(await realpath(manifest.target.root), await realpath(config.root));
      const allowed = manifest.operations.catalog.refresh.allowedChangedFiles;
      assert.deepEqual(allowed, [config.demo, `public${site.data}catalog-current.json`, `public${site.data}catalog-manifest.json`]);
      let env;
      if (decision === "resume_candidate") {
        step = "resume_source_integrity";
        assertChangedFiles([...git(resumeSource, "diff", "--name-only", "HEAD").split("\n"),
          ...git(resumeSource, "ls-files", "--others", "--exclude-standard").split("\n")].filter(Boolean), allowed);
        const sourceBase = git(resumeSource, "rev-parse", "HEAD");
        git(work, "merge-base", "--is-ancestor", sourceBase, base);
        await copyFile(join(resumeSource, config.demo), join(work, config.demo));
      } else {
        // Supplier credentials are only read when a new collection is needed.
        const { loadAmazonCredentials } = await import(pathToFileURL(join(work, "scripts/amazon-credentials.mjs")));
        const creds = await loadAmazonCredentials({ envPath: config.credentials });
        assert.equal(creds.missing.length, 0, "credentials_missing");
        assert.equal(creds.marketplace, id.toUpperCase(), "wrong_credential_market");
        assert.equal(creds.associateTag, config.tag, "wrong_affiliate_identity");
        env = collectionEnvironment(process.env, creds, config.credentials, health.status !== "healthy" || sourceHealthSummary(state).unresolvedQueries > 0);
      }
      const commands = [["ci", "--ignore-scripts"],
        ...(decision === "resume_candidate" ? [] : [["run", "check:amazon"], ["run", "fetch:amazon-catalog"]]),
        ["run", config.build], ["run", "verify:publication"]];
      for (const args of commands) {
        step = args.join(" ");
        console.log(JSON.stringify({ site: id, step, status: "running" }));
        // Only collection receives supplier credentials; validation and browser processes do not.
        const scopedEnv = args[1] === "fetch:amazon-catalog" || args[1] === "check:amazon" ? env : collectionEnvironment(process.env, {}, "");
        // Omit absent values from the non-supplier environment rather than stringifying them.
        const collectionStartedAt = Date.now();
        const beforeCollectionHash = args[1] === "fetch:amazon-catalog"
          ? createHash("sha256").update(await readFile(join(work, config.demo))).digest("hex") : null;
        try {
          await command(work, "npm", args, log, Object.fromEntries(Object.entries(scopedEnv).filter(([, value]) => value != null)), 1_200_000, lockPath);
          if (args[1] === "fetch:amazon-catalog") {
            step = "collection_evidence";
            const reportPath = join(work, "exports/audits/amazon-collection-health.json");
            const report = await exists(reportPath) ? await json(reportPath) : null;
            const afterHash = createHash("sha256").update(await readFile(join(work, config.demo))).digest("hex");
            try { assertCollectionEvidence(report, id, collectionStartedAt, beforeCollectionHash, afterHash); }
            catch (evidenceError) {
              if (!mayRepairCollector({ step, code: evidenceError.message, beforeHash: beforeCollectionHash, afterHash,
                previous: state.collectorRepair, base })) throw evidenceError;
              step = "collector_repair";
              collectorPatch = await repairCollectorLauncher({ work, id,
                run: (program, repairArgs) => command(work, program, repairArgs, log,
                  Object.fromEntries(Object.entries(collectionEnvironment(process.env, {}, "")).filter(([, value]) => value != null)), 120000, lockPath),
                onStart: async () => {
                  state.collectorRepair = { status: "repairing", base, workspace: work, startedAt: new Date().toISOString() };
                  await save(statePath, state);
                }
              });
              if (!collectorPatch) throw evidenceError;
              // The first command was proven to do nothing. This is the only real
              // supplier call in this attempt; do not add or reset retry budgets.
              step = "run fetch:amazon-catalog";
              const restartedAt = Date.now();
              await command(work, "npm", args, log, Object.fromEntries(Object.entries(scopedEnv).filter(([, value]) => value != null)), 1200000, lockPath);
              step = "collection_evidence";
              const actualReport = await exists(reportPath) ? await json(reportPath) : null;
              const actualHash = createHash("sha256").update(await readFile(join(work, config.demo))).digest("hex");
              assertCollectionEvidence(actualReport, id, restartedAt, beforeCollectionHash, actualHash);
            }
          }
        } finally {
          if (args[1] === "fetch:amazon-catalog" && await exists(join(work, "exports/audits/amazon-collection-health.json"))) {
            state = await observeWork(state, work, config, id);
            await save(statePath, state);
          }
        }
      }
      step = "candidate_integrity";
      const bytes = await readFile(join(work, `public${site.data}catalog-current.json`));
      const meta = await readFile(join(work, `public${site.data}catalog-manifest.json`));
      assert.equal(inspectSnapshot(bytes, meta, site).status, "healthy", "candidate_not_fresh");
      step = "candidate_browser";
      await verifyCandidateBrowser(work, site);
      const publicationPaths = collectorPatch
        ? [...allowed, ...await assertCollectorPatch(work, id, base, allowed)] : allowed;
      const digest = createHash("sha256");
      for (const file of publicationPaths) digest.update(await readFile(join(work, file)));
      const candidate = digest.digest("hex");
      assert.equal(git(work, "diff", "--cached", "--name-only"), "");
      assertChangedFiles([...git(work, "diff", "--name-only", "HEAD").split("\n"), ...git(work, "ls-files", "--others", "--exclude-standard").split("\n")].filter(Boolean), publicationPaths);
      assert.equal(git(work, "rev-parse", "HEAD"), base);
      git(work, "fetch", "--no-tags", "origin", "main");
      assert.equal(git(work, "rev-parse", "origin/main"), base, "remote_advanced");
      git(work, "add", "--", ...publicationPaths);
      const staged = git(work, "diff", "--cached", "--name-only").split("\n").filter(Boolean);
      assertChangedFiles(staged, publicationPaths);
      const confirmed = createHash("sha256"); for (const file of publicationPaths) confirmed.update(await readFile(join(work, file)));
      assert.equal(confirmed.digest("hex"), candidate);
      if (staged.length) git(work, "commit", "-m", `chore(catalog): refresh ${id.toUpperCase()} offers`);
      const sha = git(work, "rev-parse", "HEAD");
      assert.equal(git(work, "status", "--porcelain=v1", "--untracked-files=all"), "");
      if (collectorPatch) {
        step = "collector_repair";
        await publishCollectorRepair({ work, id, base, config, site, ...collectorCallbacks });
      } else {
        state.pendingSha = sha; state.pendingWorkspace = work; state.lastStep = "push";
        await save(statePath, state);
        step = "push";
        if (staged.length) git(work, "push", "origin", `${sha}:refs/heads/main`);
      }
    }
    step = "verify_production";
    let proof;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { proof = await verifyProduction(config, site, state.pendingSha, state.pendingWorkspace); break; }
      catch { if (attempt === 39) throw new Error("production_verification_failed"); await pause(15_000); }
    }
    state = recordVerifiedWorkflow(await observeWork(state, state.pendingWorkspace, config, id, proof.sha), proof);
    if (state.collectorRepair?.sha === proof.sha) state.collectorRepair.status = "recovered";
    await save(statePath, state);
    // Request a fresh shared browser check. Only that checker closes the public incident.
    try { execFileSync("gh", ["workflow", "run", "monitor.yml", "--repo", "Issakimho/catalog-site-monitor"], { timeout: 30_000, stdio: "pipe" }); } catch {}
    return { site: id, decision: "recovered", ...proof, ...sourceHealthSummary(state) };
  } catch (error) {
    if (step === "run verify:publication" && state.lastWorkspace && !state.pendingSha && state.collectorRepair?.workspace !== state.lastWorkspace) {
      try {
        const report = parseEngineFailure(await readFile(`${state.lastWorkspace}.log`, "utf8"));
        if (report) {
          const base = git(state.lastWorkspace, "rev-parse", "HEAD");
          const fingerprint = repairFingerprint(config.repository, base, report);
          if (mayAttemptRepair(state, fingerprint)) {
            state.engineRepair = { fingerprint, invariant: report.invariant, base, source: state.lastWorkspace,
              startedAt: new Date().toISOString(), status: "running" };
            await save(statePath, state);
            try {
              const repair = await runEngineAutoRepair({
                id, report, config, site, baseDir, source: state.lastWorkspace,
                assertRepository, verifyCandidateBrowser, verifyProduction,
                runCommand: ({ cwd, program, args, logPath, env, timeout }) => command(cwd, program, args, logPath, env, timeout, lockPath),
                onPullRequest: async ({ prUrl, prNumber, head, workspace }) => {
                  state.engineRepair = { ...state.engineRepair, status: "pr_checks", prUrl, prNumber, head, workspace };
                  state.lastWorkspace = workspace;
                  await save(statePath, state);
                },
                onMerged: async ({ sha, workspace, prUrl }) => {
                  state.engineRepair = { ...state.engineRepair, status: "pending_production", prUrl, sha };
                  state.pendingSha = sha;
                  state.pendingWorkspace = workspace;
                  state.lastWorkspace = workspace;
                  await save(statePath, state);
                }
              });
              state = recordVerifiedWorkflow(await observeWork(state, state.pendingWorkspace ?? state.lastWorkspace, config, id, repair.sha), repair.proof);
              state.engineRepair = { ...state.engineRepair, status: "recovered", sha: repair.sha, prUrl: repair.prUrl };
              await save(statePath, state);
              try { execFileSync("gh", ["workflow", "run", "monitor.yml", "--repo", "Issakimho/catalog-site-monitor"], { timeout: 30_000, stdio: "pipe" }); } catch {}
              return { site: id, decision: "recovered", repair: { invariant: report.invariant, prUrl: repair.prUrl }, ...repair.proof, ...sourceHealthSummary(state) };
            } catch (repairError) {
              const code = /^[a-z_]+$/.test(repairError.message) ? repairError.message : "validation_failed";
              state.engineRepair = { ...state.engineRepair, status: state.pendingSha ? "pending_production" : code === "repair_ci_timeout" ? "pr_checks" : "needs_attention", code };
              step = "engine_repair";
            }
          }
        }
      } catch { /* Preserve the original publication failure if diagnosis itself fails. */ }
    }
    state.lastFailure = { at: new Date().toISOString(), step, code: /^[a-z_]+$/.test(error.message) ? error.message : "validation_failed" };
    if (state.collectorRepair?.workspace === state.lastWorkspace || decision === "resume_collector_pr") {
      const resumable = ["publishing", "pr_checks"].includes(state.collectorRepair.status) &&
        (error.message === "repair_ci_timeout" || !/repair_ci_failed|repair_check_failed|changed|advanced|expired|out_of_scope|not_open/.test(error.message));
      state.collectorRepair = { ...state.collectorRepair,
        status: state.pendingSha ? "pending_production" : resumable ? state.collectorRepair.status : "needs_attention",
        code: state.lastFailure.code };
    }
    if (decision === "resume_engine_pr" && step === "engine_repair") {
      state.engineRepair = { ...state.engineRepair, status: state.pendingSha ? "pending_production" : error.message === "repair_ci_timeout" ? "pr_checks" : "needs_attention", code: state.lastFailure.code };
    }
    if (step === "engine_repair") state.lastFailure.code = state.engineRepair?.code ?? "validation_failed";
    state = recordWorkflowFailure(state, state.lastFailure, state.lastWorkspace ?? decision);
    await save(statePath, state);
    return { site: id, decision: "failed", ...sourceHealthSummary(state), ...state.lastFailure, workspace: state.lastWorkspace, statePath };
  } finally {
    // Only release our own lock, preserving an audit record.
    if ((await json(lockPath)).pid === process.pid) await rename(lockPath, join(baseDir, "last-lock.json"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await recover(process.argv[2], { apply: process.argv.includes("--run"), force: process.argv.includes("--force"), probeBrowser: process.argv.includes("--probe-browser"), configPath: process.env.CATALOG_RECOVERY_CONFIG });
    console.log(JSON.stringify(result));
    if (result.attentionRequired || ["failed", "retry_limit"].includes(result.decision)) process.exitCode = 1;
  } catch { console.error(JSON.stringify({ site: process.argv[2], decision: "failed", code: "preflight_failed" })); process.exitCode = 1; }
}
