"""Bounded lifecycle of reviewed dependency backports. No model-generated patches."""
import copy,hashlib,json,re,subprocess,time
from pathlib import Path

PACKAGE='http-cache-semantics'
FILES=['package.json','package-lock.json','config/dependency-patches.json']

def compatible_transitive_targets(advisories):
    targets=sorted(name for name,item in advisories.items() if item.get('fixAvailable') is True)
    require(bool(targets) and len(targets)<=5,'no_bounded_transitive_fix')
    require(all(re.fullmatch(r'(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*',name) for name in targets),'unsafe_dependency_name')
    return targets

def renew_transitive_policy_budget(incident,advisories,now):
    if not advisories or not all(item.get('fixAvailable') is True for item in advisories.values()):return False
    compatible_transitive_targets(advisories)
    if incident.get('reason')!='outside_automatic_repair_scope' or incident.get('transitivePatchPolicy')=='patch-closure-v1':return False
    incident.setdefault('previousAttempts',[]).append({'attempts':incident.get('attempts',0),'reason':incident.get('reason'),'at':now})
    incident.update(attempts=0,phase='confirmed',transitivePatchPolicy='patch-closure-v1',reason='compatible_transitive_patch_repair')
    return True

def assert_transitive_patch_update(before,after,targets):
    """Only existing registry packages in the audited dependency closure may change."""
    require(set(before)==set(after),'lock_keys_changed')
    require({k:v for k,v in before.items() if k!='packages'}=={k:v for k,v in after.items() if k!='packages'},'lock_metadata_changed')
    old=before['packages'];new=after['packages']
    require(set(old)==set(new),'dependency_added_or_removed')
    require(old['']==new[''],'direct_dependency_contract_changed')
    allowed=set();pending=['node_modules/'+name for name in targets]
    while pending:
        path=pending.pop()
        if path in allowed:continue
        require(path in old,'audited_dependency_missing')
        allowed.add(path)
        require(len(allowed)<=100,'dependency_closure_limit')
        for field in ('dependencies','optionalDependencies'):
            for name in old[path].get(field,{}):
                # Resolve dependencies with Node's ancestor node_modules lookup.
                parent=path
                while True:
                    candidate=parent+'/node_modules/'+name
                    if candidate in old:pending.append(candidate);break
                    if '/node_modules/' not in parent:
                        candidate='node_modules/'+name
                        if candidate in old:pending.append(candidate)
                        break
                    parent=parent.rsplit('/node_modules/',1)[0]
    changed=[]
    for path,item in new.items():
        previous=old[path]
        if previous==item:continue
        require(path in allowed,'unrelated_dependency_changed')
        require(not item.get('link') and not previous.get('link'),'local_patch_changed')
        versions=[re.fullmatch(r'(\d+)\.(\d+)\.(\d+)',p.get('version','')) for p in (previous,item)]
        require(all(versions),'unsupported_dependency_version')
        a,b=[tuple(map(int,v.groups())) for v in versions]
        require(a[:2]==b[:2] and b[2]>a[2],'not_a_forward_patch_release')
        require(item.get('resolved','').startswith('https://registry.npmjs.org/'),'untrusted_dependency_registry')
        require(re.fullmatch(r'sha512-[A-Za-z0-9+/]+=*',item.get('integrity','')),'missing_dependency_integrity')
        for field in ('name','link','hasInstallScript','bin','cpu','os','engines'):
            require(item.get(field)==previous.get(field),'dependency_execution_contract_changed')
        changed.append(path)
    require(changed and all('node_modules/'+name in changed for name in targets),'audited_dependency_not_updated')
    return changed

def update_compatible_transitives(work,advisories,m):
    targets=compatible_transitive_targets(advisories)
    package=(work/'package.json').read_bytes()
    before=m.load(work/'package-lock.json')
    m.run(['npm','update',*targets,'--package-lock-only','--ignore-scripts','--no-audit','--registry=https://registry.npmjs.org'],cwd=work,timeout=600)
    require((work/'package.json').read_bytes()==package,'package_manifest_changed')
    after=m.load(work/'package-lock.json')
    # npm derives a nameless project's lock name from its temporary directory.
    # Restore that inert field before checking the complete original identity.
    if not json.loads(package).get('name') and after.get('name')==work.name and before.get('name')!=after.get('name'):
        if 'name' in before:after['name']=before['name']
        else:after.pop('name',None)
        m.save(work/'package-lock.json',after)
    assert_transitive_patch_update(before,after,targets)
    return ['package-lock.json']

