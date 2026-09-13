import { pathToFileURL } from "node:url";
import { githubClient } from "./notify.mjs";

const WORKFLOW = "catalog-watchdog.yml";

export async function verifyRepairBridge(request, { pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 24 } = {}) {
  const workflow = await request(`actions/workflows/${WORKFLOW}`);
  if (workflow.state !== "active" || workflow.path !== `.github/workflows/${WORKFLOW}`) throw new Error("repair_workflow_not_active");
  // One manual smoke test. The private controller independently verifies live health
  // and retains its recovery limits; this does not force a collection on a healthy site.
  const dispatched = await request(`actions/workflows/${WORKFLOW}/dispatches`, "POST", { ref: "main" });
  const id = dispatched?.workflow_run_id;
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("dispatch_not_confirmed");
  for (let attempt = 0; attempt < attempts; attempt++) {
    const run = await request(`actions/runs/${id}`);
    if (run.event !== "workflow_dispatch" || run.head_branch !== "main" || run.workflow_id !== workflow.id) throw new Error("unexpected_repair_run");
    if (run.status === "completed") {
      if (run.conclusion !== "success") throw new Error("private_controller_failed");
      return { dispatchAccepted: true, privateControllerCompleted: true, conclusion: "success" };
    }
    if (attempt + 1 < attempts) await pause(15_000);
  }
  throw new Error("private_controller_timeout");
}

async function main() {
  if (process.env.GITHUB_REPOSITORY !== "Issakimho/catalog-site-monitor" || process.env.GITHUB_REF !== "refs/heads/main"
    || process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") throw new Error("untrusted_execution_context");
  const request = githubClient(process.env.PCARCHITECTE_REPAIR_REPOSITORY, process.env.PCARCHITECTE_ACTIONS_TOKEN);
  // Output only the result, never private workflow data, URLs, logs or credentials.
  console.log(JSON.stringify(await verifyRepairBridge(request)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
