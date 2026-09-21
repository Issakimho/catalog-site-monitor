import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sites } from "../config/sites.mjs";
import { inspectSnapshot, fetchBytes, browserEnvironment, checkSite } from "../scripts/check.mjs";
import { repairDecision, requestRepair, repairAccessAvailable, reconcileSite, publishDailySummary, validateReport, githubClient, localRecoveryStatus } from "../scripts/notify.mjs";

const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const date = (hours = 0) => new Date(NOW - hours * 3_600_000).toISOString();
function snapshot({ count = 120, age = 2, seenAge = age, mutate = () => {} } = {}) {
  const catalog = { schemaVersion: 2, generatedAt: date(age), catalogVersion: `sha256:${"a".repeat(64)}`,
    totals: { published: count }, products: Array.from({ length: count }, () => ({ timestamps: { lastSeenAt: date(seenAge) } })) };
  mutate(catalog);
  const bytes = Buffer.from(JSON.stringify(catalog));
  return [bytes, Buffer.from(JSON.stringify({ schemaVersion: 2, publishedAt: catalog.generatedAt, catalogVersion: catalog.catalogVersion,
    totals: catalog.totals, snapshot: { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } }))];
}
const probes = (code = "ok") => [0, 12].flatMap((forecastHours) => ["drawing", "bim", "rendering"].map((profile) => ({
  profile, forecastHours, code, cards: code === "ok" ? 2 : 0, ctas: code === "ok" ? 2 : 0
})));
const healthy = (site = sites[0]) => ({ site: site.id, origin: site.origin, status: "healthy", codes: [], probes: probes() });
const bad = (site = sites[2]) => ({ ...healthy(site), status: "critical", codes: ["current_quiz_failed"], probes: probes("no_recommendations") });

test("healthy, empty, old and forecast-expiring catalogs", () => {
  assert.equal(inspectSnapshot(...snapshot(), sites[0], NOW).status, "healthy");
  assert.ok(inspectSnapshot(...snapshot({ count: 0 }), sites[0], NOW).codes.includes("empty_catalog"));
  assert.equal(inspectSnapshot(...snapshot({ age: 17 }), sites[0], NOW).status, "warning");
  assert.equal(inspectSnapshot(...snapshot({ seenAge: 49 }), sites[0], NOW).status, "critical");
  const forecast = inspectSnapshot(...snapshot({ seenAge: 40 }), sites[0], NOW);
  assert.equal(forecast.status, "warning");
  assert.equal(forecast.freshNow, 120);
  assert.equal(forecast.freshForecast, 0);
});

test("corrupt, mismatched, missing and future data fail closed", () => {
  const [bytes, manifest] = snapshot();
  assert.equal(inspectSnapshot(Buffer.from("{"), manifest, sites[0], NOW).status, "critical");
  assert.ok(inspectSnapshot(Buffer.concat([bytes, Buffer.from(" ")]), manifest, sites[0], NOW).codes.includes("snapshot_integrity_mismatch"));
  for (const mutate of [
    (c) => { c.schemaVersion = 1; }, (c) => { c.totals.published = 0; },
    (c) => { c.catalogVersion = "secret or arbitrary text"; }, (c) => { c.generatedAt = "invalid"; },
    (c) => { c.generatedAt = date(-1); }, (c) => { c.products = []; }
  ]) assert.equal(inspectSnapshot(...snapshot({ mutate }), sites[0], NOW).status, "critical");
});

test("bounded HTTP retries never propagate response content", async () => {
  let calls = 0;
  const content = await fetchBytes("https://example.test", async (_url, options) => {
    assert.equal(options.redirect, "error");
    return ++calls < 3 ? new Response("private response", { status: 503 }) : new Response("{}");
  });
  assert.equal(calls, 3);
  assert.equal(content.toString(), "{}");
  await assert.rejects(fetchBytes("https://example.test", async () => { throw new Error("secret-token"); }), /^Error: network_error$/);
  await assert.rejects(fetchBytes("https://example.test", async () => new Response("{}", { headers: { "content-length": "9000000" } })), /response_too_large/);
});

