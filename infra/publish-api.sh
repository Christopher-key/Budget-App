#!/usr/bin/env bash
set -euo pipefail
usage() {
  cat <<'USAGE'
Usage: infra/publish-api.sh --subscription ID --resource-group NAME --function-app NAME --storage-account NAME --blob-name RELEASE.zip --package /absolute/path/RELEASE.zip

Publishes code to EXISTING backend resources using your Azure CLI identity.
Does not create resources, enable shared keys, generate SAS tokens, or print app settings.
USAGE
}
subscription=''
resource_group=''
function_app=''
storage_account=''
blob_name=''
package=''
while (($#)); do
  if [[ "$1" == '--help' || "$1" == '-h' ]]; then usage; exit 0; fi
  if (($# < 2)); then usage >&2; exit 2; fi
  case "$1" in
    --subscription) subscription=$2 ;;
    --resource-group) resource_group=$2 ;;
    --function-app) function_app=$2 ;;
    --storage-account) storage_account=$2 ;;
    --blob-name) blob_name=$2 ;;
    --package) package=$2 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift 2
done
if [[ -z "$subscription" || -z "$resource_group" || -z "$function_app" || -z "$storage_account" || -z "$blob_name" || -z "$package" ]]; then usage >&2; exit 2; fi
if [[ ! "$storage_account" =~ ^[a-z0-9]{3,24}$ || ! "$blob_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$ || ! -f "$package" ]]; then
  echo 'Use a valid storage account, immutable ZIP filename, and existing package file.' >&2; exit 2
fi
command -v az >/dev/null || { echo 'Azure CLI is required.' >&2; exit 2; }
az storage blob upload --subscription "$subscription" --account-name "$storage_account" \
  --container-name function-packages --name "$blob_name" --file "$package" \
  --auth-mode login --overwrite false --only-show-errors --output none
# The blob URL is not public-access and contains no credential or SAS token.
package_url="https://${storage_account}.blob.core.windows.net/function-packages/${blob_name}"
az functionapp config appsettings set --subscription "$subscription" --resource-group "$resource_group" \
  --name "$function_app" --settings "WEBSITE_RUN_FROM_PACKAGE=$package_url" \
  --only-show-errors --output none
az functionapp restart --subscription "$subscription" --resource-group "$resource_group" \
  --name "$function_app" --only-show-errors --output none
function_id=$(az functionapp show --subscription "$subscription" --resource-group "$resource_group" \
  --name "$function_app" --query id --output tsv --only-show-errors)
az rest --method post --url "https://management.azure.com${function_id}/syncfunctiontriggers?api-version=2016-08-01" \
  --only-show-errors --output none
printf 'API package published. Verify the API using synthetic records before entering financial data.\n'
