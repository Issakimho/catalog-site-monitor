import test from 'node:test';
import { execFileSync } from 'node:child_process';
test('Raspberry alert closes only after verified recovery with no outstanding query', () => {
  execFileSync('python3', ['-c', `
import importlib.util
spec=importlib.util.spec_from_file_location('runner', 'scripts/raspberry-run-site.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
assert m.notification_action(0, {'decision':'healthy','canCloseIncident':True}) == 'retain'
assert m.notification_action(0, {'decision':'recovered','canCloseIncident':False}) == 'retain'
assert m.notification_action(0, {'decision':'recovered','canCloseIncident':True}) == 'close'
assert m.notification_action(0, {'decision':'recovered','attentionRequired':True}) == 'open'
assert m.notification_action(1, {}) == 'open'
assert m.notification_action(0, {}) == 'retain'
`], { stdio: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
});
