#!/bin/sh
# Mac command-line verification only; keep Verification out of the iOS app target.
set -eu

if ! command -v swift >/dev/null 2>&1; then
    printf '%s\n' 'Swift is required. Run this script on your Mac with Xcode command-line tools installed.' >&2
    exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
    printf '%s\n' 'Python 3 is required to independently validate the generated Excel packages.' >&2
    exit 2
fi

task_script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
task_source_dir=$(CDPATH= cd "$task_script_dir/.." && pwd)
task_check_dir=$(mktemp -d "${TMPDIR:-/tmp}/budget-excel-checks.XXXXXX")
trap 'rm -rf "$task_check_dir"' EXIT HUP INT TERM
task_check_file="$task_check_dir/ExcelChecks.swift"

printf 'import Foundation\n\n' > "$task_check_file"
awk '
    /^\/\/ MARK: - Saved budget data$/ { found = 1; in_models = 1; next }
    /^final class BudgetStore:/ {
        if (in_models) { stopped = 1; exit }
    }
    in_models { print }
    END {
        if (!found || !stopped) {
            print "Could not locate the actual model boundaries in ContentView.swift" > "/dev/stderr"
            exit 2
        }
    }
' "$task_source_dir/ContentView.swift" >> "$task_check_file"
printf '\n' >> "$task_check_file"
cat "$task_source_dir/ExcelExport.swift" >> "$task_check_file"
printf '\n' >> "$task_check_file"
cat "$task_script_dir/ExcelExportChecks.swift" >> "$task_check_file"

# Both commands retain their actual failure status. No personal records are used.
swift "$task_check_file" "$task_check_dir"
python3 "$task_script_dir/check-excel-package.py" "$task_check_dir"
