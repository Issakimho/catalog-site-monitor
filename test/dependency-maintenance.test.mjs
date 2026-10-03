import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { publicationPlan } from '../scripts/engine-auto-repair.mjs';
test('dependency retirement guards, retry evidence, CI gates and restart checks', () => {
  execFileSync('python3', ['test/test_dependency_maintenance.py'], { stdio: 'pipe' });
});
test('patched dependency audit keeps engine validation offline and audits online', () => {
  const scripts = { 'verify:publication': 'npm test && npm run build && npm run audit:dependencies', 'audit:dependencies': 'node scripts/dependency-patches.mjs audit' };
  assert.deepEqual(publicationPlan({ scripts }), { offline: 'npm test && npm run build', audit: ['run', 'audit:dependencies'] });
  assert.throws(() => publicationPlan({ scripts: { ...scripts, 'audit:dependencies': 'echo skip' } }));
});
