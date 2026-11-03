#!/usr/bin/env bash
# Download code built by GitHub Actions and publish to existing Azure resources.
set -euo pipefail
umask 077
usage() {
  cat <<'USAGE'
Usage: infra/publish-github-build.sh --resource-group GROUP [--subscription ID] [--release api-build-COMMIT_SHA]
       [--deployment-name NAME] [--blob-name NEW-IMMUTABLE-RELEASE.zip]

Downloads the verified API build for this source checkout. No local Node build,
browser ZIP upload, server-key generation, or Azure resource creation is needed.
The deployment defaults to budget-backend. Use a separate deployment name for
the security controller. Use a NEW blob name when upgrading deployed code.
USAGE
}
budget_subscription=''
budget_group=''
budget_release=''
budget_deployment='budget-backend'
budget_blob_override=''
while (($#)); do
  if [[ "$1" == '--help' || "$1" == '-h' ]]; then usage; exit 0; fi
  if (($# < 2)); then usage >&2; exit 2; fi
  case "$1" in
    --subscription) budget_subscription=$2 ;;
    --resource-group) budget_group=$2 ;;
    --release) budget_release=$2 ;;
    --deployment-name) budget_deployment=$2 ;;
    --blob-name) budget_blob_override=$2 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift 2
done
if [[ -z "$budget_group" || ! "$budget_group" =~ ^[A-Za-z0-9][A-Za-z0-9._\(\)-]{0,89}$ ]]; then
  printf 'Provide the existing resource-group name.\n' >&2; exit 2
fi
if [[ ! "$budget_deployment" =~ ^[A-Za-z0-9][A-Za-z0-9._\(\)-]{0,63}$ ]]; then
  printf 'Provide a valid existing deployment name.\n' >&2; exit 2
fi
if [[ -n "$budget_blob_override" && ! "$budget_blob_override" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$ ]]; then
  printf 'Use an immutable ZIP filename without directories.\n' >&2; exit 2
fi
for budget_tool in az python3 curl git; do
  command -v "$budget_tool" >/dev/null || { printf '%s is required; use Azure Cloud Shell Bash.\n' "$budget_tool" >&2; exit 2; }
done
budget_script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
budget_repository=$(cd -- "$budget_script_dir/.." && pwd)
if [[ -z "$budget_release" ]]; then
  budget_release="api-build-$(git -C "$budget_repository" rev-parse HEAD)"
fi
if [[ ! "$budget_release" =~ ^api-build-[0-9a-f]{40}$ ]]; then
  printf 'Use an API build tag with its full source commit SHA.\n' >&2; exit 2
fi
budget_work=$(mktemp -d)
trap 'rm -rf -- "$budget_work"' EXIT
budget_account_args=()
if [[ -n "$budget_subscription" ]]; then budget_account_args=(--subscription "$budget_subscription"); fi
budget_subscription=$(az account show "${budget_account_args[@]}" --query id --output tsv --only-show-errors)
if [[ ! "$budget_subscription" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  printf 'Azure did not return a valid subscription ID.\n' >&2; exit 2
fi
printf 'Reading public resource names from the existing deployment...\n'
az deployment group show --subscription "$budget_subscription" --resource-group "$budget_group" \
  --name "$budget_deployment" --only-show-errors --output json \
  --query '{state:properties.provisioningState,functionApp:properties.outputs.functionAppName.value,storage:properties.outputs.hostStorageAccountName.value,blob:properties.outputs.deploymentPackageBlob.value}' \
  > "$budget_work/public-deployment.json"
python3 - "$budget_work/public-deployment.json" > "$budget_work/public-names" <<'PY'
import json, re, sys
with open(sys.argv[1], encoding='utf-8') as source:
    value = json.load(source)
if value.get('state') != 'Succeeded':
    raise SystemExit('Complete the existing backend deployment before publishing code.')
patterns = {'functionApp': r'[A-Za-z0-9][A-Za-z0-9-]{0,59}',
            'storage': r'[a-z0-9]{3,24}', 'blob': r'[A-Za-z0-9][A-Za-z0-9._-]*\.zip'}
for field, pattern in patterns.items():
    item = value.get(field)
    if not isinstance(item, str) or not re.fullmatch(pattern, item):
        raise SystemExit('The deployment is missing expected public resource outputs.')
    print(item)
PY
mapfile -t budget_names < "$budget_work/public-names"
if [[ -n "$budget_blob_override" ]]; then budget_names[2]=$budget_blob_override; fi
budget_url="https://github.com/Christopher-key/Budget-App/releases/download/$budget_release"
printf 'Downloading the API package built by GitHub Actions...\n'
if ! curl --fail --silent --show-error --location "$budget_url/budget-api.zip.sha256" \
    --output "$budget_work/budget-api.zip.sha256"; then
  printf 'The GitHub API build is not available yet. Wait for Cloud application checks and its publish job to succeed.\n' >&2
  exit 1
fi
curl --fail --silent --show-error --location "$budget_url/budget-api.zip" --output "$budget_work/budget-api.zip"
python3 - "$budget_work" <<'PY'
import hashlib, pathlib, re, sys
folder = pathlib.Path(sys.argv[1])
text = (folder / 'budget-api.zip.sha256').read_text(encoding='utf-8').strip()
match = re.fullmatch(r'([0-9a-f]{64})\s+\*?budget-api\.zip', text)
if not match:
    raise SystemExit('The GitHub package checksum file is invalid.')
digest = hashlib.sha256()
with (folder / 'budget-api.zip').open('rb') as source:
    for block in iter(lambda: source.read(1024 * 1024), b''):
        digest.update(block)
if digest.hexdigest() != match.group(1):
    raise SystemExit('The downloaded API package failed checksum verification; nothing was uploaded.')
print('GitHub build checksum verified.')
PY
bash "$budget_script_dir/publish-api.sh" \
  --subscription "$budget_subscription" --resource-group "$budget_group" \
  --function-app "${budget_names[0]}" --storage-account "${budget_names[1]}" \
  --blob-name "${budget_names[2]}" --package "$budget_work/budget-api.zip"
