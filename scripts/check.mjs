import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { sites, profiles, FORECAST_HOURS, LISTING_HOURS } from "../config/sites.mjs";

const HOUR = 3_600_000;
const MAX_BYTES = 8_000_000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function browserEnvironment(env = process.env) {
  return { PATH: env.PATH ?? "", HOME: env.HOME ?? "" };
}

// Use Playwright's bundled ARM64 browser on the Raspberry.
// Keep the existing Chrome selection on the Mac and GitHub's x64 runners.
export function browserLaunchOptions(platform = process.platform, arch = process.arch, env = process.env) {
  return { channel: platform === "linux" && arch === "arm64" ? "chromium" : "chrome",
    headless: true, env: browserEnvironment(env) };
}

export async function fetchBytes(url, request = fetch) {
  let lastCode = "network_error";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await request(url, { redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "User-Agent": "catalog-site-monitor/1.0", "Cache-Control": "no-cache" } });
      if (!response.ok) throw new Error(`http_${response.status}`);
      if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("response_too_large");
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error("response_too_large");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      // Never persist server response bodies, URLs, product records or arbitrary error text.
      lastCode = /^(http_\d{3}|response_too_large)$/.test(error.message) ? error.message : "network_error";
      if (attempt < 2) await pause(300 * (attempt + 1));
    }
  }
  throw new Error(lastCode);
}

export function inspectSnapshot(bytes, manifestBytes, site, now = Date.now()) {
  let catalog, manifest;
  try { catalog = JSON.parse(bytes); manifest = JSON.parse(manifestBytes); }
  catch { return { status: "critical", codes: ["invalid_json"] }; }
  const codes = [];
  const products = Array.isArray(catalog.products) ? catalog.products : [];
  const generated = Date.parse(catalog.generatedAt);
  const ageHours = Number.isFinite(generated) ? (now - generated) / HOUR : null;
  if (catalog.schemaVersion !== 2 || !Array.isArray(catalog.products)) codes.push("invalid_schema");
  if (manifest.snapshot?.bytes !== bytes.length || manifest.snapshot?.sha256 !== createHash("sha256").update(bytes).digest("hex")) codes.push("snapshot_integrity_mismatch");
  if (!/^sha256:[a-f0-9]{64}$/.test(catalog.catalogVersion ?? "") || catalog.catalogVersion !== manifest.catalogVersion) codes.push("catalog_version_mismatch");
  if (manifest.totals?.published !== products.length || catalog.totals?.published !== products.length) codes.push("product_count_mismatch");
  const published = Date.parse(manifest.publishedAt);
  if (manifest.schemaVersion !== 2 || !Number.isFinite(published) || published > now + 360_000 || published < generated) codes.push("invalid_manifest_date");
  if (ageHours === null || ageHours < -0.1) codes.push("invalid_generated_date");
  if (!products.length) codes.push("empty_catalog");
  const freshAt = (date) => products.filter((product) => {
    const seen = Date.parse(product.timestamps?.lastSeenAt);
    return Number.isFinite(seen) && seen <= now + 360_000 && date - seen <= LISTING_HOURS * HOUR;
  }).length;
  const freshNow = freshAt(now);
  const freshForecast = freshAt(now + FORECAST_HOURS * HOUR);
  if (freshNow < site.minFresh) codes.push("too_few_fresh_products");
  const critical = codes.length > 0;
  if (ageHours !== null && ageHours > site.maxAgeHours) codes.push("snapshot_overdue");
  if (freshForecast < site.minFresh) codes.push("freshness_risk_12h");
  return { status: critical ? "critical" : codes.length ? "warning" : "healthy", codes,
    generatedAt: Number.isFinite(generated) ? new Date(generated).toISOString() : null,
    ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    products: products.length, freshNow, freshForecast };
}

export async function probeProfile(browser, site, profile, now, forecastHours) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    await context.route("**/*", (route) => {
      const request = route.request();
      const url = new URL(request.url());
      return url.origin === site.origin && !["image", "font", "media"].includes(request.resourceType())
        && !/analytics|telemetry|_vercel\/insights/i.test(url.pathname)
        ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(now + forecastHours * HOUR));
    const params = new URLSearchParams({ s: profile.software, b: String(profile.budget),
      l: profile.load, m: "balanced", mp: "none" });
    const response = await page.goto(`${site.origin}${site.quiz}?${params}`, { waitUntil: "domcontentloaded", timeout: 25_000 });
    if (!response?.ok() || new URL(page.url()).origin !== site.origin) return { profile: profile.id, forecastHours, cards: 0, ctas: 0, code: "quiz_http_error" };
    const cards = page.locator("#results-grid [data-recommendation-card]:visible");
    await cards.first().waitFor({ state: "visible", timeout: 18_000 }).catch(() => {});
    const count = await cards.count();
    let ctas = 0;
    for (let i = 0; i < count; i++) {
      const cta = cards.nth(i).locator(".card-cta:visible").first();
      if (await cta.count() && await cta.isEnabled()) ctas++;
    }
    return { profile: profile.id, forecastHours, cards: count, ctas,
      code: count < 1 ? "no_recommendations" : ctas < count ? "missing_purchase_cta" : "ok" };
  } catch {
    return { profile: profile.id, forecastHours, cards: 0, ctas: 0, code: "browser_probe_failed" };
  } finally { await context.close(); }
}

export async function checkSite(site, browser, now = Date.now(), request = fetchBytes) {
  let snapshot;
  try {
    // Re-fetch both if publication happened between the two reads.
    for (let attempt = 0; attempt < 2; attempt++) {
      const [bytes, manifest] = await Promise.all([
        request(`${site.origin}${site.data}catalog-current.json`),
        request(`${site.origin}${site.data}catalog-manifest.json`)
      ]);
      snapshot = inspectSnapshot(bytes, manifest, site, now);
      if (!snapshot.codes.some((code) => /mismatch/.test(code))) break;
    }
  } catch (error) {
    snapshot = { status: "critical", codes: [/^(http_\d{3}|network_error|response_too_large)$/.test(error.message) ? error.message : "snapshot_check_failed"] };
  }
  const probes = [];
  for (const forecastHours of [0, FORECAST_HOURS]) {
    // Three parallel profiles per site, independent contexts, no affiliate navigation.
    probes.push(...await Promise.all(profiles.map((profile) => probeProfile(browser, site, profile, now, forecastHours))));
  }
  const currentBad = probes.some((probe) => probe.forecastHours === 0 && probe.code !== "ok");
  const forecastBad = probes.some((probe) => probe.forecastHours > 0 && probe.code !== "ok");
  const codes = [...snapshot.codes];
  if (currentBad) codes.push("current_quiz_failed");
  if (forecastBad) codes.push("quiz_risk_12h");
  return { site: site.id, origin: site.origin, ...snapshot, probes, codes,
    status: snapshot.status === "critical" || currentBad ? "critical" : codes.length ? "warning" : "healthy" };
}

async function main() {
  const now = Date.now();
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch(browserLaunchOptions());
  const report = { schemaVersion: 1, checkedAt: new Date(now).toISOString(), sites: [] };
  try {
    // Two sites at a time avoids starting thirty pages on a small standard runner.
    for (let i = 0; i < sites.length; i += 2) {
      report.sites.push(...await Promise.all(sites.slice(i, i + 2).map((site) => checkSite(site, browser, now))));
    }
  } finally { await browser.close(); }
  await mkdir("reports", { recursive: true });
  await writeFile("reports/latest.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  // Site incidents are handled by notify. A failed monitor itself must fail the workflow.
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
