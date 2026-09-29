import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export const REPAIR_WORKSPACE = "/home/imho/workspace";

// Codex needs its login outside its command sandbox. The named profile lets
// model-run commands edit the checkout without reading that login or other
// private files on the machine.
export function repairCodexConfig(dataPaths) {
  const scoped = { ".": "write", ".git": "read", node_modules: "read" };
  for (const path of dataPaths) {
    assert.ok(/^[a-zA-Z0-9._/-]+$/.test(path) && !path.startsWith("/") && !path.split("/").includes(".."),
      "invalid_repair_data_path");
    scoped[path] = "read";
  }
  const entries = Object.entries(scoped).map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`).join(", ");
  const filesystem = `{":root"="deny", ":minimal"="read", ":tmpdir"="write", ":slash_tmp"="write", ` +
    `":workspace_roots"={${entries}}, "/home/imho/.local/bin"="read", "/home/imho/.local/lib"="read"}`;
  return ["-c", 'default_permissions="repair"', "-c", `permissions.repair.filesystem=${filesystem}`,
    "-c", "permissions.repair.network.enabled=false"];
}

// Validation and preview run in a separate bubblewrap process after the agent
// exits. These mounts contain no supplier, GitHub, or Codex credentials.
export function repairSandboxArgs(work, { network = false, home = homedir() } = {}) {
  assert.ok(resolve(work) === work && work.startsWith(`${home}/`), "invalid_repair_sandbox_workspace");
  assert.ok(home === "/home/imho", "unsupported_repair_sandbox_host");
  return [
    "--ro-bind", "/", "/",
    "--tmpfs", home,
    "--dir", join(home, ".local"),
    "--ro-bind", join(home, ".local", "bin"), join(home, ".local", "bin"),
    "--ro-bind", join(home, ".local", "lib"), join(home, ".local", "lib"),
    "--dir", join(home, "workspace"),
    "--bind", work, REPAIR_WORKSPACE,
    "--ro-bind", join(work, ".git"), join(REPAIR_WORKSPACE, ".git"),
    "--tmpfs", "/tmp",
    "--dev", "/dev",
    "--proc", "/proc",
    ...(network ? [] : ["--unshare-net"]),
    "--setenv", "HOME", home,
    "--setenv", "PATH", `${join(home, ".local", "bin")}:/usr/local/bin:/usr/bin:/bin`,
    "--unsetenv", "CODEX_HOME",
    "--chdir", REPAIR_WORKSPACE,
    "--"
  ];
}
