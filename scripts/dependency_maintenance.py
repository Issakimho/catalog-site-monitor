"""Bounded lifecycle of reviewed dependency backports. No model-generated patches."""
import copy,datetime as dt,hashlib,json,re,subprocess,time
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
        # npm update stays within the declared range. Permit a forward minor
        # within a stable major, while 0.x minor changes remain breaking.
        require(a[0]==b[0] and (a[0]>0 or a[1]==b[1]) and b>a,
            'not_a_forward_compatible_release')
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
    current=before['config/dependency-patches.json']['patches'][0]['upstreamVersion']
    require(re.fullmatch(r'4\.\d+\.\d+',version) and re.fullmatch(r'4\.\d+\.\d+',current)
        and tuple(map(int,version.split('.')))>tuple(map(int,current.split('.'))),'unsupported_retirement_version')
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

def reviewed_patch_manifest(manifest,upstream,security,checked_at):
    """Renew one immutable, audited backport only after a fresh security review."""
    result=copy.deepcopy(manifest)
    require(result.get('schemaVersion')==1 and len(result.get('patches',[]))==1,'unreviewed_patch_recipe')
    patch=result['patches'][0]
    require(patch.get('package')==PACKAGE and patch.get('active') is True,'unreviewed_patch_recipe')
    require(upstream.get('status') in ('attention','expired') and not upstream.get('candidate')
        and upstream.get('latest')==patch.get('upstreamVersion'),'official_release_needs_review')
    require(security.get('highOrCritical')=={} and security.get('regressionCases')==54
        and all(a in security.get('remediated',[]) for a in patch.get('advisories',[])),'patch_review_evidence_failed')
    reports=[p for p in security.get('patches',[]) if p.get('package')==PACKAGE]
    require(len(reports)==1 and reports[0].get('package')==PACKAGE
        and reports[0].get('expiresAt')==patch.get('expiresAt')
        and reports[0].get('status') in ('attention','expired'),'patch_review_evidence_failed')
    require(re.fullmatch(r'[a-f0-9]{64}',security.get('digest',''))
        and re.fullmatch(r'[a-f0-9]{64}',patch.get('sha256','')),'patch_review_evidence_failed')
    now=dt.datetime.fromisoformat(checked_at.replace('Z','+00:00'))
    audited=dt.datetime.fromisoformat(security['checkedAt'].replace('Z','+00:00'))
    require(now.tzinfo and audited.tzinfo and 0<=(now-audited).total_seconds()<3600,'stale_patch_review')
    old_start=dt.datetime.fromisoformat(patch['introducedAt'].replace('Z','+00:00'))
    old_warn=dt.datetime.fromisoformat(patch['warnAt'].replace('Z','+00:00'))
    old_end=dt.datetime.fromisoformat(patch['expiresAt'].replace('Z','+00:00'))
    require(old_start<=old_warn<old_end and old_end-old_start<=dt.timedelta(days=21)
        and now>=old_warn,'patch_review_not_due')
    start=now.astimezone(dt.timezone.utc).replace(hour=0,minute=0,second=0,microsecond=0)
    iso=lambda value:value.isoformat(timespec='seconds').replace('+00:00','Z')
    patch.setdefault('firstIntroducedAt',patch['introducedAt'])
    history=patch.setdefault('reviewHistory',[])
    require(isinstance(history,list) and len(history)<100,'invalid_patch_review_history')
    history.append({'checkedAt':checked_at,'previousExpiresAt':patch['expiresAt'],
        'upstreamVersion':upstream['latest'],'vendorSha256':patch['sha256'],
        'auditDigest':security['digest'],'regressionCases':security['regressionCases']})
    patch.update(introducedAt=iso(start),warnAt=iso(start+dt.timedelta(days=14)),
        expiresAt=iso(start+dt.timedelta(days=21)))
    return result

