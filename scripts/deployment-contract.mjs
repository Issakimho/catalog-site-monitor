import { readFile } from "node:fs/promises";
import { join } from "node:path";

export function deploymentContext(document = {}) {
  const provider = document.migration?.productionProvider ?? "vercel";
  if (provider !== "vercel" && provider !== "cloudflare") throw new Error("unsupported_production_provider");
  return provider === "cloudflare" ? "Cloudflare" : "Vercel";
}
export async function readDeploymentContext(root) {
  try { return deploymentContext(JSON.parse(await readFile(join(root, "config/cloudflare.json"), "utf8"))); }
  catch (error) { if (error.code === "ENOENT") return "Vercel"; throw error; }
}
export function successfulDeployment(statuses, context) {
  if (!["Vercel", "Cloudflare"].includes(context)) throw new Error("unsupported_deployment_context");
  return statuses.some(status => status.context === context && status.state === "success");
}
