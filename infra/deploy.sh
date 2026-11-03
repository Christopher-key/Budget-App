#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'USAGE'
Usage: infra/deploy.sh --subscription ID --resource-group NAME --parameters FILE [--deploy]

Defaults to read-only ARM what-if, displaying resource names/change types only.
Only --deploy creates/changes resources. Use an existing resource group.
Keep the private parameter file outside this repository; it contains server secrets.
USAGE
}

subscription=''
resource_group=''
parameters=''
deploy=false
while (($#)); do
  case "$1" in
    --subscription|--resource-group|--parameters)
      if (($# < 2)); then usage >&2; exit 2; fi
      case "$1" in
        --subscription) subscription=$2 ;;
        --resource-group) resource_group=$2 ;;
        --parameters) parameters=$2 ;;
      esac
      shift 2
      ;;
    --deploy) deploy=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
if [[ -z "$subscription" || -z "$resource_group" || -z "$parameters" ]]; then
  usage >&2
  exit 2
fi
command -v az >/dev/null || { echo 'Install Azure CLI and its Bicep component first.' >&2; exit 2; }
command -v python3 >/dev/null || { echo 'Python 3 is required for local parameter validation.' >&2; exit 2; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
python3 - "$parameters" "$script_dir/.." <<'PY'
import base64, json, os, pathlib, re, sys
from urllib.parse import urlsplit
path = pathlib.Path(sys.argv[1]).resolve()
repository = pathlib.Path(sys.argv[2]).resolve()
if path == repository or repository in path.parents:
    raise SystemExit('Keep the private parameter file outside the repository.')
if os.name != 'nt' and path.stat().st_mode & 0o077:
    raise SystemExit('Private parameter file must allow only its owner to read/write it (chmod 600).')
with path.open(encoding='utf-8') as f:
    values = {name: item['value'] for name, item in json.load(f)['parameters'].items()}
required = ['location', 'frontendOrigin', 'authLookupKey', 'authPepper']
if any(not isinstance(values.get(name), str) or not values[name].strip() for name in required):
    raise SystemExit('Fill all required deployment parameters; do not print their values.')
if any('REPLACE_' in str(value) for value in values.values()):
    raise SystemExit('Replace every example placeholder before running what-if or deployment.')
origin = values['frontendOrigin']
url = urlsplit(origin)
if url.scheme != 'https' or not url.hostname or url.username or url.password or url.path or url.query or url.fragment or '*' in origin or origin != f'https://{url.netloc}':
    raise SystemExit('frontendOrigin must be one exact HTTPS origin, without path or trailing slash.')
for name in ['authLookupKey', 'authPepper']:
    value = values[name]
    decoded = base64.urlsafe_b64decode(value + '=') if re.fullmatch(r'[A-Za-z0-9_-]{43}', value) else b''
    if len(decoded) != 32 or base64.urlsafe_b64encode(decoded).decode().rstrip('=') != value:
        raise SystemExit('Each server secret must be an independent random 32-byte base64url value.')
if values['authLookupKey'] == values['authPepper']:
    raise SystemExit('Use independent server secrets.')
if not re.fullmatch(r'[a-z][a-z0-9-]{2,15}', values.get('namePrefix', 'budget')):
    raise SystemExit('namePrefix must contain 3–16 lowercase letters, digits, or hyphens, starting with a letter.')
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*\.zip', values.get('deploymentPackageBlobName', 'budget-api-initial.zip')):
    raise SystemExit('deploymentPackageBlobName must be a ZIP filename, without a directory or URL.')
PY

# Azure's full what-if payload can include app settings. Keep it in a private
# temporary file and print only identifiers/change types, never property values.
result=$(mktemp)
guard_error=$(mktemp)
trap 'rm -f -- "$result" "$guard_error"' EXIT
common=(--subscription "$subscription" --resource-group "$resource_group" --mode Incremental
  --name budget-backend --template-file "$script_dir/main.bicep" --parameters "@$parameters"
  --only-show-errors --output json)
if "$deploy"; then
  # main.bicep owns literal appSettings and cannot preserve an activated gate.
  # Existence of ANY controller deployment makes baseline apply unsafe, even
  # while provisioning or after failure. Read only its state, never settings.
  if az deployment group show --subscription "$subscription" --resource-group "$resource_group" \
      --name budget-lockdown --query properties.provisioningState --output tsv \
      --only-show-errors > "$result" 2> "$guard_error"; then
    printf '%s\n' 'Baseline deployment blocked: a budget-lockdown deployment exists. main.bicep does not preserve the incident security gate. Review a staged migration that preserves the gate before changing infrastructure; read-only what-if remains available.' >&2
    exit 1
  elif ! python3 - "$guard_error" <<'PY'
import json, pathlib, re, sys
message = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8', errors='replace').strip()
allowed = {'DeploymentNotFound', 'ResourceNotFound'}
match = re.match(r'^ERROR:\s*\((DeploymentNotFound|ResourceNotFound)\)(?:\s|$)', message)
if match:
    raise SystemExit(0)
try:
    value = json.loads(re.sub(r'^ERROR:\s*', '', message, count=1))
    code = value.get('code') or value.get('error', {}).get('code')
except (ValueError, AttributeError, TypeError):
    code = None
raise SystemExit(0 if isinstance(code, str) and code in allowed else 1)
PY
  then
    printf '%s\n' 'Baseline deployment blocked: Azure could not verify whether budget-lockdown exists. Check scoped read permissions and connectivity before retrying. No infrastructure changes were applied.' >&2
    exit 1
  fi
  az deployment group create "${common[@]}" > "$result"
  python3 - "$result" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as f:
    document = json.load(f)
print('Deployment state:', document.get('properties', {}).get('provisioningState', 'unknown'))
for name, entry in document.get('properties', {}).get('outputs', {}).items():
    # These template outputs are resource identifiers/URLs; never secret parameters.
    if name in {'functionAppName', 'apiBaseUrl', 'hostStorageAccountName', 'deploymentPackageContainer', 'deploymentPackageBlob'}:
        print(f'{name}: {entry.get("value", "")}')
PY
else
  az deployment group what-if "${common[@]}" --no-pretty-print > "$result"
  python3 - "$result" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as f:
    document = json.load(f)
for change in document.get('changes', []):
    print(f'{change.get("changeType", "Unknown")}: {change.get("resourceId", "")}')
print('Resource summary only. Review main.bicep for access scopes, backup retention, public endpoints, and paid resources.')
print('No resource changes applied. Repeat with --deploy only after reviewing the configuration and charges.')
PY
fi
