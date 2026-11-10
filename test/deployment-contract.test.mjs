import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentContext, successfulDeployment } from "../scripts/deployment-contract.mjs";
test("a staging Cloudflare success does not prove Vercel production", () => {
  const statuses=[{context:"Cloudflare",state:"success"},{context:"Vercel",state:"failure"}];
  assert.equal(deploymentContext({migration:{productionProvider:"vercel"}}),"Vercel");
  assert.equal(successfulDeployment(statuses,"Vercel"),false);
});
test("after cutover, a successful Vercel deployment cannot hide a Cloudflare failure", () => {
  const statuses=[{context:"Vercel",state:"success"},{context:"Cloudflare",state:"failure"}];
  assert.equal(deploymentContext({migration:{productionProvider:"cloudflare"}}),"Cloudflare");
  assert.equal(successfulDeployment(statuses,"Cloudflare"),false);
  assert.equal(successfulDeployment([{context:"Cloudflare",state:"success"}],"Cloudflare"),true);
});
test("unconfigured sites keep Vercel; unknown production providers stop verification", () => {
  assert.equal(deploymentContext(),"Vercel");
  assert.throws(()=>deploymentContext({migration:{productionProvider:"other"}}));
});