test("browser receives no token and snapshot failures still run six isolated browser probes", async () => {
  assert.deepEqual(browserEnvironment({ PATH: "/bin", HOME: "/tmp", GITHUB_TOKEN: "secret", PCARCHITECTE_ACTIONS_TOKEN: "secret" }), { PATH: "/bin", HOME: "/tmp" });
  let contexts = 0, closed = 0;
  const fakeBrowser = { newContext: async () => {
    contexts++;
    return { route: async () => {}, newPage: async () => { throw new Error("browser failed"); }, close: async () => { closed++; } };
  } };
  const report = await checkSite(sites[0], fakeBrowser, NOW, async () => { throw new Error("private payload"); });
  assert.equal(contexts, 6);
  assert.equal(closed, 6);
  assert.equal(report.status, "critical");
  assert.ok(!JSON.stringify(report).includes("private payload"));
});

test("private recovery is optional, bounded and targets only the fixed main-branch controller", async () => {
  const run = (age, state = "completed") => ({ event: "workflow_dispatch", head_branch: "main", created_at: date(age), updated_at: date(age), status: state });
  assert.equal(repairDecision([], NOW), "dispatch");
  assert.equal(repairDecision([run(0.1, "in_progress")], NOW), "repair_running");
  assert.equal(repairDecision([run(1, "in_progress")], NOW), "repair_stalled");
  assert.equal(repairDecision([run(0.1)], NOW), "deployment_grace_period");
  assert.equal(repairDecision([run(1), run(2)], NOW), "repair_limit_reached");
  assert.equal(repairDecision([run(7)], NOW), "dispatch");
  assert.equal(await requestRepair(bad(sites[0]), undefined, NOW), "repair_unavailable");
  assert.equal(await requestRepair(bad(sites[2]), () => assert.fail("must not dispatch variant"), NOW), "local_recovery_unverified");
  const calls = [];
  assert.equal(await requestRepair(bad(sites[0]), async (...args) => { calls.push(args); return { workflow_runs: [] }; }, NOW), "repair_requested");
  assert.deepEqual(calls[1], ["actions/workflows/catalog-watchdog.yml/dispatches", "POST", { ref: "main" }]);
  assert.equal(await requestRepair(bad(sites[0]), async () => { throw new Error("secret"); }, NOW), "repair_unavailable");
});

test("local recovery claims require authenticated, site-specific failure evidence", async () => {
  const italian = bad(sites.find((site) => site.id === "it"));
  const failure = { title: "[Raspberry] Collecte IT", state: "open", user: { login: "Issakimho" },
    body: "<!-- raspberry-catalog-v1:it -->" };
  assert.equal(localRecoveryStatus(italian), "local_recovery_unverified");
  assert.equal(localRecoveryStatus(italian, [failure]), "local_recovery_needs_attention");
  for (const change of [{ state: "closed" }, { user: { login: "stranger" } },
    { title: "[Raspberry] Collecte DE" }, { body: "untrusted prose" }, { pull_request: {} }]) {
    assert.equal(localRecoveryStatus(italian, [{ ...failure, ...change }]), "local_recovery_unverified");
  }
  const maintenance = { ...failure, title: "[Raspberry] Maintenance IT", body: "<!-- raspberry-maintenance-v1:it -->" };
  assert.equal(localRecoveryStatus(italian, [maintenance]), "local_recovery_needs_attention");
  const calls = [];
  await reconcileSite(italian, date(), [failure], async (...args) => { calls.push(args); return { number: 34 }; });
  assert.match(calls[0][2].body, /local_recovery_needs_attention/);
  assert.doesNotMatch(calls[0][2].body, /local_recovery_scheduled/);
});

test("incidents are deduplicated, update only on meaningful change and close after recovery", async () => {
  const calls = [];
  const request = async (...args) => { calls.push(args); return { number: 7 }; };
  const report = bad();
  assert.equal((await reconcileSite(report, date(), [], request)).action, "opened");
  const incident = { number: 7, ...calls[0][2], user: { login: "github-actions[bot]" } };
  assert.deepEqual(incident.assignees, ["Issakimho"]);
  calls.length = 0;
  assert.equal((await reconcileSite({ ...report, ageHours: 50 }, date(), [incident], request)).action, "unchanged");
  assert.equal(calls.length, 0);
  assert.equal((await reconcileSite({ ...report, status: "warning" }, date(), [incident], request)).action, "updated");
  assert.equal(calls.length, 2);
  calls.length = 0;
  assert.equal((await reconcileSite(healthy(sites[2]), date(), [incident], request)).action, "closed");
  assert.deepEqual(calls[0], ["issues/7", "PATCH", { state: "closed", state_reason: "completed" }]);
});

