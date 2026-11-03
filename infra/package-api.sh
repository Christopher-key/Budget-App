#!/usr/bin/env bash
set -euo pipefail
umask 077
if (($# != 1)); then echo 'Usage: infra/package-api.sh /absolute/path/budget-api.zip' >&2; exit 2; fi
command -v npm >/dev/null || { echo 'Node.js and npm are required.' >&2; exit 2; }
command -v python3 >/dev/null || { echo 'Python 3 is required for ZIP packaging.' >&2; exit 2; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository=$(cd -- "$script_dir/.." && pwd)
output=$1
if [[ "$output" != /* || -e "$output" ]]; then echo 'Choose a new absolute ZIP path; existing files are not overwritten.' >&2; exit 2; fi
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
npm run build --prefix "$repository/api"
cp -- "$repository/api/host.json" "$repository/api/package.json" "$repository/api/package-lock.json" "$stage/"
cp -R -- "$repository/api/dist" "$stage/dist"
# Install only locked runtime dependencies. No local .env, tests, or user records
# are copied into the staging directory or resulting ZIP.
npm ci --omit=dev --ignore-scripts --prefix "$stage"
python3 - "$stage" "$output" <<'PY'
import os, pathlib, sys, zipfile
stage = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2])
with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for directory, directories, names in os.walk(stage):
        directories[:] = sorted(name for name in directories if name != '.bin')
        for name in sorted(names):
            path = pathlib.Path(directory) / name
            if path.is_symlink():
                raise SystemExit('Unexpected symbolic link in staged package.')
            relative = path.relative_to(stage).as_posix()
            # npm's internal install bookkeeping is not needed at runtime and
            # can differ between npm versions even with the same lockfile.
            if relative == 'node_modules/.package-lock.json':
                continue
            # Stable metadata makes retries safe after an ephemeral Cloud Shell
            # session: the same source/dependencies reproduce the same ZIP.
            entry = zipfile.ZipInfo(relative, date_time=(2020, 1, 1, 0, 0, 0))
            entry.create_system = 3
            mode = 0o100755 if path.stat().st_mode & 0o111 else 0o100644
            entry.external_attr = mode << 16
            archive.writestr(entry, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED,
                             compresslevel=9)
print('API ZIP created with host.json at its root. It contains code and runtime dependencies only.')
PY