def require(ok,message):
    if not ok:raise ValueError(message)

def assert_retirement(before,after,version):
    require(re.fullmatch(r'4\.2\.[1-9]\d*',version),'unsupported_retirement_version')
    package=copy.deepcopy(before['package.json'])
    require(package.get('overrides',{}).get(PACKAGE)=='$http-cache-semantics','unexpected_patch_override')
    require(package['dependencies'][PACKAGE]=='file:vendor/http-cache-semantics','unexpected_patch_dependency')
    del package['overrides'][PACKAGE]
    if not package['overrides']:del package['overrides']
    package['dependencies'][PACKAGE]=version
    require(package==after['package.json'],'retirement_changed_package_contract')
    manifest=copy.deepcopy(before['config/dependency-patches.json'])
    patched=manifest['patches'][0];actual=after['config/dependency-patches.json']['patches'][0]
    require(patched['active'] is True and actual['active'] is False,'invalid_retirement_transition')
    require(actual.get('replacedBy')==version and re.fullmatch(r'\d{4}-\d\d-\d\dT.*Z',actual.get('retiredAt','')),'missing_retirement_provenance')
    patched.update(active=False,replacedBy=version,retiredAt=actual['retiredAt'])
    require(manifest==after['config/dependency-patches.json'],'retirement_changed_patch_policy')
    old=copy.deepcopy(before['package-lock.json']);new=after['package-lock.json']
    metadata=new['packages'].get('node_modules/'+PACKAGE,{})
    require(metadata.get('version')==version and metadata.get('resolved')==f'https://registry.npmjs.org/{PACKAGE}/-/{PACKAGE}-{version}.tgz','untrusted_official_dependency')
    require(re.fullmatch(r'sha512-[A-Za-z0-9+/]+=*',metadata.get('integrity','')),'missing_official_integrity')
    old['packages']['']['dependencies'][PACKAGE]=version
    old['packages']['node_modules/'+PACKAGE]=metadata
    old['packages'].pop('vendor/'+PACKAGE,None)
    # npm may retain the now-unused local package as extraneous. It may never
    # resolve to it at runtime, and its bytes are still immutable in Git.
    cleaned=copy.deepcopy(new);unused=cleaned['packages'].pop('vendor/'+PACKAGE,None)
    if unused:require(unused.get('extraneous') is True,'vendor_still_in_dependency_graph')
    require(old==cleaned,'retirement_changed_unrelated_dependencies')

def can_attempt(state,version):
    return state.get('version')!=version or state.get('attempts',0)<2

def audit_snapshot(site,sha,m):
    root=m.fresh_root(site,sha);folder=m.BASE/site
    manifest=m.run(['git','show',sha+':config/dependency-patches.json'],cwd=root,allow_failure=True)
    if manifest.returncode:return None
    paths=m.git(root,'ls-tree','-r','--name-only',sha,'--',*FILES,'scripts/dependency-patches.mjs','scripts/test-dependency-patches.mjs','vendor/http-cache-semantics').splitlines()
    digest=hashlib.sha256()
    contents={}
    for path in paths:
        require(not path.startswith('/') and '..' not in path.split('/'),'unsafe_audit_path')
        content=subprocess.check_output(['git','show',sha+':'+path],cwd=root,env=m.ENV)
        contents[path]=content;digest.update(path.encode()+b'\0'+content)
    signature=digest.hexdigest();work=folder/'dependency-audit-input'
    cached=m.load(folder/'dependency-audit.json',{})
    if cached.get('digest')==signature and time.time()-cached.get('epoch',0)<21600:
        # Expiry remains checked even when the online advisory cache is reused.
        manifest_now=json.loads(manifest.stdout)
        if all(not p['active'] or p['warnAt'] > m.now() for p in manifest_now['patches']):return cached
    work.mkdir(parents=True,exist_ok=True)
    for path,content in contents.items():
        target=work/path;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
    m.run(['npm','ci','--ignore-scripts','--no-audit'],cwd=work,timeout=600)
    p=m.run(['node','scripts/dependency-patches.mjs','observe'],cwd=work,timeout=240,allow_failure=True)
    report=json.loads(p.stdout)
    require(p.returncode in (0,1) and isinstance(report.get('highOrCritical'),dict),'dependency_audit_unavailable')
    report.update(digest=signature,epoch=time.time(),workspace=str(work))
    m.save(folder/'dependency-audit.json',report)
    return report