def audit_snapshot(site,sha,m):
    root=m.fresh_root(site,sha);folder=m.BASE/site
    manifest=m.run(['git','show',sha+':config/dependency-patches.json'],cwd=root,allow_failure=True)
    if manifest.returncode:return None
    paths=m.git(root,'ls-tree','-r','--name-only',sha,'--',*FILES,'scripts/dependency-patches.mjs',
        'scripts/test-dependency-patches.mjs','scripts/picomatch-build-protection.mjs','vendor/http-cache-semantics').splitlines()
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
        patches=manifest_now['patches']+([manifest_now['picomatch']] if 'picomatch' in manifest_now else [])
        if all(not p['active'] or p['warnAt'] > m.now() for p in patches):return cached
    work.mkdir(parents=True,exist_ok=True)
    for path,content in contents.items():
        target=work/path;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
    m.run(['npm','ci','--ignore-scripts','--no-audit'],cwd=work,timeout=600)
    p=m.run(['node','scripts/dependency-patches.mjs','observe'],cwd=work,timeout=240,allow_failure=True)
    require(p.returncode in (0,1) and bool(p.stdout.strip()),'dependency_audit_unavailable')
    report=json.loads(p.stdout)
    require(isinstance(report.get('highOrCritical'),dict),'dependency_audit_unavailable')
    report.update(digest=signature,epoch=time.time(),workspace=str(work))
    m.save(folder/'dependency-audit.json',report)
    return report

def poll_retirement(site,observed,state,m,state_file='dependency-retirement.json',before_merge=None):
    work=Path(state['workspace']);base=state['base'];version=state['version']
    review=state.get('kind')=='review'
    glob=state_file==GLOB_STATE
    allowed=state['allowed'] if glob else (['config/dependency-patches.json'] if review else FILES)
    require(work.resolve().parent==(m.BASE/site).resolve() and work.name.startswith('attempt-'),'untrusted_retirement_workspace')
    require(m.git(work,'rev-parse','HEAD')==state['head'],'retirement_head_changed')
    require(not m.git(work,'status','--porcelain'),'dirty_retirement_candidate')
    if review or glob:m.boundary(work,base,allowed)
    if state['phase']=='publishing':
        prs=m.api(f'repos/{m.repo(site)}/pulls?state=all&head=Issakimho:{state["branch"]}&base=main')
        if prs:
            require(len(prs)==1 and prs[0]['head']['sha']==state['head'],'ambiguous_retirement_pr')
            state['prNumber']=prs[0]['number'];state['prUrl']=prs[0]['html_url']
        else:
            m.git(work,'push','origin',state['head']+':refs/heads/'+state['branch'])
            body=m.BASE/site/'dependency-retirement-pr.md'
            if glob:
                title,description=glob_pull_request(state)
                body.write_text(description+'\n')
            elif review:
                body.write_text(f'Review the unchanged {PACKAGE} backport against upstream {state["upstreamVersion"]}. Fresh dependency audit and {state["regressionCases"]} cache regressions pass. Vendor bytes and catalog data are unchanged. New review deadline: {state["reviewExpiresAt"]}.\n')
                title=f'fix(security): review cache backport through {state["reviewExpiresAt"][:10]}'
            else:
                body.write_text(f'Replace the temporary cache-security backport with official {PACKAGE} {version}. The original security regression tests, all site gates and candidate browser journeys pass. Catalog bytes and all other dependency versions remain unchanged.\n')
                title=f'fix(security): retire cache backport with {version}'
            pr=m.run(['gh','pr','create','--repo',m.repo(site),'--base','main','--head',state['branch'],'--title',title,'--body-file',str(body)],cwd=work).stdout.strip()
            require(re.fullmatch(r'https://github.com/'+re.escape(m.repo(site))+r'/pull/\d+',pr),'retirement_pr_not_confirmed')
            state['prNumber']=int(pr.rsplit('/',1)[1]);state['prUrl']=pr
        state['phase']='pr_checks';m.save(m.BASE/site/state_file,state)
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
        if review:
            current=json.loads(m.run(['node','scripts/dependency-patches.mjs','upstream'],cwd=work,timeout=180).stdout)
            require(len(current)==1 and not current[0].get('candidate')
                and current[0].get('latest')==state['upstreamVersion'],'official_release_needs_review')
            audited=json.loads(m.run(['node','scripts/dependency-patches.mjs','audit'],cwd=work,timeout=240).stdout)
            require(audited.get('highOrCritical')=={} and audited.get('regressionCases')==state['regressionCases'],
                'new_advisory_blocks_review')
        if before_merge:before_merge(work,state,m)
        m.browser('candidate',site,work)
        require(m.api(f'repos/{m.repo(site)}/commits/main')['sha']==base,'retirement_base_advanced')
        result=json.loads(m.run(['gh','api',f'repos/{m.repo(site)}/pulls/{state["prNumber"]}/merge','--method','PUT','-f','merge_method=squash','-f','sha='+state['head']]).stdout)
        require(result.get('merged') is True,'retirement_merge_failed');sha=result['sha']
    else:sha=pr['merge_commit_sha']
    state.update(phase='verify',publishedSha=sha);m.save(m.BASE/site/state_file,state)
    proof=m.verify_publication(site,{'publishedSha':sha,'workspace':str(work)})
    state.update(phase='resolved',proof=proof,resolvedAt=m.now());m.save(m.BASE/site/state_file,state)
    m.notify(('picomatch-' if glob else 'dependency-')+site)
    return {'site':site,'action':state['kind'] if glob else ('dependency_patch_reviewed' if review else 'dependency_patch_retired'),
        'sha':sha,'prUrl':state['prUrl']}

