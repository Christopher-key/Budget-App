#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: infra/deploy.sh --subscription ID --resource-group NAME --parameters FILE [--deploy]

Defaults to Azure ARM what-if. Only --deploy applies the template.
Use an existing resource group. Review the selected subscription and what-if first.
EOF
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
python3 - "$parameters" <<'PY'
import json, re, sys
from urllib.parse import urlsplit
with open(sys.argv[1], encoding='utf-8') as f:
    document = json.load(f)
parameters = document['parameters']
values = {name: item['value'] for name, item in parameters.items()}
required = ['location', 'frontendOrigin', 'authIssuer', 'authAudience', 'authTenantId', 'authAllowedClientIds']
if any(not isinstance(values.get(name), str) or not values[name].strip() for name in required):
    raise SystemExit('Fill all required non-secret deployment parameters.')
if any('REPLACE_' in str(value) for value in values.values()):
    raise SystemExit('Replace every example placeholder before running what-if or deployment.')
origin = values['frontendOrigin']
url = urlsplit(origin)
if url.scheme != 'https' or not url.hostname or url.username or url.password or url.path or url.query or url.fragment or '*' in origin or origin != f'https://{url.netloc}':
    raise SystemExit('frontendOrigin must be one exact HTTPS origin, without path or trailing slash.')
issuer = urlsplit(values['authIssuer'])
if issuer.scheme != 'https' or not issuer.hostname or issuer.username or issuer.password or issuer.query or issuer.fragment or issuer.port or not (issuer.hostname == 'login.microsoftonline.com' or issuer.hostname.endswith('.ciamlogin.com')) or issuer.path.lower() != f'/{values["authTenantId"].lower()}/v2.0':
    raise SystemExit('authIssuer must be the configured tenant\'s exact Microsoft HTTPS v2 issuer, without trailing slash.')
guid = r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
if any(not re.fullmatch(guid, values[name]) for name in ['authAudience', 'authTenantId']):
    raise SystemExit('authAudience and authTenantId must be GUIDs.')
clients = values['authAllowedClientIds'].split(',')
if not clients or any(not re.fullmatch(guid, value.strip()) for value in clients):
    raise SystemExit('authAllowedClientIds must be comma-separated public-client application ID GUIDs.')
if not re.fullmatch(r'[a-z][a-z0-9-]{2,15}', values.get('namePrefix', 'budget')):
    raise SystemExit('namePrefix must contain 3–16 lowercase letters, digits, or hyphens, starting with a letter.')
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*\.zip', values.get('deploymentPackageBlobName', 'budget-api-initial.zip')):
    raise SystemExit('deploymentPackageBlobName must be a ZIP filename, without a directory or URL.')
PY

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
command=(az deployment group)
if "$deploy"; then command+=(create); else command+=(what-if); fi
command+=(--subscription "$subscription" --resource-group "$resource_group" --mode Incremental
  --name budget-backend --template-file "$script_dir/main.bicep" --parameters "@$parameters")
"${command[@]}"
