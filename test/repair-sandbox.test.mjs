import test from "node:test";
import assert from "node:assert/strict";
import { repairSandboxArgs, REPAIR_WORKSPACE } from "../scripts/repair-sandbox.mjs";

test("the repair sandbox mounts only a disposable checkout and required runtime", () => {
  const work = "/home/imho/.local/state/catalog-autonomy/it/attempt-123-engine";
  const args = repairSandboxArgs(work, { agent: true, network: true, home: "/home/imho" });
  assert.deepEqual(args.slice(0, 5), ["--ro-bind", "/", "/", "--tmpfs", "/home/imho"]);
  assert.ok(args.includes(REPAIR_WORKSPACE));
  assert.ok(args.includes("/home/imho/.codex/auth.json"));
  assert.ok(args.includes("/home/imho/.local"));
  assert.ok(args.includes(`${work}/.git`));
  assert.ok(args.includes(`${work}/node_modules`));
  assert.ok(!args.includes("/home/imho/.config/gh"));
  assert.ok(!args.includes("/home/imho/.codex/catalog-autonomy"));
  assert.ok(!args.includes("--unshare-net"));
});

test("validation cannot reach the network or the Codex login", () => {
  const args = repairSandboxArgs("/home/imho/.local/state/catalog-autonomy/it/attempt-123-engine", { home: "/home/imho" });
  assert.ok(args.includes("--unshare-net"));
  assert.ok(!args.includes("/home/imho/.codex/auth.json"));
  assert.ok(!args.includes("/home/imho/workspace/node_modules"));
  assert.throws(() => repairSandboxArgs("/tmp/foreign", { home: "/home/imho" }));
});
