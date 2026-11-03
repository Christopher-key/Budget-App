#!/usr/bin/env python3
"""Emergency Azure operator control. Independent admin MFA is a separate boundary."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid

GUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z")
SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
HASH = re.compile(r"[A-Za-z0-9_-]{43}\Z")
MAX_GENERATION = 9_007_199_254_740_991


class ControlError(Exception):
    pass


def valid_state(value):
    if not isinstance(value, dict) or set(value) != {
        'schemaVersion', 'locked', 'generation', 'updatedAt', 'reason',
        'incidentId', 'review', 'handledAlertHashes'
    }:
        raise ControlError('Control state is malformed; leave the API stopped and investigate.')
    if value['schemaVersion'] != 1 or type(value['schemaVersion']) is not int:
        raise ControlError('Unsupported control schema.')
    if type(value['locked']) is not bool or type(value['generation']) is not int or not 1 <= value['generation'] <= MAX_GENERATION:
        raise ControlError('Invalid control generation or gate value.')
    if value['reason'] not in {'initialization', 'manual', 'verified-alert', 'recovery'} or value['review'] not in {'none', 'pending', 'confirmed', 'false-positive', 'remediated'}:
        raise ControlError('Invalid control review metadata.')
    incident = value['incidentId']
    if incident is not None and (not isinstance(incident, str) or not SAFE_ID.fullmatch(incident)):
        raise ControlError('Invalid incident identifier.')
    hashes = value['handledAlertHashes']
    if not isinstance(hashes, list) or len(hashes) > 256 or any(not isinstance(item, str) or not HASH.fullmatch(item) for item in hashes) or len(set(hashes)) != len(hashes):
        raise ControlError('Invalid alert replay metadata.')
    stamp = value['updatedAt']
    try:
        if not isinstance(stamp, str) or len(stamp) > 40 or not stamp.endswith('Z'):
            raise ValueError()
        datetime.fromisoformat(stamp.replace('Z', '+00:00'))
    except ValueError:
        raise ControlError('Invalid control timestamp.') from None
    return value


def transition(current, action, resolution=None, expected_generation=None, now=None):
    """Do not discard alert replay hashes or overwrite an active incident."""
    stamp = now or datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    if current is None:
        if action != 'lock':
            raise ControlError('No control record exists. Initialize with --action lock; this stops the API.')
        return {'schemaVersion': 1, 'locked': True, 'generation': 1,
                'updatedAt': stamp, 'reason': 'initialization',
                'incidentId': str(uuid.uuid4()), 'review': 'pending', 'handledAlertHashes': []}
    valid_state(current)
    result = dict(current)
    result['handledAlertHashes'] = list(current['handledAlertHashes'])
    if expected_generation is not None and current['generation'] != expected_generation:
        raise ControlError('Generation changed. Review the current state before retrying.')
    if action == 'lock':
        if current['locked']:
            return result
        if current['generation'] == MAX_GENERATION:
            raise ControlError('Control generation exhausted; keep the API stopped and investigate.')
        result.update(locked=True, generation=current['generation'] + 1,
                      updatedAt=stamp, reason='manual', incidentId=str(uuid.uuid4()), review='pending')
    elif action == 'confirm':
        if not current['locked']:
            raise ControlError('Only a locked incident can be confirmed.')
        result.update(updatedAt=stamp, review='confirmed')
    elif action == 'reopen':
        if resolution not in {'false-positive', 'remediated'}:
            raise ControlError('Reopening requires --resolution false-positive or remediated.')
        if not current['locked']:
            raise ControlError('The control record is already open. Do not reuse a previous recovery command.')
        if current['generation'] == MAX_GENERATION:
            raise ControlError('Control generation exhausted; keep the API stopped and investigate.')
        result.update(locked=False, generation=current['generation'] + 1,
                      updatedAt=stamp, reason='recovery', review=resolution)
    else:
        raise ControlError('Unknown control action.')
    return valid_state(result)


class AzureControl:
    def __init__(self, args, work):
        self.args = args
        self.work = Path(work)
        self.blob = ['--subscription', args.subscription, '--account-name', args.storage_account,
                     '--container-name', 'service-control', '--name', 'lockdown.json', '--auth-mode', 'login']

    @staticmethod
    def az(arguments, label):
        try:
            result = subprocess.run(['az', *arguments, '--only-show-errors'], capture_output=True,
                                    text=True, timeout=55, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise ControlError(f'Azure could not {label}. No credentials or diagnostics were printed.') from None
        if result.returncode:
            # Raw Azure diagnostics can contain authentication/configuration values.
            raise ControlError(f'Azure could not {label}. Check the scoped operator roles, connectivity and Azure Portal activity log.')
        return result.stdout.strip()

    def read(self):
        present = self.az(['storage', 'blob', 'exists', *self.blob, '--query', 'exists', '--output', 'tsv'], 'check control existence')
        if present.lower() == 'false':
            return None, None
        if present.lower() != 'true':
            raise ControlError('Azure returned an unexpected control existence response.')
        etag = self.az(['storage', 'blob', 'show', *self.blob, '--query', 'properties.etag', '--output', 'tsv'], 'read the control version')
        if not etag or '\n' in etag:
            raise ControlError('Azure returned an invalid control version.')
        path = self.work / 'current.json'
        self.az(['storage', 'blob', 'download', *self.blob, '--if-match', etag,
                 '--file', str(path), '--overwrite', 'true', '--output', 'none'], 'read a consistent control version')
        try:
            if path.stat().st_size > 65_536:
                raise ControlError('Control record is too large; leave the API stopped and investigate.')
            value = json.loads(path.read_text())
        except (OSError, ValueError):
            raise ControlError('Control JSON could not be decoded; leave the API stopped.') from None
        return valid_state(value), etag

    def write(self, value, etag):
        path = self.work / 'next.json'
        try:
            path.write_text(json.dumps(valid_state(value), separators=(',', ':')))
        except OSError:
            raise ControlError('Could not stage control state on the trusted operator device.') from None
        condition = ['--if-match', etag] if etag else ['--if-none-match', '*']
        self.az(['storage', 'blob', 'upload', *self.blob, '--file', str(path), '--overwrite', 'true',
                 '--content-type', 'application/json', *condition, '--output', 'none'],
                'conditionally update control state (a simultaneous alert or operator change requires a fresh review)')

    def power(self, action):
        self.az(['functionapp', action, '--subscription', self.args.subscription, '--resource-group',
                 self.args.resource_group, '--name', self.args.function_app, '--output', 'none'], f'{action} the budget API')


def operate(control, args):
    """Compare-and-swap all changes; an emergency stop must survive blob failures."""
    try:
        current, etag = control.read()
        if args.action == 'status':
            if current is None:
                raise ControlError('No initialized control state exists. Use --action lock before enabling the gate.')
            print(json.dumps({key: current[key] for key in ['locked', 'generation', 'updatedAt', 'reason', 'review', 'incidentId']}, indent=2))
            return
        next_state = transition(current, args.action, args.resolution, args.expected_generation)
        if next_state != current:
            control.write(next_state, etag)
    except ControlError:
        if args.action in {'lock', 'confirm'}:
            try:
                control.power('stop')
            except ControlError:
                raise ControlError('Control state could not be secured, and Azure did not confirm API stop. Stop the budget Function App in Azure Portal immediately; leave the controller running.') from None
            raise ControlError('Budget API stop completed, but control state could not be secured. Leave the API stopped and repair control state before recovery.') from None
        raise
    if args.action in {'lock', 'confirm'}:
        try:
            control.power('stop')
        except ControlError:
            raise ControlError('Control is locked, but Azure did not confirm API stop. Stop the budget Function App in Azure Portal immediately; leave the controller running.') from None
        print(f'Budget API stopped; control locked; generation {next_state["generation"]}. No budget data was erased.')
        return
    # No automatic alert route may execute this branch. A failed start/read-back
    # attempts another CAS lock and always requests stop, preserving replay hashes.
    try:
        control.power('start')
        after, _ = control.read()
        if after is None or after['locked'] or after['generation'] != next_state['generation']:
            raise ControlError('A new incident or control change interrupted recovery.')
    except ControlError:
        try:
            after, after_etag = control.read()
            if after is not None and not after['locked']:
                control.write(transition(after, 'lock'), after_etag)
        except ControlError:
            pass
        try:
            control.power('stop')
        except ControlError:
            raise ControlError('Recovery failed, and Azure did not confirm emergency stop. Stop the budget Function App in Azure Portal immediately and review the control state.') from None
        raise ControlError('Recovery was not verified. API stop completed; control relock was attempted. Review current control state before any further action.') from None
    print(f'Budget API started after explicit {args.resolution} review; generation {next_state["generation"]}. All prior sessions must sign in again.')


def parser():
    result = argparse.ArgumentParser(description=__doc__, epilog='Run only from an approved Azure operator session. This emergency CLI trusts that Azure identity; it does not implement the independently hosted passcode/phone MFA requested for normal recovery.')
    result.add_argument('--subscription', required=True)
    result.add_argument('--resource-group', required=True, help='Budget API resource group (control storage must belong to this deployment).')
    result.add_argument('--function-app', required=True, help='Budget API app, never the independent controller.')
    result.add_argument('--storage-account', required=True, help='Independent security control storage, never budget host storage.')
    result.add_argument('--action', required=True, choices=['status', 'lock', 'confirm', 'reopen'])
    result.add_argument('--resolution', choices=['false-positive', 'remediated'])
    result.add_argument('--expected-generation', type=int, help='Required for confirm/reopen, copied from a fresh --action status review.')
    return result


def main():
    args = parser().parse_args()
    if not GUID.fullmatch(args.subscription) or not re.fullmatch(r'[a-z0-9]{3,24}', args.storage_account):
        raise ControlError('Supply a valid subscription UUID and lowercase storage account name.')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._()-]{0,89}', args.resource_group) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{1,58}[A-Za-z0-9]', args.function_app):
        raise ControlError('Supply valid resource group and Function App names.')
    if args.action in {'confirm', 'reopen'} and (args.expected_generation is None or not 1 <= args.expected_generation <= MAX_GENERATION):
        raise ControlError('Confirm/reopen requires a freshly reviewed --expected-generation.')
    if args.resolution and args.action != 'reopen':
        raise ControlError('--resolution applies only to reopening.')
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='budget-security-') as work:
        control = AzureControl(args, work)
        operate(control, args)


if __name__ == '__main__':
    try:
        main()
    except ControlError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
