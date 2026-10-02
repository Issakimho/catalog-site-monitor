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


test('a cached issue prevents duplicate alerts when the list has not caught up', () => {
  execFileSync('python3', ['-c', `
import importlib.util,json,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('alerts', 'scripts/raspberry_alerts.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
 cache=Path(tmp)/'alert.json';title='incident';marker='<!-- marker -->'
 issue={'number':12,'title':title,'body':marker,'user':{'login':'Issakimho'},'state':'open'}
 m.remember_alert(cache,'https://github.com/Issakimho/catalog-site-monitor/issues/12')
 def delayed(args): return json.dumps(issue if args[-1].endswith('/12') else [])
 assert m.find_alerts(delayed,cache,title,marker)==[issue]
 issue['state']='closed'
 assert m.find_alerts(delayed,cache,title,marker)==[]
 issue['state']='open';issue['body']='foreign'
 assert m.find_alerts(delayed,cache,title,marker)==[]
`], { stdio: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
});
