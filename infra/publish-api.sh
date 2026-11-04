#!/usr/bin/env bash
set -euo pipefail
umask 077
usage() {
  cat <<'USAGE'
Usage: infra/publish-api.sh --subscription ID --resource-group NAME --function-app NAME --storage-account NAME --blob-name RELEASE.zip --package /absolute/path/RELEASE.zip [--stage-only]

Publishes code to EXISTING backend resources using your Azure CLI identity.
Existing release blobs are reused only when their bytes match the local package.
Does not create resources, enable shared keys, generate SAS tokens, or print app settings.
--stage-only updates the verified package URL without restarting or synchronizing the app.
USAGE
}
subscription=''
resource_group=''
function_app=''
storage_account=''
blob_name=''
package=''
stage_only=false
while (($#)); do
  if [[ "$1" == '--help' || "$1" == '-h' ]]; then usage; exit 0; fi
  if [[ "$1" == '--stage-only' ]]; then stage_only=true; shift; continue; fi
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
if [[ ! "$subscription" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo 'Provide the Azure subscription ID, not its display name.' >&2; exit 2
fi
if [[ ! "$storage_account" =~ ^[a-z0-9]{3,24}$ ]]; then
  echo 'Storage account names must contain 3–24 lowercase letters or digits.' >&2; exit 2
fi
if [[ ! "$blob_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$ ]]; then
  echo 'Use an immutable release ZIP filename without a directory or URL.' >&2; exit 2
fi
if [[ ! -f "$package" ]]; then
  printf 'API ZIP file was not found at: %s\n' "$package" >&2
  echo 'Build the API package or supply the actual path of the inner budget-api.zip.' >&2
  exit 2
fi
command -v python3 >/dev/null || { echo 'Python 3 is required to validate the API package.' >&2; exit 2; }
# Validate before ANY Azure call. Reading only the ZIP directory would accept an
# outer artifact or a damaged package; verify its layout, manifests and CRC too.
package_sha=$(python3 - "$package" <<'PY'
import hashlib, json, pathlib, sys, zipfile
path = pathlib.Path(sys.argv[1])
try:
    if path.stat().st_size > 256 * 1024 * 1024:
        raise ValueError('The API ZIP exceeds the supported package size.')
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError('The API ZIP contains duplicate paths.')
        if any(name.startswith('/') or '..' in pathlib.PurePosixPath(name).parts for name in names):
            raise ValueError('The API ZIP contains unsafe paths.')
        if sum(item.file_size for item in archive.infolist()) > 512 * 1024 * 1024:
            raise ValueError('The expanded API package is too large.')
        if not {'host.json', 'package.json'}.issubset(names):
            raise ValueError('Upload the inner budget-api.zip; host.json and package.json must be at ZIP root.')
        roots = {name.split('/', 1)[0] for name in names}
        if roots - {'host.json', 'package.json', 'package-lock.json', 'dist', 'node_modules'}:
            raise ValueError('The API ZIP contains files outside the code/runtime package layout.')
        for manifest in ['package.json', 'host.json', 'node_modules/@azure/functions/package.json']:
            if manifest not in names or archive.getinfo(manifest).file_size > 1024 * 1024:
                raise ValueError('The API package is missing a required runtime manifest.')
        package = json.loads(archive.read('package.json'))
        if not isinstance(package, dict):
            raise ValueError('The API package manifest must be an object.')
        main = package.get('main')
        if not isinstance(main, str) or not main or main not in names:
            raise ValueError('The package.json API entry point is missing from the ZIP.')
        runtime = json.loads(archive.read('node_modules/@azure/functions/package.json'))
        if not isinstance(runtime, dict):
            raise ValueError('The runtime package manifest must be an object.')
        runtime_main = runtime.get('main')
        if not isinstance(runtime_main, str) or not runtime_main:
            raise ValueError('The Azure Functions runtime entry point is missing.')
        runtime_path = pathlib.PurePosixPath('node_modules/@azure/functions') / runtime_main
        if str(runtime_path) not in names:
            raise ValueError('The ZIP is missing Azure Functions runtime dependencies.')
        host = json.loads(archive.read('host.json'))
        if not isinstance(host, dict) or host.get('version') != '2.0':
            raise ValueError('The API ZIP has an unsupported host.json version.')
        if archive.testzip() is not None:
            raise ValueError('The API ZIP failed its integrity check.')
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    print(digest.hexdigest())
except (OSError, ValueError, KeyError, TypeError, RuntimeError, zipfile.BadZipFile):
    # Do not echo archive contents, manifest values, or arbitrary exception text.
    raise SystemExit('Invalid API ZIP. Use the built inner package with host.json, package.json, its compiled entry point, and production runtime dependencies at ZIP root.')
PY
)
printf 'API package layout and integrity verified.\n'
command -v az >/dev/null || { echo 'Azure CLI is required.' >&2; exit 2; }
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
error_file="$work/azure-error"
blob_args=(--subscription "$subscription" --account-name "$storage_account"
  --container-name function-packages --name "$blob_name" --auth-mode login --only-show-errors)
fail_azure() {
  local operation=$1 details='' code=''
  if [[ -f "$error_file" ]]; then details=$(<"$error_file"); fi
  case "$details" in
    *AuthorizationPermissionMismatch*|*AuthorizationFailed*|*AuthorizationFailure*|*"You do not have the required permissions"*)
      printf 'Azure denied permission to %s.\n' "$operation" >&2
      echo 'Publishing needs Blob Data Contributor on the function-packages container and Website Contributor on this Function App. New grants can take time to apply.' >&2
      ;;
    *)
      printf 'Azure could not %s. The release package is safe to retry once startup or connectivity is restored.\n' "$operation" >&2
      if [[ "$operation" == 'synchronize API routes' ]]; then
        echo 'The Function host may be stopped, starting, or unavailable. Verify host startup before changing access roles; a runtime 403 alone does not establish an Azure permission failure.' >&2
      fi
      ;;
  esac
  for code in AuthorizationPermissionMismatch AuthorizationFailed AuthorizationFailure \
      AuthenticationFailed InvalidAuthenticationInfo ContainerNotFound BlobNotFound \
      ResourceNotFound ServiceUnavailable InternalServerError BadGateway BadRequest Conflict; do
    if [[ "$details" == *"$code"* ]]; then
      printf 'Azure error code: %s\n' "$code" >&2
      break
    fi
  done
  # Azure diagnostics can include confidential configuration; never print them.
  exit 1
}
verify_existing() {
  if ! az storage blob download "${blob_args[@]}" --file "$work/existing.zip" \
      --overwrite false --output none 2> "$error_file"; then
    fail_azure 'read the existing release package'
  fi
  local remote_sha
  remote_sha=$(python3 - "$work/existing.zip" <<'PY'
import hashlib, sys
value = hashlib.sha256()
with open(sys.argv[1], 'rb') as source:
    for block in iter(lambda: source.read(1024 * 1024), b''):
        value.update(block)
print(value.hexdigest())
PY
)
  if [[ "$remote_sha" != "$package_sha" ]]; then
    echo 'This immutable release name already contains different code. It was not overwritten. Use a new release filename for changed code.' >&2
    exit 1
  fi
  printf 'Existing release matches this package; resuming publication.\n'
}
if ! az storage blob exists "${blob_args[@]}" --query exists --output tsv > "$work/exists" 2> "$error_file"; then
  fail_azure 'check the release package'
fi
blob_exists=$(<"$work/exists")
blob_exists=${blob_exists//$'\r'/}
case "$blob_exists" in
  true|True) verify_existing ;;
  false|False)
    printf 'Uploading the immutable API package.\n'
    if ! az storage blob upload "${blob_args[@]}" --file "$package" \
        --overwrite false --output none 2> "$error_file"; then
      upload_error=$(<"$error_file")
      case "$upload_error" in
        *BlobAlreadyExists*|*ResourceExistsError*) verify_existing ;;
        *) fail_azure 'upload the release package' ;;
      esac
    fi
    ;;
  *) echo 'Azure returned an unexpected release-existence response; no Function App change was made.' >&2; exit 1 ;;