test("foreign issues are not modified and missing FR repair access is actionable", async () => {
  const request = async (_path, method) => { assert.equal(method, "POST"); return { number: 8 }; };
  const foreign = { number: 4, title: `[Catalogue] ${sites[2].origin.slice(8)}`, body: "<!-- catalog-site-monitor-v1:de -->", user: { login: "someone-else" } };
  assert.equal((await reconcileSite(bad(), date(), [foreign], request)).action, "opened");
  assert.equal((await reconcileSite(bad(sites[0]), date(), [], request)).action, "opened");
});

test("repair access checks detect missing, revoked or disabled access without dispatch", async () => {
  assert.equal(await repairAccessAvailable(), false);
  assert.equal(await repairAccessAvailable(async () => { throw new Error("github_http_401"); }), false);
  assert.equal(await repairAccessAvailable(async () => ({ state: "disabled_manually" })), false);
  assert.equal(await repairAccessAvailable(async (path, method) => {
    assert.equal(path, "actions/workflows/catalog-watchdog.yml");
    assert.equal(method, undefined);
    return { state: "active", path: ".github/workflows/catalog-watchdog.yml" };
  }), true);
});

test("report validation rejects missing sites, foreign origins and arbitrary prose", () => {
  const report = { schemaVersion: 1, checkedAt: date(), sites: sites.map(healthy) };
  assert.doesNotThrow(() => validateReport(report, NOW));
  for (const mutate of [
    (r) => { r.sites.pop(); }, (r) => { r.sites[0].origin = "https://attacker.test"; },
    (r) => { r.sites[0].codes = ["@someone arbitrary text"]; }, (r) => { r.checkedAt = date(2); },
    (r) => { r.sites[1] = r.sites[0]; }
  ]) { const copy = structuredClone(report); mutate(copy); assert.throws(() => validateReport(copy, NOW)); }
});

test("daily record publishes only scalar test results once per day", async () => {
  const report = { checkedAt: date(), sites: sites.map((s) => ({ ...healthy(s), merchantToken: "never-publish" })) };
  const calls = [];
  const request = async (...args) => {
    calls.push(args);
    if (args[1] !== "PUT") throw new Error("github_http_404");
    return {};
  };
  assert.equal(await publishDailySummary(report, request), "published");
  const content = Buffer.from(calls[1][2].content, "base64").toString();
  assert.ok(!content.includes("never-publish"));
  assert.ok(!content.includes("merchantToken"));
  assert.equal(await publishDailySummary(report, async () => ({ content: Buffer.from(content).toString("base64") })), "already_published_today");
});

test("GitHub client scopes URLs and hides private error details", async () => {
  const request = githubClient("owner/repo", "secret", async (url, opts) => {
    assert.equal(url, "https://api.github.com/repos/owner/repo/issues");
    assert.equal(opts.redirect, "error");
    assert.equal(opts.headers.Authorization, "Bearer secret");
    return new Response("secret private repository", { status: 403 });
  });
  await assert.rejects(request("issues"), /^Error: github_http_403$/);
  await assert.rejects(request("../other"), /invalid_api_path/);
});

test("public workflow has one standard job, no PR privileges or dependency scripts", async () => {
  const workflow = await readFile(new URL("../.github/workflows/monitor.yml", import.meta.url), "utf8");
  assert.match(workflow, /43 \*\/2 \* \* \*/);
  assert.match(workflow, /runs-on: ubuntu-24.04/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(workflow, /pull_request|OPENAI|AMAZON|AWIN|self-hosted|upload-artifact/);
  assert.equal((workflow.match(/runs-on:/g) ?? []).length, 1);
  assert.equal((workflow.match(/uses: [^@]+@[a-f0-9]{40}/g) ?? []).length, 2);
});