def handle(site,observed,security,m,check_only=False):
    path=m.BASE/site/'dependency-retirement.json';state=m.load(path,{})
    try:
        if state.get('phase') in ('publishing','pr_checks','verify'):
            if check_only:return {'site':site,'action':'dependency_retirement_pending','prUrl':state.get('prUrl')}
            return poll_retirement(site,observed,state,m)
        if not security.get('workspace'):return None
        if 'patchedPicomatchPaths' in security:
            glob=handle_picomatch(site,observed,security,m,check_only)
            if glob:return glob
        work=Path(security['workspace'])
        info=json.loads(m.run(['node','scripts/dependency-patches.mjs','upstream'],cwd=work,timeout=180).stdout)
        m.save(m.BASE/site/'dependency-upstream.json',{'checkedAt':m.now(),'patches':info})
        if not info:return None
        p=info[0]
        if p['status'] in ('attention','expired') and not p.get('candidate'):
            if check_only:return {'site':site,'action':'dependency_patch_review_due'}
            key='review:'+p['expiresAt']
            if not can_attempt(state,key):
                m.notify('dependency-'+site,{'reason':state.get('reason','patch_review_attempt_limit'),
                    'attempts':state.get('attempts',0),'diagnosis':'Révision automatique du correctif impossible avant '+p['expiresAt']})
                return {'site':site,'action':'dependency_patch_review_needs_attention','reason':state.get('reason')}
            attempts=state.get('attempts',0) if state.get('version')==key else 0
            state={'kind':'review','version':key,'upstreamVersion':p['latest'],
                'attempts':attempts+1,'phase':'validating','base':observed['sha'],'startedAt':m.now()}
            m.save(path,state)
            candidate=m.new_workspace(site,observed['sha'])
            state['workspace']=str(candidate);m.save(path,state)
            manifest=m.load(candidate/'config/dependency-patches.json')
            updated=reviewed_patch_manifest(manifest,p,security,m.now())
            m.save(candidate/'config/dependency-patches.json',updated)
            state.update(reviewExpiresAt=updated['patches'][0]['expiresAt'],regressionCases=security['regressionCases'])
            m.save(path,state)
            m.boundary(candidate,observed['sha'],['config/dependency-patches.json'])
            ok,detail=m.validate(site,candidate,observed['sha'],m.BASE/site/'dependency-review-validation.log')
            require(ok,'review_validation_failed')
            m.boundary(candidate,observed['sha'],['config/dependency-patches.json'])
            m.browser('candidate',site,candidate)
            branch=f'codex/dependency-review-{site}-{time.time_ns()}'
            m.git(candidate,'checkout','-b',branch)
            m.git(candidate,'add','--','config/dependency-patches.json')
            m.git(candidate,'commit','-m',f'fix(security): revalidate temporary cache backport through {state["reviewExpiresAt"][:10]}')
            state.update(phase='publishing',head=m.git(candidate,'rev-parse','HEAD'),branch=branch)
            m.save(path,state)
            return poll_retirement(site,observed,state,m)
        elif p['status']=='active' and not p.get('candidate') and state.get('phase')!='needs_attention':
            # A renewed patch supersedes an earlier deadline alert. The daily
            # watcher will open a new alert when the next deadline approaches.
            m.notify('dependency-'+site)
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
        if state.get('kind')=='review' and str(error)=='retirement_base_advanced' and state.get('prNumber'):
            closed=m.run(['gh','pr','close',str(state['prNumber']),'--repo',m.repo(site)],
                cwd=Path(state['workspace']),allow_failure=True)
            phase='retry_next_check' if closed.returncode==0 and state.get('attempts',0)<2 else 'needs_attention'
        else:
            phase = state.get('phase') if state.get('phase') in ('publishing','pr_checks','verify') and not isinstance(error,ValueError) else ('needs_attention' if state.get('attempts',0)>=2 or isinstance(error,ValueError) and state.get('phase') in ('pr_checks','verify') else 'retry_next_check')
        state.update(phase=phase,reason=str(error)[:180],failedAt=m.now())
        m.save(path,state)
        if state.get('kind')!='review' or phase=='needs_attention':m.notify('dependency-'+site,state)
        if state.get('kind')=='review':
            action='dependency_patch_review_needs_attention' if phase=='needs_attention' else 'dependency_patch_review_retry_next_check'
        else:action='dependency_retirement_needs_attention'
        return {'site':site,'action':action,'reason':state['reason']}


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


