import copy,json,sys,unittest,tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch as mock_patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import dependency_maintenance as d

class Policy(unittest.TestCase):
 def test_due_review_creates_manifest_only_candidate_without_model_calls(self):
  with tempfile.TemporaryDirectory() as folder:
   base=Path(folder);work=base/'de/attempt-review';work.mkdir(parents=True)
   patch={'package':d.PACKAGE,'active':True,'upstreamVersion':'4.3.0',
     'introducedAt':'2026-10-24T00:00:00Z','warnAt':'2026-10-31T00:00:00Z',
     'expiresAt':'2026-11-14T00:00:00Z','sha256':'a'*64,'advisories':['advisory']}
   manifest=work/'config/dependency-patches.json';manifest.parent.mkdir();manifest.write_text(json.dumps({'schemaVersion':1,'patches':[patch]}))
   security={'workspace':str(work),'checkedAt':'2026-10-31T00:17:00Z','digest':'b'*64,
     'highOrCritical':{},'regressionCases':54,'remediated':['advisory'],
     'patches':[{'package':d.PACKAGE,'status':'attention','expiresAt':patch['expiresAt']}]}
   calls=[]
   def load(path,default=None):return json.loads(path.read_text()) if path.exists() else default
   def save(path,value):path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value))
   def git(work,*args):calls.append(('git',args));return 'head' if args==('rev-parse','HEAD') else ''
   m=SimpleNamespace(BASE=base,load=load,save=save,
     run=lambda args,**kw:SimpleNamespace(stdout=json.dumps([{'status':'attention','candidate':None,'latest':'4.3.0','expiresAt':patch['expiresAt']}])) ,
     now=lambda:'2026-10-31T00:18:00Z',new_workspace=lambda *a:work,
     boundary=lambda w,b,paths:calls.append(('boundary',paths)),
     validate=lambda *a:(True,''),browser=lambda *a:calls.append(('browser',)),
     git=git,Deferred=type('Deferred',(Exception,),{}))
   with mock_patch.object(d,'poll_retirement',side_effect=lambda s,o,state,m:state):
    state=d.handle('de',{'sha':'base'},security,m)
   self.assertEqual(state['kind'],'review')
   self.assertEqual(state['phase'],'publishing')
   self.assertEqual(load(manifest)['patches'][0]['expiresAt'],'2026-11-21T00:00:00Z')
   self.assertEqual([item[1] for item in calls if item[0]=='boundary'],
     [['config/dependency-patches.json'],['config/dependency-patches.json']])
 def test_review_window_needs_fresh_unchanged_patch_evidence(self):
  patch={'package':d.PACKAGE,'active':True,'upstreamVersion':'4.3.0',
    'introducedAt':'2026-10-24T00:00:00Z','warnAt':'2026-10-31T00:00:00Z',
    'expiresAt':'2026-11-14T00:00:00Z','sha256':'a'*64,'advisories':['advisory']}
  manifest={'schemaVersion':1,'patches':[patch]}
  upstream={'status':'attention','candidate':None,'latest':'4.3.0'}
  security={'checkedAt':'2026-10-31T00:17:00Z','digest':'b'*64,'highOrCritical':{},
    'regressionCases':54,'remediated':['advisory'],
    'patches':[{'package':d.PACKAGE,'status':'attention','expiresAt':patch['expiresAt']}]}
  reviewed=d.reviewed_patch_manifest(manifest,upstream,security,'2026-10-31T00:18:00Z')
  changed=reviewed['patches'][0]
  self.assertEqual((changed['introducedAt'],changed['warnAt'],changed['expiresAt']),
    ('2026-10-31T00:00:00Z','2026-11-14T00:00:00Z','2026-11-21T00:00:00Z'))
  self.assertEqual(changed['firstIntroducedAt'],patch['introducedAt'])
  self.assertEqual(changed['reviewHistory'][0]['auditDigest'],'b'*64)
  self.assertEqual(manifest['patches'][0],patch)
  for bad_upstream,bad_security,now in [
    ({**upstream,'candidate':'4.3.1'},security,'2026-10-31T00:18:00Z'),
    (upstream,{**security,'highOrCritical':{'new':{}}},'2026-10-31T00:18:00Z'),
    (upstream,{**security,'checkedAt':'2026-10-30T20:00:00Z'},'2026-10-31T00:18:00Z'),
    (upstream,security,'2026-10-30T23:59:00Z')]:
   with self.assertRaises(ValueError):d.reviewed_patch_manifest(manifest,bad_upstream,bad_security,now)

 def test_review_pr_rechecks_upstream_and_audit_before_merge(self):
  for mode in ('safe','new_release','new_advisory'):
   with tempfile.TemporaryDirectory() as folder:
    base=Path(folder);work=base/'de/attempt-review';work.mkdir(parents=True)
    state={'kind':'review','phase':'pr_checks','workspace':str(work),'base':'base',
      'head':'head','version':'review:2026-11-14','upstreamVersion':'4.3.0',
      'regressionCases':54,'reviewExpiresAt':'2026-11-21T00:00:00Z',
      'prNumber':1,'prUrl':'https://github.com/owner/repo/pull/1'}
    calls=[]
    def api(path):
     if '/pulls/' in path:return {'head':{'sha':'head'},'base':{'sha':'base'},'state':'open','merged':False}
     if path.endswith('/commits/main'):return {'sha':'base'}
     if '/check-runs?' in path:return {'check_runs':[{'status':'completed','conclusion':'success'}]}
     if '/actions/runs?' in path:return {'workflow_runs':[{'path':'.github/workflows/ci.yml','status':'completed','conclusion':'success'}]}
     if path.endswith('/status'):return {'statuses':[{'state':'success'}]}
     raise AssertionError(path)
    def run(args,**kw):
     if args[-1]=='upstream':return SimpleNamespace(stdout=json.dumps([{'latest':'4.3.0','candidate':'4.3.1' if mode=='new_release' else None}]))
     if args[-1]=='audit':return SimpleNamespace(stdout=json.dumps({'highOrCritical':{'new':{}} if mode=='new_advisory' else {},'regressionCases':54}))
     calls.append('merge');return SimpleNamespace(stdout=json.dumps({'merged':True,'sha':'merged'}))
    m=SimpleNamespace(BASE=base,git=lambda w,*args:'head' if args==('rev-parse','HEAD') else '',
      api=api,repo=lambda s:'owner/repo',run=run,save=lambda *a:None,
      boundary=lambda *a:calls.append('boundary'),browser=lambda *a:calls.append('browser'),
      verify_publication=lambda *a:{'healthy':True},notify=lambda *a:calls.append('notify'),now=lambda:'now')
    if mode=='safe':
     self.assertEqual(d.poll_retirement('de',{'sha':'base'},state,m)['action'],'dependency_patch_reviewed')
     self.assertEqual(calls.count('merge'),1)
    else:
     with self.assertRaises(ValueError):d.poll_retirement('de',{'sha':'base'},state,m)
     self.assertNotIn('merge',calls)
 def test_superseded_review_pr_closes_and_retries_once(self):
  with tempfile.TemporaryDirectory() as folder:
   base=Path(folder);work=base/'de/attempt-review';work.mkdir(parents=True)
   state={'kind':'review','phase':'pr_checks','workspace':str(work),'base':'base',
     'head':'head','version':'review:2026-11-14','attempts':1,'prNumber':1}
   record=[]
   def load(path,default=None):return state if path.name=='dependency-retirement.json' else default
   m=SimpleNamespace(BASE=base,load=load,save=lambda *a:None,
     run=lambda args,**kw:(record.append(args),SimpleNamespace(returncode=0))[1],
     repo=lambda s:'owner/repo',now=lambda:'now',notify=lambda *a:record.append('notify'),
     Deferred=type('Deferred',(Exception,),{}))
   with mock_patch.object(d,'poll_retirement',side_effect=ValueError('retirement_base_advanced')):
    result=d.handle('de',{'sha':'advanced'},{},m)
   self.assertEqual(result['action'],'dependency_patch_review_retry_next_check')
   self.assertEqual(result['reason'],'retirement_base_advanced')
   self.assertEqual(state['phase'],'retry_next_check')
   self.assertEqual(record[0][:3],['gh','pr','close'])
   self.assertNotIn('notify',record)
 def test_renewed_patch_closes_old_deadline_alert_without_hiding_retirement_failure(self):
  with tempfile.TemporaryDirectory() as folder:
   notifications=[]
   state={}
   upstream={'status':'active','latest':'4.3.0','expiresAt':'2026-11-14T00:00:00Z'}
   m=SimpleNamespace(BASE=Path(folder),load=lambda p,default=None: state if p.name=='dependency-retirement.json' else default,
     save=lambda *a:None,run=lambda *a,**kw: SimpleNamespace(stdout=json.dumps([upstream])),
     now=lambda:'now',notify=lambda *a:notifications.append(a))
   evidence={'workspace':folder,'highOrCritical':{}}
   self.assertIsNone(d.handle('de',{'sha':'head'},evidence,m))
   self.assertEqual(notifications,[('dependency-de',)])
   notifications.clear()
   state['phase']='needs_attention'
   self.assertIsNone(d.handle('de',{'sha':'head'},evidence,m))
   self.assertEqual(notifications,[])
   state.clear()
   upstream['status']='attention'
   self.assertEqual(d.handle('de',{'sha':'head'},evidence,m,check_only=True)['action'],'dependency_patch_review_due')
   self.assertEqual(notifications,[])
   notifications.clear()
   upstream.update(status='active',candidate='4.4.0')
   self.assertIsNone(d.handle('de',{'sha':'head'},evidence,m,check_only=True))
   self.assertEqual(notifications,[])
 def test_nameless_italian_project_preserves_directory_derived_lock_name(self):
  fixture=json.loads((Path(__file__).parent/'fixtures/transitive-security-20261006.json').read_text())
  with tempfile.TemporaryDirectory() as folder:
   work=Path(folder);before=fixture['before'];after=fixture['after'];after['name']=work.name
   (work/'package.json').write_text('{}\n');(work/'package-lock.json').write_text(json.dumps(before))
   def save(path,value):path.write_text(json.dumps(value))
   def run(*args,**kw):save(work/'package-lock.json',after)
   m=SimpleNamespace(load=lambda p:json.loads(p.read_text()),save=save,run=run)
   self.assertEqual(d.update_compatible_transitives(work,{'sharp':{'fixAvailable':True},'source-map-js':{'fixAvailable':True}},m),['package-lock.json'])
   self.assertEqual(m.load(work/'package-lock.json')['name'],before['name'])
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
 def test_audited_stable_minor_update_passes_without_accepting_major_or_zero_minor(self):
  before={'packages':{'':{'dependencies':{'undici':'^8.10.0'}},
    'node_modules/undici':{'version':'8.10.2','resolved':'https://registry.npmjs.org/undici/-/undici-8.10.2.tgz','integrity':'sha512-AA=='}}}
  after=copy.deepcopy(before)
  after['packages']['node_modules/undici'].update(version='8.12.3',
    resolved='https://registry.npmjs.org/undici/-/undici-8.12.3.tgz',integrity='sha512-BB==')
  self.assertEqual(d.assert_transitive_patch_update(before,after,['undici']),['node_modules/undici'])
  for version in ('9.0.0','8.9.3'):
   invalid=copy.deepcopy(after);invalid['packages']['node_modules/undici']['version']=version
   with self.assertRaises(ValueError):d.assert_transitive_patch_update(before,invalid,['undici'])
  zero_before=copy.deepcopy(before);zero_after=copy.deepcopy(after)
  zero_before['packages']['node_modules/undici']['version']='0.35.2'
  zero_after['packages']['node_modules/undici']['version']='0.36.0'
  with self.assertRaises(ValueError):d.assert_transitive_patch_update(zero_before,zero_after,['undici'])
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
  patch={'active':True,'package':d.PACKAGE,'upstreamVersion':'4.2.0','expiresAt':'2026-10-24T00:00:00Z','sha256':'pinned'}
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
  before,after=self.fixture()
  before['config/dependency-patches.json']['patches'][0]['upstreamVersion']='4.3.0'
  after['config/dependency-patches.json']['patches'][0]['upstreamVersion']='4.3.0'
  after['config/dependency-patches.json']['patches'][0]['replacedBy']='4.3.1'
  after['package.json']['dependencies'][d.PACKAGE]='4.3.1'
  after['package-lock.json']['packages']['']['dependencies'][d.PACKAGE]='4.3.1'
  after['package-lock.json']['packages']['node_modules/'+d.PACKAGE].update(
    version='4.3.1',resolved='https://registry.npmjs.org/http-cache-semantics/-/http-cache-semantics-4.3.1.tgz')
  d.assert_retirement(before,after,'4.3.1')
  with self.assertRaises(ValueError):d.assert_retirement(before,after,'4.3.0')
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
