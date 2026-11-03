#!/usr/bin/env python3
"""Synthetic fail-closed deployment checks. Never contacts Azure."""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
CANARY = 'SYNTHETIC_PRIVATE_DIAGNOSTIC_MUST_NOT_PRINT'


class DeploymentGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='budget-guard-test-')
        self.directory = Path(self.temp.name)
        self.parameters = self.directory / 'private.parameters.json'
        values = {
            'location': 'eastus', 'namePrefix': 'synthetic',
            'frontendOrigin': 'https://synthetic.example',
            'authLookupKey': base64.urlsafe_b64encode(bytes(range(32))).decode().rstrip('='),
            'authPepper': base64.urlsafe_b64encode(bytes(range(32, 64))).decode().rstrip('='),
            'deploymentPackageBlobName': 'synthetic-api.zip',
        }
        self.parameters.write_text(json.dumps({'parameters': {key: {'value': value} for key, value in values.items()}}))
        self.parameters.chmod(0o600)
        self.calls = self.directory / 'calls.jsonl'
        fake = self.directory / 'az'
        fake.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with Path(os.environ['FAKE_AZ_CALLS']).open('a') as out:
    out.write(json.dumps(args) + '\\n')
mode = os.environ['FAKE_AZ_MODE']
if args[:3] == ['deployment', 'group', 'show']:
    if mode.startswith('exists:'):
        print(mode.split(':', 1)[1])
        raise SystemExit(0)
    if mode == 'missing':
        print("ERROR: (DeploymentNotFound) Deployment 'budget-lockdown' could not be found.", file=sys.stderr)
    elif mode == 'resource-missing':
        print('ERROR: {"error":{"code":"ResourceNotFound","message":"synthetic"}}', file=sys.stderr)
    elif mode == 'permission':
        print('ERROR: (AuthorizationFailed) SYNTHETIC_PRIVATE_DIAGNOSTIC_MUST_NOT_PRINT', file=sys.stderr)
    elif mode == 'spoofed-missing':
        print('ERROR: (AuthorizationFailed) incidental DeploymentNotFound text SYNTHETIC_PRIVATE_DIAGNOSTIC_MUST_NOT_PRINT', file=sys.stderr)
    else:
        print('synthetic network failure SYNTHETIC_PRIVATE_DIAGNOSTIC_MUST_NOT_PRINT', file=sys.stderr)
    raise SystemExit(1)
if args[:3] == ['deployment', 'group', 'create']:
    print(json.dumps({'properties': {'provisioningState': 'Succeeded', 'outputs': {}}}))
elif args[:3] == ['deployment', 'group', 'what-if']:
    print(json.dumps({'changes': []}))
else:
    raise SystemExit(2)
''')
        fake.chmod(0o700)
        self.environment = {**os.environ, 'PATH': str(self.directory) + os.pathsep + os.environ['PATH'],
                            'FAKE_AZ_CALLS': str(self.calls)}

    def tearDown(self):
        self.temp.cleanup()

    def run_deployment(self, mode, deploy=True):
        self.environment['FAKE_AZ_MODE'] = mode
        args = ['bash', str(ROOT / 'infra' / 'deploy.sh'), '--subscription',
                '00000000-0000-0000-0000-000000000001', '--resource-group', 'synthetic-group',
                '--parameters', str(self.parameters)]
        if deploy:
            args.append('--deploy')
        result = subprocess.run(args, env=self.environment, capture_output=True, text=True, timeout=20)
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()]
        self.assertNotIn(CANARY, result.stdout + result.stderr)
        private = json.loads(self.parameters.read_text())['parameters']
        for field in ['authLookupKey', 'authPepper']:
            self.assertNotIn(private[field]['value'], result.stdout + result.stderr)
        return result, calls

    def test_no_controller_allows_existing_baseline_deployment(self):
        result, calls = self.run_deployment('missing')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([call[:3] for call in calls], [
            ['deployment', 'group', 'show'], ['deployment', 'group', 'create']])
        guard = calls[0]
        self.assertEqual(guard[guard.index('--name') + 1], 'budget-lockdown')
        self.assertEqual(guard[guard.index('--query') + 1], 'properties.provisioningState')

    def test_structured_resource_not_found_allows_baseline(self):
        result, calls = self.run_deployment('resource-missing')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls[-1][:3], ['deployment', 'group', 'create'])

    def test_any_existing_controller_deployment_blocks_changes(self):
        for state in ['Succeeded', 'Running', 'Failed', 'Accepted', '']:
            with self.subTest(state=state):
                self.calls.unlink(missing_ok=True)
                result, calls = self.run_deployment('exists:' + state)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('does not preserve', result.stderr)
                self.assertEqual(len(calls), 1)

    def test_unknown_permission_network_and_misleading_errors_block(self):
        for mode in ['permission', 'network', 'spoofed-missing']:
            with self.subTest(mode=mode):
                self.calls.unlink(missing_ok=True)
                result, calls = self.run_deployment(mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('could not verify', result.stderr)
                self.assertEqual(len(calls), 1)

    def test_read_only_what_if_remains_available_without_guard(self):
        result, calls = self.run_deployment('exists:Succeeded', deploy=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([call[:3] for call in calls], [['deployment', 'group', 'what-if']])
        self.assertIn('No resource changes applied', result.stdout)


if __name__ == '__main__':
    unittest.main()
