import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export const REPAIR_WORKSPACE = "/home/imho/workspace";

// Linux bubblewrap keeps the machine's home directory out of agent-written
// code. Only the Codex login file is mounted for the agent process itself.
export function repairSandboxArgs(work, { agent = false, network = false, home = homedir() } = {}) {
  assert.ok(resolve(work) === work && work.startsWith(`${home}/`), "invalid_repair_sandbox_workspace");
  assert.ok(home === "/home/imho", "unsupported_repair_sandbox_host");
  return [
    "--ro-bind", "/", "/",
    "--tmpfs", home,
    "--ro-bind", join(home, ".local"), join(home, ".local"),
    "--dir", join(home, "workspace"),
    "--bind", work, REPAIR_WORKSPACE,
    "--ro-bind", join(work, ".git"), join(REPAIR_WORKSPACE, ".git"),
    ...(agent ? ["--ro-bind", join(work, "node_modules"), join(REPAIR_WORKSPACE, "node_modules")] : []),
    ...(agent ? ["--dir", join(home, ".codex"),
      "--ro-bind", join(home, ".codex", "auth.json"), join(home, ".codex", "auth.json")] : []),
    "--tmpfs", "/tmp",
    "--dev", "/dev",
    "--proc", "/proc",
    ...(network ? [] : ["--unshare-net"]),
    "--setenv", "HOME", home,
    "--setenv", "PATH", `${join(home, ".local", "bin")}:/usr/local/bin:/usr/bin:/bin`,
    ...(agent ? ["--setenv", "CODEX_HOME", join(home, ".codex")] : ["--unsetenv", "CODEX_HOME"]),
    "--chdir", REPAIR_WORKSPACE,
    "--"
  ];
}
