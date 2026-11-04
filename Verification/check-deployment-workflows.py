#!/usr/bin/env python3
"""Keep third-party workflow actions on explicit commits. No network access.

This checks action references, not the full YAML or the vendor's transitive
dependencies. Azure's pinned action still uses its vendor-maintained container.
"""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = tuple(str(path.relative_to(ROOT)) for path in
                  sorted((ROOT / '.github/workflows').glob('*'))
                  if path.suffix in {'.yml', '.yaml'})
USES = re.compile(r'^\s*(?:-\s*)?uses\s*:\s*(.*?)\s*$', re.MULTILINE)
PIN = re.compile(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}')


def check_references(text):
    errors = []
    references = list(USES.finditer(text))
    if not references:
        errors.append('No action references found; review the workflow syntax.')
    for match in references:
        reference = match[1].split('#', 1)[0].strip().strip('"\'')
        if not PIN.fullmatch(reference):
            line = text.count('\n', 0, match.start()) + 1
            errors.append(f'Line {line}: use a full 40-character action commit SHA.')
    return errors


def main():
    errors = []
    for name in WORKFLOWS:
        errors.extend(f'{name}: {error}' for error in check_references((ROOT / name).read_text()))
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        return 1
    print('GitHub workflow action references use full commit SHAs.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
