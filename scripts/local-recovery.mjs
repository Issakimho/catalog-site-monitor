// Local-only recovery worker. Private configuration and credentials never enter this repository.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, realpath, rename, open, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { sites } from "../config/sites.mjs";
import { fetchBytes, inspectSnapshot, checkSite, browserEnvironment, browserLaunchOptions } from "./check.mjs";

const HOUR = 3_600_000;
const pause = ms => new Promise(r => setTimeout(r, ms));
const json = async path => JSON.parse(await readFile(path, "utf8"));
const save = async (path, value) => { await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await rename(`${path}.tmp`, path); };
const exists = async path => { try { await access(path); return true; } catch { return false; } };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
const gh = path => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", timeout: 45_000, stdio: ["ignore", "pipe", "pipe"] }));

export function decideRecovery(health, state = {}, now = Date.now()) {
  if (state.pendingSha) return "verify_pending";
  const attempts = (state.attempts ?? []).filter(t => now - t < 24 * HOUR);
  if (health.status === "healthy" && health.ageHours < 20) return "healthy";
  if (attempts.length >= 2) return "retry_limit";
  if (attempts.some(t => now - t < 2 * HOUR)) return "cooldown";
  return "refresh";
}

export function assertChangedFiles(changed, allowed) {
  assert.ok(changed.every(file => allowed.includes(file)), "unexpected_changed_files");
}