def poll_retirement(site,observed,state,m):
    work=Path(state['workspace']);base=state['base'];version=state['version']
    require(work.resolve().parent==(m.BASE/site).resolve() and work.name.startswith('attempt-'),'untrusted_retirement_workspace')
    require(m.git(work,'rev-parse','HEAD')==state['head'],'retirement_head_changed')
    require(not m.git(work,'status','--porcelain'),'dirty_retirement_candidate')
    if state['phase']=='publishing':
        prs=m.api(f'repos/{m.repo(site)}/pulls?state=all&head=Issakimho:{state["branch"]}&base=main')
        if prs:
            require(len(prs)==1 and prs[0]['head']['sha']==state['head'],'ambiguous_retirement_pr')
            state['prNumber']=prs[0]['number'];state['prUrl']=prs[0]['html_url']
        else:
            m.git(work,'push','origin',state['head']+':refs/heads/'+state['branch'])
            body=m.BASE/site/'dependency-retirement-pr.md'
            body.write_text(f'Replace the temporary cache-security backport with official {PACKAGE} {version}. The original security regression tests, all site gates and candidate browser journeys pass. Catalog bytes and all other dependency versions remain unchanged.\n')
            pr=m.run(['gh','pr','create','--repo',m.repo(site),'--base','main','--head',state['branch'],'--title',f'fix(security): retire cache backport with {version}','--body-file',str(body)],cwd=work).stdout.strip()
            require(re.fullmatch(r'https://github.com/'+re.escape(m.repo(site))+r'/pull/\d+',pr),'retirement_pr_not_confirmed')
            state['prNumber']=int(pr.rsplit('/',1)[1]);state['prUrl']=pr
        state['phase']='pr_checks';m.save(m.BASE/site/'dependency-retirement.json',state)
    pr=m.api(f'repos/{m.repo(site)}/pulls/{state["prNumber"]}')
    require(pr['head']['sha']==state['head'],'retirement_pr_head_changed')
    if not pr.get('merged'):
        require(pr['state']=='open' and pr['base']['sha']==base and observed['sha']==base,'retirement_base_advanced')
        checks=m.api(f'repos/{m.repo(site)}/commits/{state["head"]}/check-runs?per_page=100')['check_runs']
        runs=m.api(f'repos/{m.repo(site)}/actions/runs?head_sha={state["head"]}&event=pull_request&per_page=100')['workflow_runs']
        ci=[r for r in runs if r['path']=='.github/workflows/ci.yml']
        statuses=m.api(f'repos/{m.repo(site)}/commits/{state["head"]}/status')['statuses']
        require(not any(c['status']=='completed' and c['conclusion'] not in ('success','neutral','skipped') for c in checks),'retirement_ci_failed')
        require(not any(s['state'] in ('error','failure') for s in statuses),'retirement_preview_failed')
        if not ci or not checks or not all(r['status']=='completed' and r['conclusion']=='success' for r in ci) or not all(c['status']=='completed' for c in checks) or any(s['state']=='pending' for s in statuses):
            return {'site':site,'action':'dependency_retirement_pending_ci','prUrl':state['prUrl']}
        # A stale catalog cannot be carried through a delayed security PR.
        m.browser('candidate',site,work)
        require(m.api(f'repos/{m.repo(site)}/commits/main')['sha']==base,'retirement_base_advanced')
        result=json.loads(m.run(['gh','api',f'repos/{m.repo(site)}/pulls/{state["prNumber"]}/merge','--method','PUT','-f','merge_method=squash','-f','sha='+state['head']]).stdout)
        require(result.get('merged') is True,'retirement_merge_failed');sha=result['sha']
    else:sha=pr['merge_commit_sha']
    state.update(phase='verify',publishedSha=sha);m.save(m.BASE/site/'dependency-retirement.json',state)
    proof=m.verify_publication(site,{'publishedSha':sha,'workspace':str(work)})
    state.update(phase='resolved',proof=proof,resolvedAt=m.now());m.save(m.BASE/site/'dependency-retirement.json',state)
    m.notify('dependency-'+site)
    return {'site':site,'action':'dependency_patch_retired','sha':sha,'prUrl':state['prUrl']}

