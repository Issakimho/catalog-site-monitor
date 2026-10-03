import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { collectorRecipe, mayRepairCollector, collectorRegression, entrypointProbe,
  repairCollectorLauncher, assertCollectorPatch, publicationRunsCollectorTest,
  publishCollectorRepair, resumeCollectorPublication } from '../scripts/collector-repair.mjs';
import { decideRecovery, assertCollectionEvidence } from '../scripts/local-recovery.mjs';
const old = 'process.env.AMAZON_ENV_PATH ??= ".env.amazon.de.local";\nprocess.env.AMAZON_CATALOG_LOCALE ??= "de-DE";\n\nawait import("./fetch-amazon-catalog.mjs");\n';
const file = 'scripts/fetch-amazon-de-catalog.mjs';
const script = `node ${file}`;
const H = 3600000;

test('only the exact import-only launcher is repairable; supplier errors and other code are excluded', () => {
  const recipe = collectorRecipe('de', old, script);
  assert.ok(recipe.replacement.endsWith('await main();\n'));
  for (const source of [old + 'fetch("https://example.test");', old.replace('de-DE', 'fr-FR'), recipe.replacement]) {
    assert.equal(collectorRecipe('de', source, script), null);
  }
  assert.equal(collectorRecipe('fr', old, script), null);
  assert.equal(collectorRecipe('de', old, 'node scripts/fetch-amazon-catalog.mjs'), null);
  const options = { step: 'collection_evidence', code: 'collection_report_missing', beforeHash: 'a', afterHash: 'a', base: 'b', now: 30 * H };
  assert.equal(mayRepairCollector(options), true);
  for (const patch of [{ step: 'run fetch:amazon-catalog' }, { code: 'credentials_missing' }, { code: 'request_failed' }, { afterHash: 'changed' },
    { previous: { base: 'b', startedAt: new Date(29 * H).toISOString() } }]) assert.equal(mayRepairCollector({ ...options, ...patch }), false);
  assert.equal(mayRepairCollector({ ...options, previous: { base: 'b', startedAt: new Date(5 * H).toISOString() } }), true);
});

test('resuming a collector PR never consumes or bypasses supplier retries', () => {
  for (const status of ['publishing', 'pr_checks']) {
    const state = { attempts: [1, 2], collectorRepair: { status, workspace: '/private/attempt-1' } };
    assert.equal(decideRecovery({ status: 'healthy', ageHours: 2 }, state, 3), 'resume_collector_pr');
    assert.equal(decideRecovery({}, { ...state, pendingSha: 'merged' }, 3), 'verify_pending');
    assert.deepEqual(state.attempts, [1, 2]);
  }
  assert.equal(decideRecovery({}, { attempts: [1, 2], collectorRepair: { status: 'needs_attention' } }, 3), 'retry_limit');
});

test('a dormant regression script is not sufficient CI coverage', () => {
  const scripts = { 'verify:publication': 'npm run quality && npm audit --audit-level=high', quality: 'npm run test:catalog-autonomy', 'test:catalog-autonomy': 'node scripts/test-catalog-autonomy.mjs' };
  assert.equal(publicationRunsCollectorTest(scripts), true);
  assert.equal(publicationRunsCollectorTest({ ...scripts, quality: 'npm run quality' }), false);
  assert.equal(publicationRunsCollectorTest({ ...scripts, quality: 'echo node scripts/test-catalog-autonomy.mjs' }), false);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'collector-repair-'));
  const work = join(root, 'work'), remote = join(root, 'remote.git'), bin = join(root, 'bin');
  await mkdir(work); await mkdir(bin);
  for (const dir of ['scripts', 'demo', 'public/data']) await mkdir(join(work, dir), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: work, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  await writeFile(join(work, 'package.json'), JSON.stringify({ type: 'module', scripts: { 'fetch:amazon-catalog': script, 'verify:publication': 'node scripts/test-catalog-autonomy.mjs' } }));
  await writeFile(join(work, file), old);
  await writeFile(join(work, 'scripts/fetch-amazon-catalog.mjs'), 'export async function main() { console.error("Amazon-Konfiguration unvollständig"); process.exitCode = 1; }\n');
  await writeFile(join(work, 'scripts/test-catalog-autonomy.mjs'), 'import assert from "node:assert/strict";\nassert.equal(1, 1);\n');
  await writeFile(join(work, 'demo/amazon-products.mjs'), 'export const products = [];\n');
  const snapshot = Buffer.from(JSON.stringify({ schemaVersion: 2, generatedAt: new Date().toISOString(), catalogVersion: `sha256:${'a'.repeat(64)}`, totals: { published: 20 }, products: Array.from({ length: 20 }, () => ({ timestamps: { lastSeenAt: new Date().toISOString() } })) }));
  const catalog = JSON.parse(snapshot);
  await writeFile(join(work, 'public/data/catalog-current.json'), snapshot);
  await writeFile(join(work, 'public/data/catalog-manifest.json'), JSON.stringify({ schemaVersion: 2, publishedAt: catalog.generatedAt, catalogVersion: catalog.catalogVersion, totals: catalog.totals,
    snapshot: { bytes: snapshot.length, sha256: createHash('sha256').update(snapshot).digest('hex') } }));
  git('add', '.'); git('commit', '-m', 'broken launcher');
  const base = git('rev-parse', 'HEAD');
  git('init', '--bare', remote); git('remote', 'add', 'origin', remote); git('push', 'origin', 'main');
  const config = { repository: 'fixture/catalog', demo: 'demo/amazon-products.mjs' };
  const site = { id: 'de', data: '/data/', minFresh: 20, maxAgeHours: 16 };
  const run = async (_program, args) => execFileSync(args[0] === 'node' ? process.execPath : args[0], args.slice(1), { cwd: work, encoding: 'utf8', stdio: 'pipe', env: { PATH: process.env.PATH } });
  return { root, work, remote, bin, git, base, config, site, run, data: [config.demo, 'public/data/catalog-current.json', 'public/data/catalog-manifest.json'] };
}

