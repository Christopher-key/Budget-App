#!/usr/bin/env python3
"""Generate server secrets directly into an owner-only file outside the repository."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
from urllib.parse import urlsplit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--location', required=True)
parser.add_argument('--frontend-origin', required=True)
parser.add_argument('--name-prefix', default='budget')
parser.add_argument('--package-name', default='budget-api-release-001.zip')
arguments = parser.parse_args()
output = arguments.output.expanduser().resolve()
repository = Path(__file__).resolve().parent.parent
if output == repository or repository in output.parents:
    parser.error('Keep the private parameter file outside this repository.')
origin = urlsplit(arguments.frontend_origin)
if origin.scheme != 'https' or not origin.hostname or origin.username or origin.password or origin.path or origin.query or origin.fragment or '*' in arguments.frontend_origin or arguments.frontend_origin != f'https://{origin.netloc}':
    parser.error('Use the exact HTTPS website origin, without path or trailing slash.')
if not re.fullmatch(r'[a-z][a-z0-9-]{2,15}', arguments.name_prefix):
    parser.error('Use 3–16 lowercase letters, digits, or hyphens, starting with a letter.')
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*\.zip', arguments.package_name):
    parser.error('Use a ZIP filename without a directory or URL.')
with (Path(__file__).parent / 'params.example.json').open(encoding='utf-8') as source:
    document = json.load(source)
values = dict(location=arguments.location, namePrefix=arguments.name_prefix,
              frontendOrigin=arguments.frontend_origin,
              authLookupKey=secrets.token_urlsafe(32), authPepper=secrets.token_urlsafe(32),
              deploymentPackageBlobName=arguments.package_name)
for name, value in values.items():
    document['parameters'][name] = {'value': value}
# O_EXCL prevents an accidental overwrite from silently changing account lookup/pepper.
fd = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as target:
    json.dump(document, target, indent=2)
    target.write('\n')
print('Private deployment parameter file created. No secret values were printed.')
print('Keep this file secure and retain the same server keys for future deployments.')
