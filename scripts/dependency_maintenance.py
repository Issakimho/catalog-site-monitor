"""Bounded lifecycle of reviewed dependency backports. No model-generated patches."""
import copy,hashlib,json,re,subprocess,time
from pathlib import Path

PACKAGE='http-cache-semantics'
FILES=['package.json','package-lock.json','config/dependency-patches.json']

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
        if p['status'] in ('attention','expired'):
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
    if not targets:return False
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