test('actual CLI regression fails on the old launcher, passes on the recipe, and freezes every other file', async () => {
  const f = await fixture();
  try {
    const recipe = collectorRecipe('de', old, script);
    assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', entrypointProbe(file, 'fixed')], { cwd: f.work, stdio: 'pipe' }));
    let starts = 0;
    const applied = await repairCollectorLauncher({ work: f.work, id: 'de', run: f.run, sandbox: () => [], onStart: async () => { starts++; } });
    assert.equal(starts, 1); assert.deepEqual(applied, recipe);
    await assertCollectorPatch(f.work, 'de', f.base, f.data);
    // Real collection evidence is still mandatory after a successful code repair.
    assert.throws(() => assertCollectionEvidence(null, 'de', Date.now(), 'a', 'a'));
    const originalTest = f.git('show', `${f.base}:scripts/test-catalog-autonomy.mjs`) + '\n';
    assert.equal(await readFile(join(f.work, 'scripts/test-catalog-autonomy.mjs'), 'utf8'), originalTest + collectorRegression(recipe));
    await writeFile(join(f.work, 'package.json'), '{}');
    await assert.rejects(assertCollectorPatch(f.work, 'de', f.base, f.data), /out_of_scope/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('failed validation rolls back the recipe without weakening the old tests', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    await assert.rejects(repairCollectorLauncher({ work: f.work, id: 'de', sandbox: () => [], onStart: async () => {}, run: async () => { if (++calls === 3) throw Error('regression_failed'); } }), /regression_failed/);
    assert.equal(await readFile(join(f.work, file), 'utf8'), old);
    assert.equal(f.git('status', '--porcelain'), '');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

const ghFixture = `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process');
const cfg = JSON.parse(fs.readFileSync(process.env.COLLECTOR_TEST_CONFIG));
const state = fs.existsSync(cfg.state) ? JSON.parse(fs.readFileSync(cfg.state)) : { creates: 0, merges: 0 };
const args = process.argv.slice(2), route = args[1] || '';
const git = (...a) => cp.execFileSync('git', a, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
const save = () => fs.writeFileSync(cfg.state, JSON.stringify(state));
const out = x => console.log(JSON.stringify(x));
if (args[0] === 'pr' && args[1] === 'create') {
 const sha = git('rev-parse','HEAD');
 state.creates++;
 state.pr = { number: 1, state: 'open', merged: false, head: {sha}, base: {sha: cfg.base}, html_url: 'https://github.com/fixture/catalog/pull/1' };
 if (cfg.advance) {
  const advanced = git('commit-tree', 'HEAD^{tree}', '-p', cfg.base, '-m', 'concurrent publication');
  git('push','origin',advanced+':refs/heads/main');
 }
 save();
 if (cfg.crashCreate && state.creates === 1) process.exit(1);
 console.log(state.pr.html_url);
} else if (route.includes('/pulls?')) out(state.pr ? [state.pr] : []);
else if (route.endsWith('/pulls/1')) out(state.pr);
else if (route.endsWith('/check-runs?per_page=100')) out({check_runs:[{status:'completed', conclusion:cfg.fail ? 'failure' : 'success'}]});
else if (route.includes('/actions/runs?')) out({workflow_runs:[{path:'.github/workflows/ci.yml',event:'pull_request',status:'completed',conclusion:cfg.fail?'failure':'success'}]});
else if (route.endsWith('/pulls/1/merge')) {
 if (cfg.fail) throw Error('must not merge failed CI');
 const sha=git('commit-tree','HEAD^{tree}','-p',cfg.base,'-m','verified collector repair');
 git('push','origin',sha+':refs/heads/main');
 state.merges++; state.pr={...state.pr, state:'closed',merged:true,merge_commit_sha:sha};save();out({merged:true,sha});
} else throw Error('unexpected fixture route '+args.join(' '));
`;

for (const mode of ['success', 'failed-ci', 'advanced-base', 'expired-candidate', 'create-interrupted', 'merged-interrupted']) {
 test(`collector publication uses verified PR gates and resumes safely: ${mode}`, async () => {
  const f = await fixture(); const oldPath = process.env.PATH, oldConfig = process.env.COLLECTOR_TEST_CONFIG;
  try {
   await repairCollectorLauncher({ work: f.work, id: 'de', run: f.run, sandbox: () => [], onStart: async () => {} });
   const observedAt = Date.now();
   await writeFile(join(f.work, f.config.demo), 'export const products = [{ supplierObserved: true }];\n');
   assertCollectionEvidence({ schemaVersion: 1, marketplace: 'DE', collectionId: '12345678-1234-1234-1234-123456789012', observedAt: new Date(observedAt).toISOString(), queries: [{ key: 'a'.repeat(64), status: 'healthy' }] }, 'de', observedAt, 'before', 'after');
   await assertCollectorPatch(f.work, 'de', f.base, f.data);
   if (mode === 'expired-candidate') {
    const stale = JSON.parse(await readFile(join(f.work, f.data[1]), 'utf8'));
    stale.generatedAt = new Date(Date.now() - 49 * H).toISOString();
    for (const p of stale.products) p.timestamps.lastSeenAt = stale.generatedAt;
    const bytes = JSON.stringify(stale);
    const manifest = JSON.parse(await readFile(join(f.work, f.data[2]), 'utf8'));
    manifest.publishedAt = stale.generatedAt; manifest.snapshot = { bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
    await writeFile(join(f.work, f.data[1]), bytes); await writeFile(join(f.work, f.data[2]), JSON.stringify(manifest));
   }
   f.git('add', '.'); f.git('commit','-m','repaired collector and validated data');
   await writeFile(join(f.bin, 'gh'), ghFixture); await chmod(join(f.bin, 'gh'), 0o700);
   const statePath = join(f.root, 'github-state.json'), configPath = join(f.root, 'config.json');
   await writeFile(configPath, JSON.stringify({ state: statePath, base: f.base, fail: mode==='failed-ci', advance: mode==='advanced-base', crashCreate: mode==='create-interrupted' }));
   process.env.PATH = f.bin + ':' + oldPath; process.env.COLLECTOR_TEST_CONFIG = configPath;
   let saved = {}, merged = 0, verified = 0;
   const callbacks = {
    onPullRequest: async state => { saved = { ...saved, ...state }; },
    onMerged: async () => { merged++; if (mode === 'merged-interrupted' && merged === 1) throw Error('interrupted_after_merge'); },
    verifyProduction: async (_config, _site, sha) => { verified++; assert.equal(f.git('rev-parse','origin/main'), sha); return { sha }; }
   };
   const options = { work: f.work, id: 'de', base: f.base, config: f.config, site: f.site, ...callbacks };
   if (['failed-ci', 'advanced-base', 'expired-candidate'].includes(mode)) {
    await assert.rejects(publishCollectorRepair(options), mode === 'failed-ci' ? /repair_ci_failed/ : mode === 'advanced-base' ? /repair_base_advanced/ : /repair_candidate_expired/);
    assert.equal(merged, 0); assert.equal(verified, 0);
   } else {
    let result;
    if (mode.endsWith('interrupted')) {
     await assert.rejects(publishCollectorRepair(options));
     assert.ok(saved.head && saved.branch && saved.base);
     result = await resumeCollectorPublication({ ...options, ...saved });
    } else result = await publishCollectorRepair(options);
    assert.equal(result.status, 'recovered'); assert.equal(verified, 1);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.creates, 1); assert.equal(state.merges, 1);
    assert.equal(f.git('status','--porcelain'), '');
   }
  } finally {
   process.env.PATH = oldPath;
   if (oldConfig === undefined) delete process.env.COLLECTOR_TEST_CONFIG; else process.env.COLLECTOR_TEST_CONFIG = oldConfig;
   await rm(f.root, { recursive: true, force: true });
  }
 });
}