esac
package_url="https://${storage_account}.blob.core.windows.net/function-packages/${blob_name}"
printf 'Connecting the Function App to the verified package.\n'
if ! az functionapp config appsettings set --subscription "$subscription" --resource-group "$resource_group" \
    --name "$function_app" --settings "WEBSITE_RUN_FROM_PACKAGE=$package_url" \
    --only-show-errors --output none 2> "$error_file"; then
  fail_azure 'set the Function App package URL'
fi
if "$stage_only"; then
  printf 'API package staged; Function App was not started or restarted.\n'
  exit 0
fi
if ! az functionapp restart --subscription "$subscription" --resource-group "$resource_group" \
    --name "$function_app" --only-show-errors --output none 2> "$error_file"; then
  fail_azure 'restart the Function App'
fi
function_id="/subscriptions/${subscription}/resourceGroups/${resource_group}/providers/Microsoft.Web/sites/${function_app}"
printf 'Synchronizing API routes.\n'
if ! az rest --method post --url "https://management.azure.com${function_id}/syncfunctiontriggers?api-version=2016-08-01" \
    --only-show-errors --output none 2> "$error_file"; then
  fail_azure 'synchronize API routes'
fi
printf 'API package published. Verify the API using synthetic records before entering financial data.\n'
if az functionapp show --subscription "$subscription" --resource-group "$resource_group" \
    --name "$function_app" --query defaultHostName --output tsv --only-show-errors > "$work/host" 2> "$error_file"; then
  public_host=$(<"$work/host")
  public_host=${public_host//$'\r'/}
  if [[ "$public_host" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.azurewebsites\.net$ ]]; then
    printf 'apiBaseUrl: https://%s\n' "$public_host"
  fi
fi
