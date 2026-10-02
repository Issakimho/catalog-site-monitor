"""Use direct issue reads to survive GitHub's eventually consistent issue list."""
import json
import os
import re

REPO = 'Issakimho/catalog-site-monitor'

def matching_issue(issue, title, marker):
    return (not issue.get('pull_request') and issue.get('state', 'open') == 'open'
            and issue.get('title') == title and issue.get('user', {}).get('login') == 'Issakimho'
            and marker in (issue.get('body') or ''))

def find_alerts(command, cache, title, marker):
    issues = json.loads(command(['gh', 'api', f'repos/{REPO}/issues?state=open&per_page=100']))
    if cache.exists():
        number = json.loads(cache.read_text()).get('number')
        if not isinstance(number, int) or number <= 0:
            raise ValueError('invalid_saved_alert')
        # Fail closed on an unavailable direct read; do not create a duplicate.
        saved = json.loads(command(['gh', 'api', f'repos/{REPO}/issues/{number}']))
        issues = [i for i in issues if i.get('number') != number] + [saved]
    return [i for i in issues if matching_issue(i, title, marker)]

def remember_alert(cache, url):
    match = re.fullmatch(r'https://github.com/Issakimho/catalog-site-monitor/issues/([1-9][0-9]*)', url.strip())
    if not match:
        raise ValueError('unexpected_created_alert')
    temporary = cache.with_suffix('.tmp')
    temporary.write_text(json.dumps({'number': int(match[1])}) + '\n')
    os.replace(temporary, cache)