GLOB_ID='GHSA-fc5q-39xc-vjpf'
GLOB_URL='https://github.com/advisories/'+GLOB_ID
GLOB_STATE='picomatch-maintenance.json'
GLOB_PATHS=('node_modules/anymatch/node_modules/picomatch','node_modules/picomatch')


def stable_version(value):
    return tuple(map(int,value.split('.'))) if isinstance(value,str) and re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)',value) else ()


def glob_versions(advisory, installed):
    """Use the published patched version for each compatible release line."""
    require(advisory.get('ghsa_id')==GLOB_ID and advisory.get('type')=='reviewed','unverified_picomatch_advisory')
    if advisory.get('withdrawn_at'):
        return {}
    fixed=sorted({parsed for entry in advisory.get('vulnerabilities',[])
        if entry.get('package')=={'ecosystem':'npm','name':'picomatch'}
        and (parsed:=stable_version(entry.get('first_patched_version')))})
    versions={}
    for path,value in installed.items():
        current=stable_version(value)
        require(path in GLOB_PATHS and bool(current),'unexpected_picomatch_install')
        newer=next((v for v in fixed if v[0]==current[0] and v>current),None)
        if newer:versions[path]='.'.join(map(str,newer))
    return versions


def glob_release(work, version, m):
    result=m.run(['npm','view','picomatch@'+version,'--json','--registry=https://registry.npmjs.org'],
        cwd=work,timeout=120,allow_failure=True)
    if result.returncode:
        return None
    info=json.loads(result.stdout)
    dist=info.get('dist',{});repo=info.get('repository',{})
    require(info.get('name')=='picomatch' and info.get('version')==version
        and repo.get('url')=='git+https://github.com/micromatch/picomatch.git' and not info.get('deprecated')
        and dist.get('tarball')==f'https://registry.npmjs.org/picomatch/-/picomatch-{version}.tgz'
        and re.fullmatch(r'sha512-[A-Za-z0-9+/]+=*',dist.get('integrity','')),
        'unverified_picomatch_release')
    require(not any(info.get(k) for k in ('dependencies','optionalDependencies','peerDependencies','bundledDependencies','bundleDependencies','bin'))
        and not any(k in info.get('scripts',{}) for k in ('preinstall','install','postinstall','prepare')),
        'picomatch_install_contract_changed')
    return {'version':version,'resolved':dist['tarball'],'integrity':dist['integrity'],
        **{k:info[k] for k in ('engines','license','funding') if k in info}}


