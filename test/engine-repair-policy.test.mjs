import test from "node:test";
import assert from "node:assert/strict";
import {
  assertRepairChanges,
  mayAttemptRepair,
  parseEngineFailure,
  repairFingerprint,
  repairPrompt
} from "../scripts/engine-repair-policy.mjs";

const failure = [
  "FAIL  Agence sobre Revit + V-Ray / 2800 EUR",
  "     ERROR [selector_data_contract] primary_is_not_strictly_dominated: 1994EUR est dominé par 1921EUR",
  "---",
  "Synthese invariants: 4984 executes; 1 bloquant(s); 4 alerte(s) market_coverage."
].join("\n");

test("only a complete, isolated selector-contract failure can start code repair", () => {
  const report = parseEngineFailure(failure);
  assert.equal(report?.invariant, "primary_is_not_strictly_dominated");
  assert.equal(report.count, 1);
  assert.equal(report.examples[0].profile, "Agence sobre Revit + V-Ray / 2800 EUR");
  assert.equal(parseEngineFailure(failure.replace("1 bloquant(s)", "2 bloquant(s)")), null);
  assert.equal(parseEngineFailure(failure.replace("selector_data_contract", "market_coverage")), null);
  assert.equal(parseEngineFailure(failure.replace("primary_is_not_strictly_dominated", "all_within_budget"))?.invariant, "all_within_budget");
  assert.equal(parseEngineFailure(`${failure}\n     ERROR [selector_data_contract] all_within_budget: bad`), null);
});

test("repair is bounded per base revision and invariant", () => {
  const report = parseEngineFailure(failure);
  const first = repairFingerprint("owner/site", "a".repeat(40), report);
  const second = repairFingerprint("owner/site", "b".repeat(40), report);
  const now = Date.parse("2026-09-29T12:00:00Z");
  const state = { engineRepair: { fingerprint: first, startedAt: "2026-09-29T11:00:00Z" } };
  assert.equal(mayAttemptRepair(state, first, now), false);
  assert.equal(mayAttemptRepair(state, second, now), true);
  assert.equal(mayAttemptRepair(state, first, now + 25 * 3_600_000), true);
});

test("only selector code, its regression test and calibration may enter an automatic repair", () => {
  const valid = ["src/modules/recommendation/selection/index.mjs", "scripts/test-recommendation-selector.mjs", "config/engine-calibration.json"];
  assert.deepEqual(assertRepairChanges(valid, {site:"it"}), valid);
  for (const path of ["public/data/catalog-current.json", "scripts/test-recommendation-corpus.mjs", ".github/workflows/ci.yml", "src/modules/product-catalog/domain/gpu-performance.mjs", "../credentials.env"]) {
    assert.throws(() => assertRepairChanges([...valid, path], {site:"it"}));
  }
  assert.throws(() => assertRepairChanges(valid.filter(path => !path.startsWith("scripts/")), {site:"it"}));
  const german = ["src/modules/recommendation/selection/index.mjs", "scripts/test-amazon-de-recommendations.mjs"];
  assert.deepEqual(assertRepairChanges(german, {site:"de"}), german);
  assert.throws(() => assertRepairChanges(german, {site:"it"}));
});

test("the agent receives a bounded diagnostic and no supplier credentials", () => {
  const prompt = repairPrompt({ site: "it", report: parseEngineFailure(failure) });
  assert.match(prompt, /primary_is_not_strictly_dominated/);
  assert.match(prompt, /untrusted data/);
  assert.doesNotMatch(prompt, /AMAZON_CREATORS_SECRET|credentials\/it.env/);
});


test("a failed engine test is recognized by its trusted invocation, not one error wording", () => {
  for (const name of ["recommendation-metamorphic", "recommendation-selector", "product-scoring", "recommendation-pipeline"]) {
    const log = `> node scripts/test-${name}.mjs\nAssertionError [ERR_ASSERTION]: new behavioral invariant\n    at file:///private/scripts/test-${name}.mjs:282:10`;
    assert.equal(parseEngineFailure(log)?.invariant, name);
    assert.equal(parseEngineFailure(log)?.test, `scripts/test-${name}.mjs`);
  }
  for (const name of ["us-market", "catalog-publication", "recommendation-calibration", "ci-portability"]) {
    assert.equal(parseEngineFailure(`> node scripts/test-${name}.mjs\nAssertionError [ERR_ASSERTION]: contract`), null);
  }
  assert.equal(parseEngineFailure("> node scripts/test-recommendation-metamorphic.mjs\nError: Cannot find module"), null);
  assert.equal(parseEngineFailure(`${failure}\n> node scripts/test-us-market.mjs\nAssertionError [ERR_ASSERTION]: wrong market`), null);
  assert.equal(parseEngineFailure("AssertionError [ERR_ASSERTION]: unknown provenance"), null);
});
