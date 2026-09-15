import { readFile, appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { sites } from "../config/sites.mjs";

const PUBLIC_REPO = "Issakimho/catalog-site-monitor";
const OWNER = "Issakimho";
const WORKFLOW = "catalog-watchdog.yml";
const HOUR = 3_600_000;
const marker = (id) => `<!-- catalog-site-monitor-v1:${id} -->`;

export function githubClient(repo, token, request = fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "") || !token) throw new Error("github_configuration_missing");
  return async (path, method = "GET", body) => {
    if (!/^[a-zA-Z0-9_?=&%./-]+$/.test(path) || path.includes("..")) throw new Error("invalid_api_path");
    const response = await request(`https://api.github.com/repos/${repo}/${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    // Never include private repository paths, response bodies or tokens in public errors.
    if (!response.ok) throw new Error(`github_http_${response.status}`);
    return response.status === 204 ? null : response.json();
  };
}

export function repairDecision(runs, now = Date.now()) {
  if (!Array.isArray(runs)) return "repair_unavailable";
  const recent = runs.filter((run) => run.event === "workflow_dispatch"
    && run.head_branch === "main" && Date.parse(run.created_at) > now - 6 * HOUR);
  if (recent.some((run) => run.status !== "completed" && now - Date.parse(run.created_at) < 45 * 60_000)) return "repair_running";
  if (recent.some((run) => run.status !== "completed")) return "repair_stalled";
  if (recent.length >= 2) return "repair_limit_reached";
  if (recent.some((run) => now - Date.parse(run.updated_at) < 10 * 60_000)) return "deployment_grace_period";
  return "dispatch";
}

export async function requestRepair(site, request, now = Date.now()) {
  if (site.status === "healthy") return "not_needed";
  if (site.site !== "fr") return "local_recovery_scheduled";
  if (!request) return "repair_unavailable";
  try {
    const result = await request(`actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=100`);
    const action = repairDecision(result.workflow_runs, now);
    if (action !== "dispatch") return action;
    // Re-check and recovery policy live in the private repository. No provider access here.
    await request(`actions/workflows/${WORKFLOW}/dispatches`, "POST", { ref: "main" });
    return "repair_requested";
  } catch { return "repair_unavailable"; }
}

export async function repairAccessAvailable(request) {
  if (!request) return false;
  try {
    const workflow = await request(`actions/workflows/${WORKFLOW}`);
    return workflow.state === "active" && workflow.path === `.github/workflows/${WORKFLOW}`;
  } catch { return false; }
}

export function notificationSignature(site, repair) {
  // Age and product-count fluctuations must not produce a comment every two hours.
  return createHash("sha256").update(JSON.stringify({ status: site.status, codes: [...site.codes].sort(),
    probes: site.probes.map((probe) => [probe.profile, probe.forecastHours, probe.code]), repair })).digest("hex");
}

function incidentBody(site, repair, checkedAt) {
  const signature = notificationSignature(site, repair);
  const current = site.probes.filter((probe) => probe.forecastHours === 0).map((probe) => `${probe.profile} : ${probe.cards} résultat(s)`).join(" ; ");
  return `${marker(site.site)}\n<!-- state:${signature} -->\n\n@${OWNER} Le contrôle de ${site.origin} demande une vérification.\n\n`
    + `État : ${site.status}. Codes : ${site.codes.join(", ")}.\n\nContrôle : ${checkedAt}.\n\n`
    + `Parcours actuels : ${current}.\n\nRétablissement : ${repair}.\n\n`
    + (repair === "local_recovery_scheduled" ? "Le collecteur existant fonctionne sur le Raspberry, sans dépendre du Mac ni de l’application Codex ouverte. Il vérifie le catalogue toutes les quatre heures et peut être sollicité par le contrôle horaire après confirmation d’un incident. Ses limites de tentatives et validations restent applicables. Un accès fournisseur révoqué ou un échec persistant peut nécessiter une intervention.\n\n" : "")
    + "Les collectes locales restent la source de mise à jour des variantes. Aucun prix ni horodatage n’a été modifié par ce contrôleur. "
    + "L’incident sera fermé après un contrôle complet réussi. Les mises à jour identiques ne produisent pas de commentaire supplémentaire.\n";
}

export async function reconcileSite(site, checkedAt, openIssues, request, repairRequest) {
  const incident = openIssues.find((issue) => !issue.pull_request && issue.user?.login === "github-actions[bot]"
    && issue.title === `[Catalogue] ${site.origin.replace("https://", "")}` && issue.body?.includes(marker(site.site)));
  const repair = await requestRepair(site, repairRequest, Date.parse(checkedAt));
  if (site.status === "healthy") {
    if (incident) await request(`issues/${incident.number}`, "PATCH", { state: "closed", state_reason: "completed" });
    return { site: site.site, action: incident ? "closed" : "healthy", repair };
  }
  // Give the independently guarded private repair time to finish before opening an incident.
  if (!incident && ["repair_requested", "repair_running", "deployment_grace_period"].includes(repair)) {
    return { site: site.site, action: "awaiting_private_monitor", repair };
  }
  const body = incidentBody(site, repair, checkedAt);
  if (!incident) {
    const created = await request("issues", "POST", { title: `[Catalogue] ${site.origin.replace("https://", "")}`,
      body, assignees: [OWNER] });
    return { site: site.site, action: "opened", issue: created.number, repair };
  }
  const signature = notificationSignature(site, repair);
  if (!incident.body.includes(`<!-- state:${signature} -->`)) {
    await request(`issues/${incident.number}`, "PATCH", { body });
    await request(`issues/${incident.number}/comments`, "POST", {
      body: `Changement détecté : ${site.status}. Codes : ${site.codes.join(", ")}. Rétablissement : ${repair}.` });
    return { site: site.site, action: "updated", issue: incident.number, repair };
  }
  return { site: site.site, action: "unchanged", issue: incident.number, repair };
}

export function validateReport(report, now = Date.now()) {
  if (report?.schemaVersion !== 1 || !Array.isArray(report.sites) || report.sites.length !== sites.length
    || !Number.isFinite(Date.parse(report.checkedAt)) || Math.abs(now - Date.parse(report.checkedAt)) > HOUR) throw new Error("invalid_or_old_report");
  const ids = new Set();
  for (const item of report.sites) {
    const configured = sites.find((site) => site.id === item.site);
    if (!configured || ids.has(item.site) || item.origin !== configured.origin
      || !["healthy", "warning", "critical"].includes(item.status)
      || !Array.isArray(item.codes) || item.codes.some((code) => !/^[a-z0-9_]{1,64}$/.test(code))
      || !Array.isArray(item.probes) || item.probes.length !== 6
      || item.probes.some((probe) => !["drawing", "bim", "rendering"].includes(probe.profile)
        || ![0, 12].includes(probe.forecastHours) || !/^[a-z0-9_]{1,64}$/.test(probe.code)
        || !Number.isSafeInteger(probe.cards) || probe.cards < 0 || probe.cards > 100
        || !Number.isSafeInteger(probe.ctas) || probe.ctas < 0 || probe.ctas > 100)) throw new Error("invalid_site_report");
    ids.add(item.site);
  }
}

export async function publishDailySummary(report, request) {
  // A real daily regression-test record also keeps the scheduled public repository active.
  let existing;
  try { existing = await request("contents/status/latest.json?ref=main"); }
  catch (error) { if (error.message !== "github_http_404") throw error; }
  if (existing) {
    const previous = JSON.parse(Buffer.from(existing.content, "base64").toString("utf8"));
    if (previous.checkedAt?.slice(0, 10) === report.checkedAt.slice(0, 10)) return "already_published_today";
  }
  const sanitized = { checkedAt: report.checkedAt, sites: report.sites.map((site) => ({
    site: site.site, status: site.status, codes: site.codes,
    probes: site.probes.map(({ profile, forecastHours, cards, ctas, code }) => ({ profile, forecastHours, cards, ctas, code }))
  })) };
  await request("contents/status/latest.json", "PUT", {
    message: `Record public regression checks ${report.checkedAt.slice(0, 10)}`,
    content: Buffer.from(`${JSON.stringify(sanitized, null, 2)}\n`).toString("base64"), branch: "main",
    ...(existing ? { sha: existing.sha } : {})
  });
  return "published";
}

async function main() {
  if (process.env.GITHUB_REPOSITORY !== PUBLIC_REPO || process.env.GITHUB_REF !== "refs/heads/main") throw new Error("untrusted_execution_context");
  const report = JSON.parse(await readFile("reports/latest.json", "utf8"));
  validateReport(report);
  const request = githubClient(PUBLIC_REPO, process.env.GITHUB_TOKEN);
  let repairRequest;
  if (process.env.PCARCHITECTE_ACTIONS_TOKEN && process.env.PCARCHITECTE_REPAIR_REPOSITORY) {
    repairRequest = githubClient(process.env.PCARCHITECTE_REPAIR_REPOSITORY, process.env.PCARCHITECTE_ACTIONS_TOKEN);
  }
  // Detect an expired/revoked credential or disabled private controller even
  // while recommendations are healthy. No workflow is dispatched by this read.
  const bridgeAvailable = await repairAccessAvailable(repairRequest);
  if (!bridgeAvailable) {
    repairRequest = undefined;
    const french = report.sites.find((site) => site.site === "fr");
    if (french.status === "healthy") french.status = "warning";
    french.codes.push("repair_bridge_unavailable");
  }
  const issues = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await request(`issues?state=open&creator=github-actions%5Bbot%5D&per_page=100&page=${page}`);
    issues.push(...batch);
    if (batch.length < 100) break;
    if (page === 10) throw new Error("issue_pagination_limit");
  }
  const actions = [];
  for (const site of report.sites) actions.push(await reconcileSite(site, report.checkedAt, issues, request, repairRequest));
  const daily = await publishDailySummary(report, request);
  console.log(JSON.stringify({ actions, daily, repairBridgeAvailable: bridgeAvailable }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = report.sites.map((site) => `| ${site.origin} | ${site.status} | ${site.codes.join(", ") || "ok"} |`).join("\n");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Public catalog checks\n\n| Site | Status | Diagnostics |\n| --- | --- | --- |\n${rows}\n\nPrivate repair bridge available: ${bridgeAvailable}.\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