def handle(site,observed,security,m,check_only=False):
    path=m.BASE/site/'dependency-retirement.json';state=m.load(path,{})
    try:
        if state.get('phase') in ('publishing','pr_checks','verify'):
            if check_only:return {'site':site,'action':'dependency_retirement_pending','prUrl':state.get('prUrl')}
            return poll_retirement(site,observed,state,m)
        if not security.get('workspace'):return None
        work=Path(security['workspace'])
        info=json.loads(m.run(['node','scripts/dependency-patches.mjs','upstream'],cwd=work,timeout=180).stdout)
        m.save(m.BASE/site/'dependency-upstream.json',{'checkedAt':m.now(),'patches':info})
        if not info:return None
        p=info[0]
        if p['status'] in ('attention','expired') and not p.get('candidate'):
            m.notify('dependency-'+site,{'reason':'temporary_patch_'+p['status'],'attempts':state.get('attempts',0),'diagnosis':'Version officielle disponible : '+p['latest']+'. Échéance fixe : '+p['expiresAt']})
        version=p.get('candidate')
        if not version or check_only:return None
        if not can_attempt(state,version):return {'site':site,'action':'dependency_retirement_needs_attention','reason':state.get('reason')}
        attempts=state.get('attempts',0) if state.get('version')==version else 0
        state={'version':version,'attempts':attempts+1,'phase':'validating','base':observed['sha'],'startedAt':m.now()}
        m.save(path,state)
        require(not security['highOrCritical'],'new_advisory_blocks_retirement')
        candidate=m.new_workspace(site,observed['sha']);state['workspace']=str(candidate);m.save(path,state)
        before={name:m.load(candidate/name) for name in FILES}
        m.run(['node','scripts/dependency-patches.mjs','retire',version],cwd=candidate,timeout=240)
        after={name:m.load(candidate/name) for name in FILES};assert_retirement(before,after,version)
        m.boundary(candidate,observed['sha'],FILES)
        ok,detail=m.validate(site,candidate,observed['sha'],m.BASE/site/'dependency-retirement-validation.log')
        require(ok,'official_dependency_validation_failed')
        m.boundary(candidate,observed['sha'],FILES);m.browser('candidate',site,candidate)
        branch=f'codex/dependency-retirement-{site}-{version}-{time.time_ns()}'
        m.git(candidate,'checkout','-b',branch);m.git(candidate,'add','--',*FILES)
        m.git(candidate,'commit','-m',f'fix(security): retire temporary cache patch with {version}')
        state.update(phase='publishing',head=m.git(candidate,'rev-parse','HEAD'),branch=branch);m.save(path,state)
        return poll_retirement(site,observed,state,m)
    except m.Deferred:raise
    except Exception as error:
        phase = state.get('phase') if state.get('phase') in ('publishing','pr_checks','verify') and not isinstance(error,ValueError) else ('needs_attention' if state.get('attempts',0)>=2 or isinstance(error,ValueError) and state.get('phase') in ('pr_checks','verify') else 'retry_next_check')
        state.update(phase=phase,reason=str(error)[:180],failedAt=m.now())
        m.save(path,state);m.notify('dependency-'+site,state)
        return {'site':site,'action':'dependency_retirement_needs_attention','reason':state['reason']}


def renew_dependency_budget(incident,advisories,sha,now):
    """A newly available compatible registry fix permits two fresh attempts once.

    Failed/offline audits never enter this function. Repeated or previously seen
    candidates cannot renew the budget, nor can npm's breaking downgrade advice.
    """
    targets=sorted({(fix['name'],fix['version']) for item in advisories.values()
        if isinstance((fix:=item.get('fixAvailable')),dict) and fix.get('isSemVerMajor') is False
        and re.fullmatch(r'[a-zA-Z0-9@/_-]+',fix.get('name',''))
        and re.fullmatch(r'\d+\.\d+\.\d+',fix.get('version',''))})
    targets += sorted((name, 'compatible-range-fix') for name,item in advisories.items()
        if item.get('fixAvailable') is True and re.fullmatch(r'[a-zA-Z0-9@/_-]+',name))
    if not targets:
        baseline=hashlib.sha256(b'[]').hexdigest()
        seen=incident.setdefault('dependencyCandidates',[])
        if baseline not in seen:seen.append(baseline)
        return False
    key=hashlib.sha256(json.dumps(targets).encode()).hexdigest()
    seen=incident.setdefault('dependencyCandidates',[])
    if key in seen:return False
    seen.append(key)
    if len(seen)>32:raise ValueError('dependency_candidate_history_limit')
    # First observation records the evidence; only a changed available fix
    # can reopen an exhausted incident.
    if len(seen)==1:return False
    incident.setdefault('previousAttempts',[]).append({'attempts':incident.get('attempts',0),'reason':incident.get('reason'),'at':now})
    incident.update(attempts=0,phase='confirmed',base=sha,reason='new_compatible_dependency_fix',updatedAt=now)
    return True
