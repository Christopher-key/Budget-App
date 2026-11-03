#!/usr/bin/env python3
"""Synthetic operator-control checks. No Azure credentials or financial records."""
from contextlib import redirect_stdout
from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('lockdown_control', ROOT / 'infra' / 'lockdown-control.py')
control = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(control)


def options(action, generation=None, resolution=None):
    return SimpleNamespace(action=action, expected_generation=generation, resolution=resolution)


class FakeControl:
    def __init__(self, value=None):
        self.value = deepcopy(value)
        self.version = 1
        self.events = []
        self.fail_read = False
        self.fail_write = False
        self.fail_start = False
        self.fail_stop = False
        self.on_start = None

    def read(self):
        self.events.append('read')
        if self.fail_read:
            raise control.ControlError('Synthetic read failure')
        return deepcopy(self.value), str(self.version) if self.value else None

    def write(self, value, etag):
        self.events.append('write')
        if self.fail_write or etag != (str(self.version) if self.value else None):
            raise control.ControlError('Synthetic CAS failure')
        self.value = deepcopy(value)
        self.version += 1

    def power(self, action):
        self.events.append(action)
        if (action == 'start' and self.fail_start) or (action == 'stop' and self.fail_stop):
            raise control.ControlError('Synthetic power failure')
        if action == 'start' and self.on_start:
            self.on_start(self)


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.locked = control.transition(None, 'lock', now='2026-11-03T12:00:00.000Z')
        self.open = control.transition(self.locked, 'reopen', 'false-positive', 1)

    def run_action(self, fake, args):
        with redirect_stdout(io.StringIO()) as output:
            control.operate(fake, args)
        return output.getvalue()

    def test_initialization_is_locked_and_stops_api(self):
        fake = FakeControl()
        self.run_action(fake, options('lock'))
        self.assertTrue(fake.value['locked'])
        self.assertEqual(fake.value['generation'], 1)
        self.assertEqual(fake.events, ['read', 'write', 'stop'])

    def test_missing_state_cannot_reopen(self):
        fake = FakeControl()
        with self.assertRaises(control.ControlError):
            self.run_action(fake, options('reopen', 1, 'remediated'))
        self.assertNotIn('start', fake.events)

    def test_confirm_records_review_and_keeps_service_stopped(self):
        fake = FakeControl(self.locked)
        self.run_action(fake, options('confirm', 1))
        self.assertTrue(fake.value['locked'])
        self.assertEqual(fake.value['review'], 'confirmed')
        self.assertEqual(fake.value['generation'], 1)
        self.assertEqual(fake.events[-1], 'stop')

    def test_stale_generation_never_starts(self):
        fake = FakeControl(self.locked)
        with self.assertRaises(control.ControlError):
            self.run_action(fake, options('reopen', 2, 'remediated'))
        self.assertEqual(fake.value, self.locked)
        self.assertNotIn('start', fake.events)

    def test_reopen_requires_explicit_resolution(self):
        fake = FakeControl(self.locked)
        with self.assertRaises(control.ControlError):
            self.run_action(fake, options('reopen', 1))
        self.assertNotIn('start', fake.events)

    def test_reopen_preserves_replay_hashes_and_invalidates_sessions(self):
        self.locked['handledAlertHashes'] = ['A' * 43]
        fake = FakeControl(self.locked)
        self.run_action(fake, options('reopen', 1, 'remediated'))
        self.assertEqual(fake.events, ['read', 'write', 'start', 'read'])
        self.assertFalse(fake.value['locked'])
        self.assertEqual(fake.value['generation'], 2)
        self.assertEqual(fake.value['handledAlertHashes'], ['A' * 43])

    def test_repeated_lock_retains_active_incident(self):
        fake = FakeControl(self.locked)
        self.run_action(fake, options('lock'))
        self.assertEqual(fake.value, self.locked)
        self.assertEqual(fake.events, ['read', 'stop'])

    def test_read_failure_still_stops_api(self):
        fake = FakeControl(self.open)
        fake.fail_read = True
        with self.assertRaisesRegex(control.ControlError, 'stop completed'):
            self.run_action(fake, options('lock'))
        self.assertEqual(fake.events, ['read', 'stop'])

    def test_invalid_control_still_stops_api(self):
        fake = FakeControl({'invalid': True})
        with self.assertRaisesRegex(control.ControlError, 'stop completed'):
            self.run_action(fake, options('lock'))
        self.assertEqual(fake.events[-1], 'stop')

    def test_cas_failure_still_stops_and_never_overwrites(self):
        fake = FakeControl(self.open)
        fake.fail_write = True
        with self.assertRaisesRegex(control.ControlError, 'stop completed'):
            self.run_action(fake, options('lock'))
        self.assertEqual(fake.value, self.open)
        self.assertEqual(fake.events[-1], 'stop')

    def test_failed_control_and_stop_require_emergency_action(self):
        fake = FakeControl(self.open)
        fake.fail_read = fake.fail_stop = True
        with self.assertRaisesRegex(control.ControlError, 'Stop the budget Function App in Azure Portal immediately'):
            self.run_action(fake, options('lock'))

    def test_failed_start_attempts_relock_and_stop(self):
        fake = FakeControl(self.locked)
        fake.fail_start = True
        with self.assertRaisesRegex(control.ControlError, 'API stop completed'):
            self.run_action(fake, options('reopen', 1, 'remediated'))
        self.assertTrue(fake.value['locked'])
        self.assertEqual(fake.value['generation'], 3)
        self.assertEqual(fake.events[-1], 'stop')

    def test_new_alert_during_start_is_preserved_and_api_stopped(self):
        fake = FakeControl(self.locked)
        def alert(value):
            value.value = control.transition(value.value, 'lock')
            value.value['reason'] = 'verified-alert'
            value.value['handledAlertHashes'] = ['B' * 43]
            value.version += 1
        fake.on_start = alert
        with self.assertRaises(control.ControlError):
            self.run_action(fake, options('reopen', 1, 'remediated'))
        self.assertTrue(fake.value['locked'])
        self.assertEqual(fake.value['reason'], 'verified-alert')
        self.assertEqual(fake.value['handledAlertHashes'], ['B' * 43])
        self.assertEqual(fake.events[-1], 'stop')

    def test_status_only_prints_bounded_metadata(self):
        fake = FakeControl(self.locked)
        result = json.loads(self.run_action(fake, options('status')))
        self.assertNotIn('handledAlertHashes', result)
        self.assertEqual(fake.events, ['read'])

    def test_generation_exhaustion_and_malformed_hashes_fail_closed(self):
        self.open['generation'] = control.MAX_GENERATION
        with self.assertRaises(control.ControlError):
            control.transition(self.open, 'lock')
        self.locked['handledAlertHashes'] = ['not-a-valid-hash']
        with self.assertRaises(control.ControlError):
            control.transition(self.locked, 'reopen', 'remediated', 1)

    def test_azure_cas_read_and_write_use_login_and_conditions(self):
        args = SimpleNamespace(subscription='00000000-0000-0000-0000-000000000001',
                               storage_account='syntheticsecurity', resource_group='synthetic', function_app='synthetic-api')
        with tempfile.TemporaryDirectory() as directory:
            client = control.AzureControl(args, directory)
            calls = []
            def az(arguments, label):
                calls.append(arguments)
                if arguments[:3] == ['storage', 'blob', 'exists']:
                    return 'true'
                if arguments[:3] == ['storage', 'blob', 'show']:
                    return 'etag-1'
                if arguments[:3] == ['storage', 'blob', 'download']:
                    Path(arguments[arguments.index('--file') + 1]).write_text(json.dumps(self.locked))
                return ''
            client.az = az
            value, etag = client.read()
            client.write(control.transition(value, 'reopen', 'remediated', 1), etag)
            client.write(self.locked, None)
            for call in calls:
                self.assertEqual(call[call.index('--auth-mode') + 1], 'login')
                self.assertNotIn('--account-key', call)
                self.assertNotIn('--sas-token', call)
            self.assertIn('--if-match', calls[2])
            self.assertEqual(calls[3][calls[3].index('--if-match') + 1], 'etag-1')
            self.assertEqual(calls[4][calls[4].index('--if-none-match') + 1], '*')


if __name__ == '__main__':
    unittest.main()
