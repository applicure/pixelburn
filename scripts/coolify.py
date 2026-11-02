#!/usr/bin/env python3
"""Call the project Coolify API without putting its token in command arguments.

Usage: python3 scripts/coolify.py GET /projects
       python3 scripts/coolify.py POST /projects payload.json
Reads the ignored project .env as data, never as shell code. Do not use it to
request secret-bearing environment or database responses in shared logs.
"""
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


def request(method, path, payload=None):
    values = {}
    for line in (Path(__file__).resolve().parents[1] / '.env').read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip().strip('\"\'')
    token = values.get('COOLIFY_TOKEN') or values.get('COOLIFY_API_TOKEN')
    if not token:
        raise SystemExit('Set COOLIFY_TOKEN in the ignored .env file.')
    if not path.startswith('/') or path.startswith('//'):
        raise SystemExit('An API-relative path is required.')
    req = urllib.request.Request(
        'https://coolify.applicure.io/api/v1' + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'Content-Type': 'application/json'},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        message = error.read().decode().replace(token, '[REDACTED]')
        raise SystemExit(f'Coolify HTTP {error.code}: {message}') from None


if __name__ == '__main__':
    payload = json.loads(Path(sys.argv[3]).read_text()) if len(sys.argv) > 3 else None
    print(json.dumps(request(sys.argv[1], sys.argv[2], payload), indent=2))
