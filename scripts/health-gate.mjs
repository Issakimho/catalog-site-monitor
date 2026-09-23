import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { validateReport } from "./notify.mjs";

export function assertPublicHealth(report, now = Date.now()) {
  validateReport(report, now);
  const failing = report.sites.filter(site => site.status !== "healthy"
    || site.codes.length > 0 || site.probes.some(probe => probe.code !== "ok"
      || probe.cards < 1 || probe.ctas < probe.cards));
  if (failing.length) {
    throw new Error(`public_catalog_health_failed:${failing.map(site => site.site).join(",")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertPublicHealth(JSON.parse(await readFile("reports/latest.json", "utf8")));
  console.log("All public catalogs and current/+12h recommendation journeys are healthy.");
}
