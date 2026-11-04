#!/usr/bin/env python3
"""Exercise failed, empty and finding-containing analysis reports."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

SPEC = spec_from_file_location('codeql_results', Path(__file__).with_name('check-codeql-results.py'))
CHECK = module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class CodeQLResultsTests(unittest.TestCase):
    def test_completed_empty_run_passes(self):
        self.assertEqual(CHECK.findings({'version': '2.1.0', 'runs': [
            {'results': [], 'invocations': [{'executionSuccessful': True}]}]}), 0)

    def test_findings_are_counted_across_runs(self):
        self.assertEqual(CHECK.findings({'version': '2.1.0', 'runs': [
            {'results': [{'ruleId': 'synthetic-rule'}]}, {'results': [{'ruleId': 'another-rule'}]}]}), 2)

    def test_missing_malformed_or_failed_analysis_does_not_pass(self):
        for value in [None, {}, {'version': '2.1.0', 'runs': []},
                      {'version': '2.1.0', 'runs': [{'results': [], 'invocations': [{'executionSuccessful': False}]}]},
                      {'version': '2.1.0', 'runs': [{}]}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                CHECK.findings(value)
        with TemporaryDirectory() as folder:
            self.assertEqual(CHECK.main(folder), 1)


if __name__ == '__main__':
    unittest.main()