def reviewed_glob_patch(patch, security, remaining, now):
    """Renew only the installed and freshly audited protection that is still required."""
    audited=dt.datetime.fromisoformat(security['checkedAt'].replace('Z','+00:00'))
    checked=dt.datetime.fromisoformat(now.replace('Z','+00:00'))
    reports=[p for p in security['patches'] if p['package']=='picomatch']
    require(security['highOrCritical']=={} and GLOB_URL in security['remediated'] and
        sorted(security['patchedPicomatchPaths'])==sorted(remaining) and
        security['globRegressionCases']==4+2*len(remaining) and
        len(reports)==1 and reports[0]['status'] in ('attention','expired') and
        reports[0]['expiresAt']==patch['expiresAt'] and
        0<=(checked-audited).total_seconds()<3600 and re.fullmatch(r'[a-f0-9]{64}',security['digest']),
        'picomatch_review_evidence_failed')
    require(patch['active'] and remaining and now>=patch['warnAt'],'picomatch_review_not_due')
    result=copy.deepcopy(patch)
    history=result.setdefault('reviewHistory',[])
    require(isinstance(history,list) and len(history)<150,'unexpected_picomatch_review_history')
    history.append({'checkedAt':now,'previousExpiresAt':patch['expiresAt'],'auditDigest':security['digest'],
        'patchedPaths':sorted(remaining),'regressionCases':security['globRegressionCases']})
    start=checked.astimezone(dt.timezone.utc).replace(hour=0,minute=0,second=0,microsecond=0)
    iso=lambda value:value.isoformat(timespec='seconds').replace('+00:00','Z')
    return {**result,'introducedAt':iso(start),'warnAt':iso(start+dt.timedelta(days=14)),
        'expiresAt':iso(start+dt.timedelta(days=21))}


def glob_pull_request(state):
    if state['kind']=='picomatch-review':
        return ('Revalidate the temporary picomatch protection',
            f'The installed protection passed a fresh audit, its regressions and site validation. '
            f'Next expiry: {state["expiresAt"]}. The installed packages and catalog data are unchanged.')
    versions=', '.join(sorted(set(state['installed'].values())))
    return (f'Install official picomatch {versions}',
        f'The reviewed advisory {GLOB_ID} names the installed versions as fixed. '
        'Each version stays within its current major. Only the targeted lock entries and patch state change. '
        'The original registry audit and all site checks remain required.')


def confirm_glob_candidate(work, state, m):
    if state['kind']=='picomatch-upgrade':
        confirmed=glob_versions(m.api('advisories/'+GLOB_ID),state['previous'])
        require(all(confirmed.get(path)==version for path,version in state['installed'].items()),
            'picomatch_release_no_longer_confirmed')
    report=json.loads(m.run(['node','scripts/dependency-patches.mjs','audit'],cwd=work,timeout=240).stdout)
    require(report['highOrCritical']=={} and sorted(report['patchedPicomatchPaths'])==state['remaining'],
        'picomatch_release_audit_failed')


