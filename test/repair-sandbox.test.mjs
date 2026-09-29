import test from "node:test";
import assert from "node:assert/strict";
import { repairCodexConfig, repairSandboxArgs, REPAIR_WORKSPACE } from "../scripts/repair-sandbox.mjs";

test("Codex commands can edit the checkout but cannot read machine credentials or rewrite catalog data", () => {
  const args = repairCodexConfig(["demo/amazon-products.mjs", "public/data/catalog-current.json"]);
  const profile = args.find(value => value.startsWith("permissions.repair.filesystem="));
  assert.ok(args.includes('default_permissions="repair"'));
  assert.ok(args.includes("permissions.repair.network.enabled=false"));
  assert.match(profile, /":root"="deny"/);
  assert.match(profile, /"\."="write"/);
  assert.match(profile, /"\.git"="read"/);
  assert.match(profile, /"node_modules"="read"/);
  assert.match(profile, /"demo\/amazon-products\.mjs"="read"/);
  assert.throws(() => repairCodexConfig(["../private.env"]));
});

test("validation mounts only a disposable checkout and required runtime", () => {
  const work = "/home/imho/.local/state/catalog-autonomy/it/attempt-123-engine";
  const args = repairSandboxArgs(work, { home: "/home/imho" });
  assert.deepEqual(args.slice(0, 5), ["--ro-bind", "/", "/", "--tmpfs", "/home/imho"]);
  assert.ok(args.includes(REPAIR_WORKSPACE));
  assert.ok(!args.includes("/home/imho/.codex/auth.json"));
  assert.ok(args.includes("/home/imho/.local/bin"));
  assert.ok(args.includes("/home/imho/.local/lib"));
  assert.ok(!args.includes("/home/imho/.local/state"));
  assert.ok(args.includes(`${work}/.git`));
  assert.ok(!args.includes(`${work}/node_modules`));
  assert.ok(!args.includes("/home/imho/.config/gh"));
  assert.ok(!args.includes("/home/imho/.codex/catalog-autonomy"));
  assert.ok(args.includes("--unshare-net"));
});

test("isolated preview can serve localhost without mounting credentials", () => {
  const args = repairSandboxArgs("/home/imho/.local/state/catalog-autonomy/it/attempt-123-engine", { network: true, home: "/home/imho" });
  assert.ok(!args.includes("--unshare-net"));
  assert.ok(!args.includes("/home/imho/.codex/auth.json"));
  assert.throws(() => repairSandboxArgs("/tmp/foreign", { home: "/home/imho" }));
});
