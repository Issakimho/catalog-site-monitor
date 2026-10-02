#!/usr/bin/env python3
"""Serialized Raspberry collector. Logs and supplier configuration stay private."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

BASE = Path('/home/imho/.local/state/catalog-autonomy')
CONFIG = Path('/home/imho/.codex/catalog-autonomy/sites.json')
MONITOR = Path('/home/imho/catalog/monitor')
ENV = {k: v for k, v in os.environ.items() if not any(x in k.upper() for x in ('TOKEN', 'SECRET', 'PASSWORD', 'OPENAI', 'AMAZON', 'CREDENTIAL'))}
ENV.update(PATH='/home/imho/.local/bin:/usr/local/bin:/usr/bin:/bin', HOME='/home/imho', GIT_TERMINAL_PROMPT='0')

def run(args, **kwargs):
    return subprocess.run(args, env=ENV, check=True, capture_output=True, text=True, timeout=60, **kwargs)

def notification_action(returncode, report):
    if returncode or report.get('attentionRequired'):
        return 'open'
    if report.get('decision') == 'recovered' and report.get('canCloseIncident') is True:
        return 'close'
    return 'retain'

def alert(site, failed):
    (BASE).mkdir(parents=True,exist_ok=True)
    with (BASE/"alerts.lock").open("a") as alert_lock:
        fcntl.flock(alert_lock,fcntl.LOCK_EX)
        title = '[Raspberry] Enrichissement FR' if site == 'fr' else f'[Raspberry] Collecte {site.upper()}'
        marker = f'<!-- raspberry-catalog-v1:{site} -->'
        import importlib.util
        spec = importlib.util.spec_from_file_location('raspberry_alerts', MONITOR/'scripts/raspberry_alerts.py')
        alerts = importlib.util.module_from_spec(spec); spec.loader.exec_module(alerts)
        cache = BASE / ('collection-alert-' + site + '.json')
        matching = alerts.find_alerts(lambda args: run(args).stdout, cache, title, marker)
        if failed and not matching:
            worker = "L'enrichissement français" if site == 'fr' else 'Le collecteur'
            body = marker + '\n\n' + worker + ' du Raspberry a échoué, manque de place disque ou présente une panne partielle persistante. Les journaux restent privés sur le Raspberry. Le contrôle public continue de vérifier le catalogue live. Les dates des offres ne sont jamais modifiées sans collecte. Sur les variantes, seule une réparation limitée du sélecteur peut être publiée après CI et vérification du site.'
            created = run(['gh', 'issue', 'create', '--repo', 'Issakimho/catalog-site-monitor', '--title', title,
                 '--body', body, '--assignee', 'Issakimho'])
            alerts.remember_alert(cache, created.stdout)
        elif not failed:
            for issue in matching:
                run(['gh', 'issue', 'close', str(issue['number']), '--repo', 'Issakimho/catalog-site-monitor',
                     '--comment', "La collecte a été rétablie et la publication vérifiée en production. Aucun incident de requête ne reste ouvert."])

def trim_dependencies(directory, state):
    # Only reproducible dependencies in old worker-created clones. Preserve source,
    # Git history, logs and every pending/most recent attempt for investigation.
    protected = {state.get('pendingWorkspace'), state.get('lastWorkspace')}
    for candidate in directory.glob('attempt-*'):
        if candidate.is_symlink() or not candidate.is_dir() or str(candidate) in protected:
            continue
        if time.time() - candidate.stat().st_mtime < 7 * 86400:
            continue
        dependencies = candidate / 'node_modules'
        if (candidate / '.git').is_dir() and dependencies.is_dir() and not dependencies.is_symlink():
            assert dependencies.resolve().parent == candidate.resolve()
            shutil.rmtree(dependencies)

def main():
    os.umask(0o077)
    site = sys.argv[1] if len(sys.argv) in (2, 3) else ''
    if site not in ('de', 'es', 'it', 'us', 'fr'):
        raise ValueError('unsupported_site')
    probe_browser = len(sys.argv) == 3 and sys.argv[2] == '--probe-browser'
    if len(sys.argv) == 3 and not probe_browser:
        if sys.argv[2] != '--notify-failure':
            raise ValueError('unsupported_action')
        alert(site, True)
        return 0
    if site == 'fr':
        raise ValueError('french_collection_is_cloud_only')
    settings = json.loads(CONFIG.read_text())
    config = settings['sites'][site]
    assert config['root'] == f'/home/imho/catalog/{site}'
    directory = BASE / site
    directory.mkdir(parents=True, exist_ok=True)
    # Across all sites and manual service starts, one heavy collector at a time.
    with (BASE / 'portfolio.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state_path = directory / 'state.json'
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        trim_dependencies(directory, state)
        if shutil.disk_usage(BASE).free < 8 * 1024**3:
            alert(site, True)
            raise RuntimeError('disk_space_low')
        log_path = directory / f'runner-{time.strftime("%Y-%m-%d")}.log'
        try:
            result = subprocess.run(['node', str(MONITOR / 'scripts/local-recovery.mjs'), site, '--run'] + (['--probe-browser'] if probe_browser else []),
                cwd=config['root'], env=ENV, capture_output=True, text=True, timeout=10800)
        except Exception:
            alert(site, True)
            raise
        with log_path.open('a') as log:
            log.write(result.stdout)
            log.write(result.stderr)
        try:
            report = json.loads(result.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            report = {}
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        # A public healthy no-op cannot prove that a supplier incident recovered.
        action = notification_action(result.returncode, report)
        if action == 'open':
            alert(site, True)
        elif action == 'close':
            alert(site, False)
        stamp = {'site': site, 'finishedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                 'success': result.returncode == 0 and not report.get('attentionRequired', False),
                 'unresolvedQueries': report.get('unresolvedQueries'),
                 'persistentQueries': report.get('persistentQueries'), 'lastSuccess': state.get('lastSuccess')}
        (directory / 'runner-status.json').write_text(json.dumps(stamp) + '\n')
        print(json.dumps(stamp))
        return result.returncode

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        # Never emit subprocess output, provider responses, exception text or secrets.
        print('raspberry_collector_failed', file=sys.stderr)
        sys.exit(1)