def handle_picomatch(site, observed, security, m, check_only):
    folder=m.BASE/site
    state_file=folder/GLOB_STATE
    state=m.load(state_file,{})
    alert='picomatch-'+site
    try:
        if state.get('phase') in ('publishing','pr_checks','verify'):
            if check_only:return {'site':site,'action':'picomatch_pending','prUrl':state.get('prUrl')}
            return poll_retirement(site,observed,state,m,GLOB_STATE,confirm_glob_candidate)
        work=Path(security['workspace'])
        manifest=m.load(work/'config/dependency-patches.json')
        patch=manifest['picomatch']
        if not patch['active']:return None
        lock=m.load(work/'package-lock.json')
        remaining=sorted(security['patchedPicomatchPaths'])
        require(remaining and set(remaining)<=set(GLOB_PATHS),'unverified_picomatch_paths')
        installed={path:lock['packages'][path]['version'] for path in remaining}
        versions=glob_versions(m.api('advisories/'+GLOB_ID),installed)
        releases={path:release for path,version in versions.items()
            if (release:=glob_release(work,version,m)) is not None}
        m.save(folder/'picomatch-upstream.json',{'checkedAt':m.now(),'installed':installed,
            'candidates':{path:release['version'] for path,release in releases.items()},'expiresAt':patch['expiresAt']})
        due=m.now()>=patch['warnAt']
        budgets=state.get('budgets',{})
        upgrade_key='upgrade:'+','.join(path+'@'+release['version'] for path,release in sorted(releases.items()))
        upgrade=bool(releases) and budgets.get(upgrade_key,0)<2
        review_key='review:'+patch['expiresAt']
        if not upgrade and not due:return None
        key=upgrade_key if upgrade else review_key
        action='picomatch-upgrade' if upgrade else 'picomatch-review'
        if check_only:return {'site':site,'action':action+'_available'}
        if budgets.get(key,0)>=2:
            m.notify(alert,{'reason':'picomatch_attempts_exhausted','attempts':budgets[key],'base':observed['sha'],
                'diagnosis':f'Correctif picomatch à réexaminer pour {site.upper()} avant le {patch["expiresAt"]}.'})
            return {'site':site,'action':'picomatch_needs_attention'}
        require(not security['highOrCritical'],'new_advisory_blocks_picomatch_change')
        budgets[key]=budgets.get(key,0)+1
        state={'kind':action,'version':key,'attempts':budgets[key],'budgets':budgets,'base':observed['sha'],
            'phase':'validating','startedAt':m.now()}
        m.save(state_file,state)
        candidate=m.new_workspace(site,observed['sha'])
        state['workspace']=str(candidate);m.save(state_file,state)
        allowed=['config/dependency-patches.json']
        new_manifest=copy.deepcopy(manifest)
        if due and set(releases if upgrade else ())!=set(remaining):
            new_manifest['picomatch']=reviewed_glob_patch(patch,security,remaining,m.now())
        if upgrade:
            new_lock=copy.deepcopy(lock)
            official=new_manifest['picomatch'].setdefault('officialVersions',{})
            for path,release in releases.items():
                new_lock['packages'][path].update(release)
                official[path]=release['version']
            new_manifest['picomatch']['active']=len(official)<len(GLOB_PATHS)
            m.save(candidate/'package-lock.json',new_lock)
            allowed.append('package-lock.json')
        m.save(candidate/'config/dependency-patches.json',new_manifest)
        state.update(allowed=allowed,expiresAt=new_manifest['picomatch']['expiresAt'],previous=installed,
            installed={path:r['version'] for path,r in releases.items()} if upgrade else {},
            remaining=sorted(set(remaining)-set(releases if upgrade else ())))
        m.boundary(candidate,observed['sha'],allowed)
        ok,_=m.validate(site,candidate,observed['sha'],folder/'picomatch-validation.log')
        require(ok,'picomatch_site_validation_failed')
        m.boundary(candidate,observed['sha'],allowed)
        m.browser('candidate',site,candidate)
        branch=f'codex/picomatch-{site}-{time.time_ns()}'
        m.git(candidate,'checkout','-b',branch)
        m.git(candidate,'add','--',*allowed)
        m.git(candidate,'commit','-m',glob_pull_request(state)[0])
        state.update(phase='publishing',head=m.git(candidate,'rev-parse','HEAD'),branch=branch)
        m.save(state_file,state)
        for attempt in range(8):
            result=poll_retirement(site,observed,state,m,GLOB_STATE,confirm_glob_candidate)
            if result['action']!='dependency_retirement_pending_ci' or attempt==7:return result
            time.sleep(15)
    except m.Deferred as error:
        if str(error)!='repair_superseded_needs_recheck':raise
        state.update(phase='retry_next_check',reason=str(error))
        m.save(state_file,state)
        return {'site':site,'action':'picomatch_superseded'}
    except Exception as error:
        if check_only:raise
        if state.get('phase')=='pr_checks' and state.get('prNumber'):
            m.run(['gh','pr','close',str(state['prNumber']),'--repo',m.repo(site)],
                cwd=Path(state['workspace']),allow_failure=True)
        phase='retry_next_check'
        if state.get('phase') in ('publishing','pr_checks','verify') and not isinstance(error,ValueError):
            phase=state['phase']
        state.update(phase=phase,reason=str(error)[:180],failedAt=m.now())
        m.save(state_file,state)
        if state.get('attempts',0)>=2:
            m.notify(alert,{**state,'diagnosis':f'Validation picomatch à examiner pour {site.upper()}.'})
        return {'site':site,'action':'picomatch_pending_or_retry','reason':state['reason']}
