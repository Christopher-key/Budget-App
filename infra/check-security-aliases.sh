#!/usr/bin/env bash
# Read provider metadata only; never create policies or enable enforcement.
set -euo pipefail
exec python3 - "$@" <<'PY'
import argparse
import json
import re
import shutil
import subprocess
import sys

parser = argparse.ArgumentParser(description=(
    'Check live Azure Policy aliases before reviewing/enforcing the budget baseline. '
    'Reads provider metadata only; availability does not prove policy behavior.'))
parser.add_argument('--subscription', required=True, help='Subscription UUID; no default subscription is changed.')
parser.add_argument('--resource-group', required=True, help='Existing budget group (review context only).')
args = parser.parse_args()
if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', args.subscription):
    parser.error('--subscription must be a UUID')
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._()\-]{0,89}', args.resource_group):
    parser.error('--resource-group is not a valid resource-group name')
if not shutil.which('az'):
    parser.exit(2, 'Azure CLI is required; use Azure Cloud Shell Bash.\n')

expected = {
    ('Microsoft.Storage', 'storageAccounts'): [
        'allowSharedKeyAccess', 'allowBlobPublicAccess',
        'supportsHttpsTrafficOnly', 'minimumTlsVersion'],
    ('Microsoft.DocumentDB', 'databaseAccounts'): ['disableLocalAuth'],
    ('Microsoft.Web', 'sites'): ['httpsOnly'],
}
checked = []
missing = []
for (namespace, resource_type), properties in expected.items():
    command = ['az', 'provider', 'show', '--namespace', namespace,
               '--expand', 'resourceTypes/aliases', '--subscription', args.subscription,
               '--query', f"resourceTypes[?resourceType=='{resource_type}'].aliases[].{{name:name,defaultPath:defaultPath}}",
               '--output', 'json', '--only-show-errors']
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=60, check=True)
        entries = json.loads(result.stdout)
        if not isinstance(entries, list) or any(not isinstance(item, dict) for item in entries):
            raise ValueError()
    except (OSError, subprocess.SubprocessError, ValueError):
        # Azure diagnostics can contain identity/session details; never echo them.
        parser.exit(1, f'Could not read policy alias metadata for {namespace}; check login and provider-read permissions.\n')
    available = {item.get('name', '').lower(): item for item in entries if isinstance(item.get('name'), str)}
    for property_name in properties:
        alias = f'{namespace}/{resource_type}/{property_name}'
        present = alias.lower() in available
        checked.append({'alias': alias, 'available': present})
        if not present:
            missing.append(alias)

print(json.dumps({'subscriptionId': args.subscription, 'resourceGroup': args.resource_group,
                  'aliases': checked, 'missingAliases': missing,
                  'limitations': [
                      'Alias availability does not validate API-version property values or policy evaluation.',
                      'Review compliance in DoNotEnforce and test intended deployments before enabling Deny.',
                      'Storage TLS1_3 support is not established by this metadata check.']}, indent=2))
if missing:
    parser.exit(1, 'Required policy aliases are missing; do not enable the baseline Deny assignments.\n')
PY
