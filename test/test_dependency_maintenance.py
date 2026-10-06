import copy,json,sys,unittest,tempfile
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import dependency_maintenance as d

class Policy(unittest.TestCase):
 def test_new_transitive_capability_reopens_old_escalation_once(self):
  state={'attempts':2,'phase':'needs_attention','reason':'outside_automatic_repair_scope'}
  findings={'sharp':{'fixAvailable':True}}
  self.assertTrue(d.renew_transitive_policy_budget(state,findings,'time'))
  self.assertEqual(state['attempts'],0)
  state.update(attempts=2,phase='needs_attention',reason='outside_automatic_repair_scope')
  self.assertFalse(d.renew_transitive_policy_budget(state,findings,'time'))
  self.assertEqual(state['attempts'],2)
  self.assertFalse(d.renew_transitive_policy_budget({'reason':'validation_failed'},findings,'time'))
  self.assertFalse(d.renew_transitive_policy_budget({'reason':'outside_automatic_repair_scope'},{'sharp':{'fixAvailable':False}},'time'))
 def test_real_sharp_and_source_map_patch_updates_preserve_contract(self):
  fixture=json.loads((Path(__file__).parent/'fixtures/transitive-security-20261006.json').read_text())
  changed=d.assert_transitive_patch_update(fixture['before'],fixture['after'],['sharp','source-map-js'])
  self.assertIn('node_modules/sharp',changed)
  self.assertIn('node_modules/source-map-js',changed)
  self.assertIn('node_modules/@img/sharp-linux-arm64',changed)
 def test_transitive_updates_reject_unrelated_major_downgrade_registry_and_manifest_changes(self):
  fixture=json.loads((Path(__file__).parent/'fixtures/transitive-security-20261006.json').read_text())
  changes=[lambda x:x['packages']['node_modules/astro'].update(version='7.3.3'),
   lambda x:x['packages']['node_modules/sharp'].update(version='0.36.0'),
   lambda x:x['packages']['node_modules/sharp'].update(version='0.35.3'),
   lambda x:x['packages']['node_modules/sharp'].update(resolved='https://attacker.test/sharp.tgz'),
   lambda x:x['packages'][''].update(scripts={'test':'skip'}),
   lambda x:x['packages'].pop('node_modules/source-map-js'),
   lambda x:x['packages']['node_modules/sharp'].update(hasInstallScript=False)]
  for change in changes:
   after=copy.deepcopy(fixture['after']);change(after)
   with self.assertRaises(ValueError):d.assert_transitive_patch_update(fixture['before'],after,['sharp','source-map-js'])
 def test_transitive_targets_require_explicit_in_range_fix(self):
  self.assertEqual(d.compatible_transitive_targets({'sharp':{'fixAvailable':True}}),['sharp'])
  for advisories in [{'sharp':{'fixAvailable':False}},{'sharp':{'fixAvailable':{'version':'0.36.0'}}},{'--force':{'fixAvailable':True}},{'pkg;command':{'fixAvailable':True}}]:
   with self.assertRaises(ValueError):d.compatible_transitive_targets(advisories)
 def fixture(self):
  pkg={'dependencies':{d.PACKAGE:'file:vendor/'+d.PACKAGE,'astro':'^7.0.7'},'overrides':{d.PACKAGE:'$'+d.PACKAGE},'scripts':{'test':'trusted'}}
  patch={'active':True,'package':d.PACKAGE,'expiresAt':'2026-10-24T00:00:00Z','sha256':'pinned'}
  lock={'packages':{'':{'dependencies':copy.deepcopy(pkg['dependencies'])},'node_modules/'+d.PACKAGE:{'resolved':'vendor/'+d.PACKAGE,'link':True},'vendor/'+d.PACKAGE:{'version':'4.2.0'},'node_modules/astro':{'version':'7.3.2'}}}
  before={'package.json':pkg,'package-lock.json':lock,'config/dependency-patches.json':{'patches':[patch]}}
  after=copy.deepcopy(before);p=after['package.json'];del p['overrides'];p['dependencies'][d.PACKAGE]='4.2.1'
  after['config/dependency-patches.json']['patches'][0].update(active=False,replacedBy='4.2.1',retiredAt='2026-10-04T12:00:00Z')
  after['package-lock.json']['packages']['']['dependencies'][d.PACKAGE]='4.2.1'
  after['package-lock.json']['packages'].pop('vendor/'+d.PACKAGE)
  after['package-lock.json']['packages']['node_modules/'+d.PACKAGE]={'version':'4.2.1','resolved':'https://registry.npmjs.org/http-cache-semantics/-/http-cache-semantics-4.2.1.tgz','integrity':'sha512-Zml4dHVyZQ=='}
  return before,after
 def test_only_official_dependency_and_retirement_metadata_change(self):
  before,after=self.fixture();d.assert_retirement(before,after,'4.2.1')
  mutations=[lambda x:x['package.json']['scripts'].update(test='skip'),lambda x:x['config/dependency-patches.json']['patches'][0].update(expiresAt='2027-01-01'),lambda x:x['package-lock.json']['packages']['node_modules/astro'].update(version='2.10.9'),lambda x:x['package-lock.json']['packages']['node_modules/'+d.PACKAGE].update(resolved='https://attacker.test/package.tgz')]
  for mutate in mutations:
   changed=copy.deepcopy(after);mutate(changed)
   with self.assertRaises(ValueError):d.assert_retirement(before,changed,'4.2.1')
 def test_two_attempts_per_official_version(self):
  self.assertTrue(d.can_attempt({},'4.2.1'));self.assertTrue(d.can_attempt({'version':'4.2.1','attempts':1},'4.2.1'))
  self.assertFalse(d.can_attempt({'version':'4.2.1','attempts':2},'4.2.1'))
  self.assertTrue(d.can_attempt({'version':'4.2.1','attempts':2},'4.2.2'))
 def test_new_compatible_fix_reopens_once_without_retrying_same_evidence(self):
  state={'attempts':2,'phase':'needs_attention'}
  def finding(v,major=False):return {'astro':{'fixAvailable':{'name':'astro','version':v,'isSemVerMajor':major}}}
  self.assertFalse(d.renew_dependency_budget(state,finding('7.3.4'),'sha','time'))
  self.assertFalse(d.renew_dependency_budget(state,finding('7.3.4'),'sha','time'))
  self.assertFalse(d.renew_dependency_budget(state,finding('2.10.9',True),'sha','time'))
  self.assertTrue(d.renew_dependency_budget(state,finding('7.3.5'),'sha','time'))
  state['attempts']=2
  self.assertFalse(d.renew_dependency_budget(state,finding('7.3.4'),'sha','time'))
  self.assertFalse(d.renew_dependency_budget(state,finding('7.3.5'),'sha','time'))
  self.assertEqual(state['attempts'],2)
 def test_no_fix_then_published_fix_reopens_an_exhausted_incident(self):
  state={'attempts':2,'phase':'needs_attention'}
  self.assertFalse(d.renew_dependency_budget(state,{'package':{'fixAvailable':False}},'base','time'))
  fix={'package':{'fixAvailable':{'name':'package','version':'1.0.1','isSemVerMajor':False}}}
  self.assertTrue(d.renew_dependency_budget(state,fix,'base','time'))
  self.assertEqual(state['attempts'],0)
 def test_npm_in_range_fix_becoming_available_reopens_once(self):
  state={'attempts':2,'phase':'needs_attention'}
  self.assertFalse(d.renew_dependency_budget(state,{'package':{'fixAvailable':False}},'base','time'))
  self.assertTrue(d.renew_dependency_budget(state,{'package':{'fixAvailable':True}},'base','time'))
  state['attempts']=2
  self.assertFalse(d.renew_dependency_budget(state,{'package':{'fixAvailable':True}},'base','time'))
  self.assertEqual(state['attempts'],2)
 def test_failed_official_candidate_stops_after_two_real_controller_attempts(self):
  with tempfile.TemporaryDirectory() as folder:
   base=Path(folder);saved={};calls=[];before,after=self.fixture()
   class Deferred(Exception):pass
   def load(path,default=None):return copy.deepcopy(saved.get(str(path),default)) if not Path(path).exists() else json.loads(Path(path).read_text())
   def save(path,value):saved[str(path)]=copy.deepcopy(value)
   def workspace(site,sha):
    work=base/site/('attempt-'+str(len(calls)));calls.append('workspace');work.mkdir(parents=True)
    for name,value in before.items():p=work/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(value))
    return work
   def run(args,cwd=None,**kw):
    if args[-1]=='upstream':return SimpleNamespace(stdout=json.dumps([{'status':'active','candidate':'4.2.1','latest':'4.2.1'}]))
    if args[-2:]==['retire','4.2.1']:
     for name,value in after.items():(cwd/name).write_text(json.dumps(value))
     return SimpleNamespace(stdout='{}')
    raise AssertionError(args)
   m=SimpleNamespace(BASE=base,load=load,save=save,run=run,new_workspace=workspace,now=lambda:'time',boundary=lambda *a:None,validate=lambda *a:(False,'new release still vulnerable'),notify=lambda *a:None,Deferred=Deferred)
   for _ in range(3):
    result=d.handle('de',{'sha':'base'},{'workspace':str(base),'highOrCritical':{}},m)
    self.assertEqual(result['action'],'dependency_retirement_needs_attention')
   self.assertEqual(calls,['workspace','workspace'])
   self.assertEqual(saved[str(base/'de/dependency-retirement.json')]['attempts'],2)
 def test_pr_pending_failed_replaced_or_advanced_never_merges(self):
  for mode in ['pending','failed','advanced','head','success','already_merged']:
   with tempfile.TemporaryDirectory() as folder:
    base=Path(folder);work=base/'de/attempt-fixture';work.mkdir(parents=True)
    state={'phase':'pr_checks','workspace':str(work),'base':'base','head':'head','version':'4.2.1','prNumber':1,'prUrl':'https://github.com/owner/repo/pull/1'}
    calls=[]
    def api(path):
     if '/pulls/' in path:return {'head':{'sha':'wrong' if mode=='head' else 'head'},'base':{'sha':'base'},'state':'open','merged':mode=='already_merged','merge_commit_sha':'merged'}
     if path.endswith('/commits/main'):return {'sha':'base'}
     if '/check-runs?' in path:return {'check_runs':[{'status':'in_progress' if mode=='pending' else 'completed','conclusion':'failure' if mode=='failed' else 'success'}]}
     if '/actions/runs?' in path:return {'workflow_runs':[{'path':'.github/workflows/ci.yml','status':'completed','conclusion':'success'}]}
     if path.endswith('/status'):return {'statuses':[{'state':'success'}]}
     raise AssertionError(path)
    def run(args,**kw):calls.append('merge');return SimpleNamespace(stdout=json.dumps({'merged':True,'sha':'merged'}))
    m=SimpleNamespace(BASE=base,git=lambda w,*args:'head' if args==('rev-parse','HEAD') else '',api=api,repo=lambda s:'owner/repo',run=run,save=lambda *a:None,browser=lambda *a:calls.append('browser'),verify_publication=lambda *a:{'healthy':True},notify=lambda *a:calls.append('notify'),now=lambda:'now')
    if mode in ['failed','advanced','head']:
     with self.assertRaises(ValueError):d.poll_retirement('de',{'sha':'new' if mode=='advanced' else 'base'},state,m)
     self.assertNotIn('merge',calls)
    else:
     result=d.poll_retirement('de',{'sha':'base'},state,m)
     self.assertEqual(result['action'],'dependency_retirement_pending_ci' if mode=='pending' else 'dependency_patch_retired')
     self.assertEqual(calls.count('merge'),1 if mode=='success' else 0)
if __name__=='__main__':unittest.main()