export function pendingDisposition(pendingSha, remoteSha, isAncestor) {
  if (pendingSha === remoteSha) return "verify";
  return isAncestor ? "pending_superseded" : "push_not_published";
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

async function command(cwd, executable, args, logPath, env = process.env, timeout = 1_200_000, lockPath) {
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

export async function verifyCandidateBrowser(work, site) {
  const reservation = createServer();
  await new Promise(r => reservation.listen(0, "127.0.0.1", r));
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const preview = spawn("npm", ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(port)], {
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
  await save(statePath, { ...state, pendingSha: null, pendingWorkspace: null, lastFailure: null, lastSuccess: new Date().toISOString(), proof });
  return proof;
}

export async function recover(id, { apply = false, force = false, configPath } = {}) {
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
    if (incident && health.status === "healthy") health = await browserHealth(site);
  } catch { health = { ...health, status: "warning", codes: [...(health.codes ?? []), "incident_read_failed"] }; }
  let decision = decideRecovery(health, state);
  if (force && !state.pendingSha) decision = "refresh"; // Manual recovery only; the saved automation never sets this flag.
  if (!apply || ["healthy", "cooldown", "retry_limit"].includes(decision)) return { site: id, decision, status: health.status, codes: health.codes, statePath };

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
  try {
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
    }
    if (decision === "refresh") {
      state.attempts = [...(state.attempts ?? []).filter(t => Date.now() - t < 24 * HOUR), Date.now()];
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
      const manifest = await json(join(work, "config/variant-manifest.json"));
      assert.equal(await realpath(manifest.target.root), await realpath(config.root));
      const allowed = manifest.operations.catalog.refresh.allowedChangedFiles;
      assert.deepEqual(allowed, [config.demo, `public${site.data}catalog-current.json`, `public${site.data}catalog-manifest.json`]);
      // Read existing credentials in place through the target's approved loader. Never persist values.
      const { loadAmazonCredentials } = await import(pathToFileURL(join(work, "scripts/amazon-credentials.mjs")));
      const creds = await loadAmazonCredentials({ envPath: config.credentials });
      assert.equal(creds.missing.length, 0, "credentials_missing");
      assert.equal(creds.marketplace, id.toUpperCase(), "wrong_credential_market");
      assert.equal(creds.associateTag, config.tag, "wrong_affiliate_identity");
      const env = collectionEnvironment(process.env, creds, config.credentials, health.status !== "healthy");
      for (const args of [["ci", "--ignore-scripts"], ["run", "check:amazon"], ["run", "fetch:amazon-catalog"], ["run", config.build], ["run", "verify:publication"]]) {
        step = args.join(" ");
        console.log(JSON.stringify({ site: id, step, status: "running" }));
        // Only collection receives supplier credentials; validation and browser processes do not.
        const scopedEnv = args[1] === "fetch:amazon-catalog" || args[1] === "check:amazon" ? env : collectionEnvironment(process.env, {}, "");
        // Omit absent values from the non-supplier environment rather than stringifying them.
        await command(work, "npm", args, log, Object.fromEntries(Object.entries(scopedEnv).filter(([, value]) => value != null)), 1_200_000, lockPath);
      }
      step = "candidate_integrity";
      const bytes = await readFile(join(work, `public${site.data}catalog-current.json`));
      const meta = await readFile(join(work, `public${site.data}catalog-manifest.json`));
      assert.equal(inspectSnapshot(bytes, meta, site).status, "healthy", "candidate_not_fresh");
      step = "candidate_browser";
      await verifyCandidateBrowser(work, site);
      const digest = createHash("sha256");
      for (const file of allowed) digest.update(await readFile(join(work, file)));
      const candidate = digest.digest("hex");
      assert.equal(git(work, "diff", "--cached", "--name-only"), "");
      assertChangedFiles([...git(work, "diff", "--name-only", "HEAD").split("\n"), ...git(work, "ls-files", "--others", "--exclude-standard").split("\n")].filter(Boolean), allowed);
      assert.equal(git(work, "rev-parse", "HEAD"), base);
      git(work, "fetch", "--no-tags", "origin", "main");
      assert.equal(git(work, "rev-parse", "origin/main"), base, "remote_advanced");
      git(work, "add", "--", ...allowed);
      const staged = git(work, "diff", "--cached", "--name-only").split("\n").filter(Boolean);
      assertChangedFiles(staged, allowed);
      const confirmed = createHash("sha256"); for (const file of allowed) confirmed.update(await readFile(join(work, file)));
      assert.equal(confirmed.digest("hex"), candidate);
      if (staged.length) git(work, "commit", "-m", `chore(catalog): refresh ${id.toUpperCase()} offers`);
      const sha = git(work, "rev-parse", "HEAD");
      assert.equal(git(work, "status", "--porcelain=v1", "--untracked-files=all"), "");
      state.pendingSha = sha; state.pendingWorkspace = work; state.lastStep = "push";
      await save(statePath, state);
      step = "push";
      if (staged.length) git(work, "push", "origin", `${sha}:refs/heads/main`);
    }
    step = "verify_production";
    let proof;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { proof = await verifyProduction(config, site, state.pendingSha, state.pendingWorkspace); break; }
      catch { if (attempt === 39) throw new Error("production_verification_failed"); await pause(15_000); }
    }
    state = { ...state, pendingSha: null, pendingWorkspace: null, lastSuccess: new Date().toISOString(), lastFailure: null, proof };
    await save(statePath, state);
    // Request a fresh shared browser check. Only that checker closes the public incident.
    try { execFileSync("gh", ["workflow", "run", "monitor.yml", "--repo", "Issakimho/catalog-site-monitor"], { timeout: 30_000, stdio: "pipe" }); } catch {}
    return { site: id, decision: "recovered", ...proof };
  } catch (error) {
    state.lastFailure = { at: new Date().toISOString(), step, code: /^[a-z_]+$/.test(error.message) ? error.message : "validation_failed" };
    await save(statePath, state);
    return { site: id, decision: "failed", ...state.lastFailure, workspace: state.lastWorkspace, statePath };
  } finally {
    // Only release our own lock, preserving an audit record.
    if ((await json(lockPath)).pid === process.pid) await rename(lockPath, join(baseDir, "last-lock.json"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await recover(process.argv[2], { apply: process.argv.includes("--run"), force: process.argv.includes("--force"), configPath: process.env.CATALOG_RECOVERY_CONFIG });
    console.log(JSON.stringify(result));
    if (["failed", "retry_limit"].includes(result.decision)) process.exitCode = 1;
  } catch { console.error(JSON.stringify({ site: process.argv[2], decision: "failed", code: "preflight_failed" })); process.exitCode = 1; }
}
