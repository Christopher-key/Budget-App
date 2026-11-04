#!/usr/bin/env python3
"""Regression checks for supply-chain action pinning. No network or Azure calls."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import unittest

SPEC = spec_from_file_location('deployment_workflows', Path(__file__).with_name('check-deployment-workflows.py'))
GUARD = module_from_spec(SPEC)
SPEC.loader.exec_module(GUARD)
SHA = '0123456789abcdef0123456789abcdef01234567'


class WorkflowPinTests(unittest.TestCase):
    def test_accepts_pinned_actions_and_comments(self):
        for value in [f'actions/checkout@{SHA}', f'"actions/checkout@{SHA}" # v4',
                      f"'owner/action/subpath@{SHA}'"]:
            with self.subTest(value=value):
                self.assertEqual(GUARD.check_references('  - uses: ' + value + '\n'), [])

    def test_rejects_mutable_refs_short_shas_and_docker_tags(self):
        for value in ['actions/checkout@v4', 'actions/checkout@main', 'actions/checkout@0123456',
                      'docker://vendor/image:latest', './unreviewed-local-action', '${{ inputs.action }}']:
            with self.subTest(value=value):
                self.assertTrue(GUARD.check_references('  - uses: ' + value + '\n'))

    def test_one_unpinned_action_rejects_the_workflow(self):
        text = f'  - uses: actions/checkout@{SHA}\n  - uses: vendor/deploy@v1\n'
        self.assertEqual(len(GUARD.check_references(text)), 1)

    def test_empty_or_changed_syntax_requires_review(self):
        self.assertTrue(GUARD.check_references('name: Empty\n'))

    def test_current_workflows_are_pinned_including_swift(self):
        self.assertIn('.github/workflows/swift.yml', GUARD.WORKFLOWS)
        self.assertEqual(GUARD.main(), 0)


if __name__ == '__main__':
    unittest.main()
