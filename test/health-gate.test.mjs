import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sites } from "../config/sites.mjs";
import { assertPublicHealth } from "../scripts/health-gate.mjs";

const now = Date.parse("2026-09-23T16:00:00Z");
const report = () => ({schemaVersion:1, checkedAt:new Date(now).toISOString(), sites:sites.map(site => ({
  site:site.id, origin:site.origin, status:"healthy", codes:[],
  probes:[0,12].flatMap(forecastHours => ["drawing","bim","rendering"].map(profile => ({profile,forecastHours,cards:2,ctas:2,code:"ok"})))
}))});

test("a green run requires all sites and both time horizons to be healthy", () => {
  assert.doesNotThrow(() => assertPublicHealth(report(), now));
  for (const status of ["warning", "critical"]) {
    const r=report(); r.sites[2].status=status;
    assert.throws(() => assertPublicHealth(r,now), /public_catalog_health_failed:de/);
  }
});
test("zero results, missing purchase links and forecast failures cannot hide behind a healthy label", () => {
  for (const forecastHours of [0,12]) {
    for (const change of [{cards:0,ctas:0}, {ctas:1}, {code:"no_recommendations"}]) {
      const r=report();Object.assign(r.sites[2].probes.find(p=>p.forecastHours===forecastHours),change);
      assert.throws(() => assertPublicHealth(r,now), /public_catalog_health_failed:de/);
    }
  }
  const r=report();r.sites[2].codes=["snapshot_overdue"];
  assert.throws(() => assertPublicHealth(r,now), /public_catalog_health_failed:de/);
});
test("missing sites and old reports cannot produce a green run", () => {
  const r=report();r.sites.pop();
  assert.throws(() => assertPublicHealth(r,now), /invalid_or_old_report/);
  assert.throws(() => assertPublicHealth(report(),now+2*3_600_000), /invalid_or_old_report/);
});
test("incidents are reconciled before the workflow reports a health failure", async () => {
  const workflow=await readFile(new URL("../.github/workflows/monitor.yml",import.meta.url),"utf8");
  assert.ok(workflow.indexOf("run: npm run notify") < workflow.indexOf("run: node scripts/health-gate.mjs"));
  assert.ok(workflow.includes("run: node scripts/health-gate.mjs"));
});
