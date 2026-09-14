import test from "node:test";
import assert from "node:assert/strict";
import { browserLaunchOptions } from "../scripts/check.mjs";

test("Raspberry uses bundled ARM64 Chromium, other hosts keep Chrome", () => {
  assert.equal(browserLaunchOptions("linux", "arm64").channel, "chromium");
  assert.equal(browserLaunchOptions("linux", "x64").channel, "chrome");
  assert.equal(browserLaunchOptions("darwin", "arm64").channel, "chrome");
  assert.equal(browserLaunchOptions("darwin", "x64").channel, "chrome");
});

test("browser remains headless and never receives supplier or model credentials", () => {
  const options = browserLaunchOptions("linux", "arm64", {
    PATH: "/bin", HOME: "/home/test", GH_TOKEN: "private", OPENAI_API_KEY: "private",
    AMAZON_CREATORS_SECRET: "private"
  });
  assert.deepEqual(options, { channel: "chromium", headless: true,
    env: { PATH: "/bin", HOME: "/home/test" } });
});
