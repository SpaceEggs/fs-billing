#!/usr/bin/env python3
import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess
import urllib.request

parser = argparse.ArgumentParser(description='Check a verification-owned FS-Billing instance.')
parser.add_argument('evidence_directory', type=Path)
args = parser.parse_args()
run = args.evidence_directory.resolve()
repo = Path((run / 'root.txt').read_text().strip()).resolve()
script_repo = Path(subprocess.check_output(
    ['git', '-C', str(Path(__file__).resolve().parent), 'rev-parse', '--show-toplevel'],
    text=True,
).strip()).resolve()
assert repo == script_repo, 'Evidence belongs to another checkout.'
launcher = int((run / 'launcher.pid').read_text())
os.kill(launcher, 0)

current_revision = subprocess.check_output(
    ['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True
).strip()
assert current_revision == (run / 'revision.txt').read_text().strip(), 'Source revision changed. Start a new run.'
cwd = subprocess.check_output(
    ['lsof', '-a', '-p', str(launcher), '-d', 'cwd', '-Fn'], text=True
)
assert f'n{repo}' in cwd.splitlines(), 'Launcher belongs to another checkout.'
parents = {}
for line in subprocess.check_output(['ps', '-ax', '-o', 'pid=,ppid='], text=True).splitlines():
    child, parent = map(int, line.split())
    parents[child] = parent

listeners = {}
for port in (3000, 3001, 5173):
    result = subprocess.run(
        ['lsof', '-nP', '-t', f'-iTCP:{port}', '-sTCP:LISTEN'],
        capture_output=True, text=True, check=False,
    )
    pids = sorted({int(line) for line in result.stdout.splitlines()})
    assert pids, f'No listener on port {port}. Read dev.log.'
    for pid in pids:
        ancestor = pid
        seen = set()
        while ancestor != launcher and ancestor not in seen and ancestor in parents:
            seen.add(ancestor)
            ancestor = parents[ancestor]
        assert ancestor == launcher, f'Port {port} belongs to another process. Do not drive it.'
    listeners[str(port)] = pids

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
endpoints = {
    'web': ('http://127.0.0.1:5173/', None),
    'api': ('http://127.0.0.1:3000/api/health', {'status': 'ok', 'service': 'api'}),
    'proxy': ('http://127.0.0.1:5173/api/health', {'status': 'ok', 'service': 'api'}),
    'worker': ('http://127.0.0.1:3001/health', {'status': 'ok', 'service': 'worker'}),
}
responses = {}
for name, (url, expected) in endpoints.items():
    with opener.open(url, timeout=5) as response:
        body = response.read().decode('utf-8')
        assert response.status == 200, f'{name} returned {response.status}.'
        if expected is None:
            assert '<title>FS-Billing</title>' in body, 'Unexpected Web document.'
            (run / 'web.html').write_text(body)
        else:
            assert json.loads(body) == expected, f'Unexpected {name} response: {body}'
        responses[name] = {'method': 'GET', 'url': url, 'status': response.status, 'body': body}

proof = {
    'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'root': str(repo),
    'revision': current_revision,
    'launcher_pid': launcher,
    'listeners': listeners,
    'responses': responses,
}
(run / 'doctor.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'result': 'ready', 'evidence': str(run / 'doctor.json')}, ensure_ascii=False))
