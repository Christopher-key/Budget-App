#!/usr/bin/env python3
"""Synthetic commissioning checks; never accesses Azure or financial records."""
from copy import deepcopy
from argparse import Namespace
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('lockdown_activation', ROOT / 'infra/enable-lockdown.py')
activation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(activation)


class FakeControl:
    def __init__(self, state=None):
        self.state = deepcopy(state)
        self.version = 1
        self.events = []
        self.start_states = []

    def read(self):
        self.events.append('read')
        return deepcopy(self.state), str(self.version) if self.state else None

    def write(self, state, etag):
        self.events.append('write-open' if not state['locked'] else 'write-locked')
        if etag != (str(self.version) if self.state else None):
            raise activation.CONTROL.ControlError('Synthetic CAS conflict')
        self.state = deepcopy(state)
        self.version += 1

    def power(self, action):
        self.events.append(action)
        if action == 'start':
            self.start_states.append(deepcopy(self.state))


class ActivationTests(unittest.TestCase):
    def metadata_fixture(self):
        subscription = '11111111-2222-3333-4444-555555555555'
        group_id = '/subscriptions/' + subscription + '/resourceGroups/synthetic-group'
        args = Namespace(subscription=subscription, resource_group='synthetic-group',
                         static_web_app='synthetic-web', operator_object_id=None)
        replies = [
            {'state': 'Succeeded', 'functionApp': 'synthetic-budget', 'storage': 'syntheticbudgetstore'},
            {'id': group_id + '/providers/Microsoft.Web/sites/synthetic-budget', 'location': 'East US',
             'plan': group_id + '/providers/Microsoft.Web/serverFarms/existing-plan',
             'principalId': '22222222-2222-3333-4444-555555555555',
             'hostname': 'synthetic-budget.azurewebsites.net', 'state': 'Running'},
            {'hostname': 'synthetic-site.azurestaticapps.net'},
            '44444444-2222-3333-4444-555555555555',
            '44444444-2222-3333-4444-555555555555',
            '33333333-2222-3333-4444-555555555555',
        ]
        return args, replies

    def test_metadata_uses_existing_function_region_and_supported_cli_arguments(self):
        args, replies = self.metadata_fixture()
        with patch.object(activation, 'az', side_effect=replies) as azure:
            result = activation.metadata(args)
        self.assertEqual(result['location'], 'eastus')
        self.assertEqual(result['frontend'], 'https://synthetic-site.azurestaticapps.net')
        calls = [call.args[0] for call in azure.call_args_list]
        self.assertTrue(all('--query' in command for command in calls))
        self.assertFalse(any('appsettings' in command or 'keys' in command for command in calls))
        graph = next(command for command in calls if command[:3] == ['ad', 'signed-in-user', 'show'])
        self.assertNotIn('--subscription', graph, 'Azure CLI ignores this argument for ad signed-in-user.')
        for command in calls[:3]:
            self.assertEqual(command[command.index('--subscription') + 1], args.subscription)

    def test_different_active_tenant_blocks_directory_lookup_before_changes(self):
        args, replies = self.metadata_fixture()
        replies[4] = '55555555-2222-3333-4444-555555555555'
        with patch.object(activation, 'az', side_effect=replies) as azure:
            with self.assertRaisesRegex(activation.ActivationError, 'different tenant'):
                activation.metadata(args)
        self.assertEqual(azure.call_count, 5)
        self.assertFalse(any(call.args[0][:1] == ['ad'] for call in azure.call_args_list))

    def test_explicit_operator_id_avoids_directory_and_active_tenant_lookups(self):
        args, replies = self.metadata_fixture()
        args.operator_object_id = replies[-1]
        with patch.object(activation, 'az', side_effect=replies[:3]) as azure:
            result = activation.metadata(args)
        self.assertEqual(result['operator'], args.operator_object_id)
        self.assertEqual(azure.call_count, 3)

    def test_cli_argument_failure_reports_only_fixed_operation_and_safe_category(self):
        result = Namespace(returncode=2, stdout='', stderr='ERROR: unrecognized arguments: --subscription synthetic-sensitive-value')
        with patch.object(activation.subprocess, 'run', return_value=result):
            with self.assertRaises(activation.ActivationError) as raised:
                activation.az(['ad', 'signed-in-user', 'show', '--query', 'id', '--output', 'json'])
        message = str(raised.exception)
        self.assertIn('signed-in administrator', message)
        self.assertIn('CLI_ARGUMENT_ERROR', message)
        self.assertNotIn('synthetic-sensitive-value', message)

    def test_optional_lookup_does_not_hide_permission_errors_containing_not_found_text(self):
        diagnostics = [
            'ERROR: (AuthorizationFailed) DeploymentNotFound synthetic-sensitive-value',
            'ERROR: {"error":{"code":"AuthorizationFailed","message":"ResourceNotFound synthetic-sensitive-value"}}',
        ]
        for stderr in diagnostics:
            with self.subTest(stderr=stderr):
                with patch.object(activation.subprocess, 'run', return_value=Namespace(returncode=1, stdout='', stderr=stderr)):
                    with self.assertRaises(activation.ActivationError) as raised:
                        activation.az(['deployment', 'group', 'show'], optional=True)
                self.assertIn('AuthorizationFailed', str(raised.exception))
                self.assertNotIn('synthetic-sensitive-value', str(raised.exception))

    def test_optional_lookup_accepts_only_explicit_missing_resource_codes(self):
        for stderr in ['ERROR: (DeploymentNotFound) synthetic-sensitive-value',
                       'ERROR: {"error":{"code":"ResourceNotFound","message":"synthetic-sensitive-value"}}']:
            with patch.object(activation.subprocess, 'run', return_value=Namespace(returncode=1, stdout='', stderr=stderr)):
                self.assertIsNone(activation.az(['deployment', 'group', 'show'], optional=True))

    def test_unknown_errors_and_bad_metadata_never_echo_azure_payloads(self):
        for result in [Namespace(returncode=1, stdout='', stderr='ERROR: (synthetic-sensitive-value) private diagnostic'),
                       Namespace(returncode=0, stdout='synthetic-sensitive-value', stderr='')]:
            with patch.object(activation.subprocess, 'run', return_value=result):
                with self.assertRaises(activation.ActivationError) as raised:
                    activation.az(['functionapp', 'show', '--name', 'synthetic-sensitive-value'])
            self.assertNotIn('synthetic-sensitive-value', str(raised.exception))
            self.assertNotIn('private diagnostic', str(raised.exception))

    def test_unavailable_checked_release_cannot_provision_or_stop_azure_resources(self):
        argv = ['enable-lockdown.py', '--subscription', '11111111-2222-3333-4444-555555555555',
                '--resource-group', 'synthetic-group', '--static-web-app', 'synthetic-web',
                '--release', 'api-build-' + 'a' * 40, '--apply']
        with patch.object(activation.sys, 'argv', argv), \
                patch.object(activation.shutil, 'which', return_value='/synthetic/tool'), \
                patch.object(activation, 'metadata', return_value={}), \
                patch.object(activation, 'download_package', side_effect=activation.ActivationError('Synthetic missing release')), \
                patch.object(activation, 'control_outputs') as provision:
            with self.assertRaises(activation.ActivationError):
                activation.main()
        provision.assert_not_called()

    def run_commission(self, control, **overrides):
        callbacks = {
            'configure_gate': lambda: control.events.append('gate-on'),
            'publish_budget': lambda: control.events.append('stage-package'),
            'synchronize_budget': lambda: control.events.append('sync-routes'),
            'verify_status': lambda state, generation: control.state['locked'] == (state == 'locked') and control.state['generation'] == generation,
            'verify_locked': lambda: control.events.append('verify-locked') or True,
            'verify_open': lambda: control.events.append('verify-open') or True,
        }
        callbacks.update(overrides)
        return activation.commission(control, **callbacks)

    def test_fresh_activation_stages_then_starts_locked_before_synchronization_and_open(self):
        control = FakeControl()
        self.run_commission(control)
        self.assertEqual(control.state['generation'], 2)
        self.assertFalse(control.state['locked'])
        self.assertEqual(control.state['reason'], 'initialization')
        self.assertEqual(control.state['review'], 'none')
        self.assertIsNone(control.state['incidentId'])
        events = control.events
        self.assertLess(events.index('write-locked'), events.index('stop'))
        self.assertLess(events.index('stop'), events.index('gate-on'))
        self.assertLess(events.index('gate-on'), events.index('stage-package'))
        self.assertLess(events.index('verify-locked'), events.index('write-open'))
        self.assertLess(events.index('stage-package'), events.index('start'))
        self.assertLess(events.index('start'), events.index('sync-routes'))
        self.assertLess(events.index('sync-routes'), events.index('verify-locked'))
        self.assertEqual(len(control.start_states), 1)
        self.assertTrue(control.start_states[0]['locked'])
        self.assertEqual(control.start_states[0]['generation'], 1)

    def test_staging_requests_no_publisher_restart_or_sync(self):
        args = Namespace(subscription='11111111-2222-3333-4444-555555555555', resource_group='synthetic-group')
        with patch.object(activation.subprocess, 'run', return_value=Namespace(returncode=0)) as process:
            activation.publish(args, 'synthetic-api', 'syntheticstore', 'synthetic.zip', Path('/synthetic/code.zip'), stage_only=True)
        self.assertIn('--stage-only', process.call_args.args[0])

    def test_route_sync_retries_host_startup_without_requesting_more_privileges(self):
        args = Namespace()
        with patch.object(activation, 'az', side_effect=[activation.ActivationError('Azure host startup (UNCLASSIFIED)'), None]) as azure, \
                patch.object(activation.time, 'sleep') as pause:
            activation.synchronize_routes(args, '/subscriptions/synthetic/providers/Microsoft.Web/sites/synthetic-api', attempts=2)
        self.assertEqual(azure.call_count, 2)
        self.assertEqual(pause.call_count, 1)
        self.assertTrue(all(call.args[0][0] == 'rest' for call in azure.call_args_list))

    def test_real_route_sync_authorization_failure_is_not_retried_as_startup(self):
        with patch.object(activation, 'az', side_effect=activation.ActivationError('Azure operation (AuthorizationFailed)')) as azure, \
                patch.object(activation.time, 'sleep') as pause:
            with self.assertRaisesRegex(activation.ActivationError, 'AuthorizationFailed'):
                activation.synchronize_routes(Namespace(), '/subscriptions/synthetic/providers/Microsoft.Web/sites/synthetic-api')
        self.assertEqual(azure.call_count, 1)
        pause.assert_not_called()

    def test_route_sync_startup_retry_is_bounded_and_retains_safe_error_category(self):
        with patch.object(activation, 'az', side_effect=activation.ActivationError('Azure could not synchronize routes (BadRequest).')) as azure, \
                patch.object(activation.time, 'sleep') as pause:
            with self.assertRaisesRegex(activation.ActivationError, 'BadRequest'):
                activation.synchronize_routes(Namespace(), '/subscriptions/synthetic/providers/Microsoft.Web/sites/synthetic-api', attempts=2)
        self.assertEqual(azure.call_count, 2)
        self.assertEqual(pause.call_count, 1)

    def test_route_sync_failure_after_locked_start_never_opens_and_stops_api(self):
        control = FakeControl()
        def fail():
            control.events.append('sync-routes')
            raise activation.ActivationError('Synthetic host unavailable')
        with self.assertRaises(activation.ActivationError):
            self.run_commission(control, synchronize_budget=fail)
        self.assertEqual(control.events[-1], 'stop')
        self.assertNotIn('write-open', control.events)
        self.assertTrue(control.state['locked'])
        self.assertTrue(control.start_states[0]['locked'])

    def test_existing_manual_or_alert_incident_is_never_reopened_or_published_over(self):
        for reason in ['manual', 'verified-alert', 'recovery']:
            value = activation.CONTROL.transition(None, 'lock')
            value['reason'] = reason
            control = FakeControl(value)
            with self.assertRaises(activation.ActivationError):
                self.run_commission(control)
            self.assertEqual(control.events, ['read'])
            self.assertEqual(control.state, value)

    def test_already_open_or_confirmed_initialization_requires_operator_review(self):
        for patch in [{'locked': False}, {'review': 'confirmed'}, {'generation': 2}, {'handledAlertHashes': ['A' * 43]}]:
            value = {**activation.CONTROL.transition(None, 'lock'), **patch}
            control = FakeControl(value)
            with self.assertRaises(activation.ActivationError):
                self.run_commission(control)
            self.assertNotIn('start', control.events)
            self.assertNotIn('stage-package', control.events)

    def test_controller_failure_does_not_stop_existing_budget(self):
        control = FakeControl()
        with self.assertRaises(activation.ActivationError):
            self.run_commission(control, verify_status=lambda *_: False)
        self.assertNotIn('stop', control.events)
        self.assertNotIn('gate-on', control.events)

    def test_gate_configuration_or_publication_failure_keeps_service_stopped(self):
        def fail():
            raise activation.ActivationError('Synthetic failure')
        for phase in ['configure_gate', 'publish_budget']:
            control = FakeControl()
            with self.assertRaises(activation.ActivationError):
                self.run_commission(control, **{phase: fail})
            self.assertTrue(control.state['locked'])
            self.assertEqual(control.events[-1], 'stop')
            self.assertNotIn('start', control.events)

    def test_failed_locked_api_verification_never_opens(self):
        control = FakeControl()
        with self.assertRaises(activation.ActivationError):
            self.run_commission(control, verify_locked=lambda: False)
        self.assertTrue(control.state['locked'])
        self.assertNotIn('write-open', control.events)
        self.assertEqual(control.events[-1], 'stop')

    def test_alert_during_publication_is_preserved(self):
        control = FakeControl()
        def publish():
            control.events.append('stage-package')
            control.state['reason'] = 'verified-alert'
            control.state['generation'] += 1
            control.state['handledAlertHashes'] = ['B' * 43]
            control.version += 1
        with self.assertRaises(activation.ActivationError):
            self.run_commission(control, publish_budget=publish)
        self.assertEqual(control.state['reason'], 'verified-alert')
        self.assertEqual(control.state['handledAlertHashes'], ['B' * 43])
        self.assertEqual(control.events[-1], 'stop')
        self.assertNotIn('start', control.events)

    def test_etag_change_even_without_metadata_change_prevents_open(self):
        control = FakeControl()
        def verify():
            control.version += 1
            return True
        with self.assertRaises(activation.ActivationError):
            self.run_commission(control, verify_locked=verify)
        self.assertTrue(control.state['locked'])
        self.assertNotIn('write-open', control.events)

    def test_post_open_failure_relocks_and_stops_without_erasing_anything(self):
        control = FakeControl()
        with self.assertRaises(activation.ActivationError):
            self.run_commission(control, verify_open=lambda: False)
        self.assertTrue(control.state['locked'])
        self.assertEqual(control.state['generation'], 3)
        self.assertEqual(control.events[-1], 'stop')

    def test_new_incident_during_start_is_never_replaced_by_rollback(self):
        control = FakeControl()
        def verify():
            control.state['locked'] = True
            control.state['reason'] = 'verified-alert'
            control.state['generation'] = 3
            control.state['handledAlertHashes'] = ['C' * 43]
            control.version += 1
            return False
        with self.assertRaises(activation.ActivationError):
            self.run_commission(control, verify_open=verify)
        self.assertEqual(control.state['reason'], 'verified-alert')
        self.assertEqual(control.state['handledAlertHashes'], ['C' * 43])
        self.assertEqual(control.events[-1], 'stop')


if __name__ == '__main__':
    unittest.main()
