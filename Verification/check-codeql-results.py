#!/usr/bin/env python3
"""Fail on CodeQL findings without printing code snippets or matched values."""
import json
from pathlib import Path
import sys


def findings(document):
    if not isinstance(document, dict) or document.get('version') != '2.1.0':
        raise ValueError('Missing SARIF format.')
    runs = document.get('runs')
    if not isinstance(runs, list) or not runs:
        raise ValueError('Missing analysis runs.')
    count = 0
    for run in runs:
        if not isinstance(run, dict) or not isinstance(run.get('results'), list):
            raise ValueError('Missing analysis results.')
        invocations = run.get('invocations', [])
        if not isinstance(invocations, list) or any(
                not isinstance(item, dict) or item.get('executionSuccessful') is not True
                for item in invocations):
            raise ValueError('Analysis did not finish successfully.')
        count += len(run['results'])
    return count


def main(folder):
    reports = sorted(Path(folder).glob('*.sarif'))
    if not reports:
        print('No CodeQL reports were produced; review the analysis step.', file=sys.stderr)
        return 1
    try:
        count = sum(findings(json.loads(path.read_text(encoding='utf-8'))) for path in reports)
    except (OSError, ValueError, TypeError):
        print('CodeQL results could not be verified; raw diagnostics withheld.', file=sys.stderr)
        return 1
    if count:
        print(f'CodeQL reported {count} security finding(s). Review the source privately; '
              'snippets and matched values were withheld.', file=sys.stderr)
        return 1
    print('CodeQL reported no findings in the selected security queries.')
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Provide the CodeQL output directory.')
    raise SystemExit(main(sys.argv[1]))
