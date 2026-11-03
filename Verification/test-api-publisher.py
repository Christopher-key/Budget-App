#!/usr/bin/env python3
"""Exercise publisher safety with synthetic packages and a local fake Azure CLI."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

PUBLISHER = Path(__file__).resolve().parents[1] / 'infra' / 'publish-api.sh'
GITHUB_PUBLISHER = PUBLISHER.with_name('publish-github-build.sh')
SUBSCRIPTION = '11111111-2222-3333-4444-555555555555'
FAKE_AZ = r'''#!/usr/bin/env python3
import json, os
from pathlib import Path
import shutil
import sys
root = Path(os.environ['FAKE_AZ_STATE'])
args = sys.argv[1:]
with (root / 'calls.jsonl').open('a') as log:
    log.write(json.dumps(args) + '\n')
mode = (root / 'mode').read_text()
def option(name):
    return args[args.index(name) + 1]
def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)
if 'keys' in args or 'generate-sas' in args or 'connection-string' in args:
    fail('Forbidden credential retrieval')
if args[:2] == ['account', 'show']:
    assert option('--query') == 'id'
    print('11111111-2222-3333-4444-555555555555')
elif args[:3] == ['deployment', 'group', 'show']:
    assert option('--name') == os.environ.get('FAKE_DEPLOYMENT_NAME', 'budget-backend')
    assert 'parameters' not in option('--query')
    assert 'properties.outputs' in option('--query')
    print(json.dumps({'state': 'Failed' if mode == 'deployment-failed' else 'Succeeded',
                     'functionApp': 'synthetic-app', 'storage': 'syntheticstore', 'blob': 'release-001.zip'}))
elif args[:2] == ['storage', 'blob']:
    assert option('--auth-mode') == 'login'
    assert option('--container-name') == 'function-packages'
    if mode == 'exists-forbidden' and args[2] == 'exists':
        fail('AuthorizationPermissionMismatch Bearer synthetic-sensitive-token')
    if mode == 'english-forbidden' and args[2] == 'exists':
        fail('You do not have the required permissions needed to perform this operation. Bearer synthetic-sensitive-token')
    blob = root / 'remote.zip'
    if args[2] == 'exists':
        print('true' if blob.exists() else 'false')
    elif args[2] == 'download':
        assert option('--overwrite') == 'false'
        assert option('--output') == 'none'
        shutil.copyfile(blob, option('--file'))
    elif args[2] == 'upload':
        assert option('--overwrite') == 'false'
        assert option('--output') == 'none'
        if mode == 'upload-forbidden':
            fail('AuthorizationPermissionMismatch Bearer synthetic-sensitive-token')
        if mode in ('race-same', 'race-different') and not blob.exists():
            if mode == 'race-same':
                shutil.copyfile(option('--file'), blob)
            else:
                blob.write_bytes(b'different synthetic package')
            fail('BlobAlreadyExists')
        if blob.exists(): fail('BlobAlreadyExists')
        shutil.copyfile(option('--file'), blob)
    else:
        fail('Unexpected blob operation')
elif args[:4] == ['functionapp', 'config', 'appsettings', 'set']:
    assert option('--output') == 'none'
    assert option('--settings') == 'WEBSITE_RUN_FROM_PACKAGE=https://syntheticstore.blob.core.windows.net/function-packages/' + os.environ.get('FAKE_RELEASE_BLOB', 'release-001.zip')
    if mode == 'settings-fail': fail('synthetic private server configuration must not be printed')
elif args[:2] == ['functionapp', 'restart']:
    assert option('--output') == 'none'
elif args[:2] == ['functionapp', 'show']:
    assert option('--query') == 'defaultHostName'
    print('synthetic-app.azurewebsites.net')
elif args[:1] == ['rest']:
    assert option('--method') == 'post'
    assert option('--url') == 'https://management.azure.com/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/synthetic-group/providers/Microsoft.Web/sites/synthetic-app/syncfunctiontriggers?api-version=2016-08-01'
    assert option('--output') == 'none'
    marker = root / 'sync-failed'
    if mode == 'sync-once' and not marker.exists():
        marker.write_text('yes')
        fail('ServiceUnavailable synthetic-sensitive-token')
else:
    fail('Unexpected Azure command')
'''

FAKE_CURL = r'''#!/usr/bin/env python3
import hashlib, os
from pathlib import Path
import shutil, sys
root = Path(os.environ['FAKE_AZ_STATE'])
args = sys.argv[1:]
url = next(value for value in args if value.startswith('https://'))
assert url.startswith('https://github.com/Christopher-key/Budget-App/releases/download/api-build-')
assert not any(value in args for value in ['--user', '--data', '--header'])
with (root / 'downloads').open('a') as log:
    log.write(url + '\n')
output = Path(args[args.index('--output') + 1])
source = Path(os.environ['FAKE_CURL_PACKAGE'])
if url.endswith('/budget-api.zip.sha256'):
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if (root / 'mode').read_text() == 'bad-checksum': digest = '0' * 64
    output.write_text(digest + '  budget-api.zip\n')
elif url.endswith('/budget-api.zip'):
    shutil.copyfile(source, output)
else:
    raise SystemExit('Unexpected download')
'''


def make_package(path, *, private=False, missing_runtime=False, bad_main=False):
    files = {
        'host.json': json.dumps({'version': '2.0'}),
        'package.json': json.dumps({'main': 'dist/api/src/missing.js' if bad_main else 'dist/api/src/functions.js'}),
        'package-lock.json': '{}',
        'dist/api/src/functions.js': '// Synthetic code only.\n',
        'node_modules/@azure/functions/package.json': json.dumps({'main': './dist/azure-functions.js'}),
        'node_modules/@azure/functions/dist/azure-functions.js': '// Synthetic runtime only.\n',
    }
    if missing_runtime:
        files.pop('node_modules/@azure/functions/dist/azure-functions.js')
    if private:
        files['.env'] = 'SYNTHETIC_ONLY=must-not-be-printed'
    with zipfile.ZipFile(path, 'w') as archive:
        for name, contents in files.items():
            archive.writestr(name, contents)


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='synthetic-api-publisher-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.state = self.root / 'state'
        self.state.mkdir()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        fake = self.bin / 'az'
        fake.write_text(FAKE_AZ)
        fake.chmod(0o700)
        (self.state / 'mode').write_text('normal')
        self.package = self.root / 'budget-api.zip'
        make_package(self.package)

    def calls(self):
        path = self.state / 'calls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def run_publisher(self, package=None, mode=None):
        if mode:
            (self.state / 'mode').write_text(mode)
        env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'], FAKE_AZ_STATE=str(self.state))
        return subprocess.run([
            'bash', str(PUBLISHER), '--subscription', SUBSCRIPTION,
            '--resource-group', 'synthetic-group', '--function-app', 'synthetic-app',
            '--storage-account', 'syntheticstore', '--blob-name', 'release-001.zip',
            '--package', str(package or self.package),
        ], env=env, capture_output=True, text=True, timeout=15)

    def run_github_publisher(self, *, mode='normal', release=None, extra=None, deployment=None, blob=None):
        (self.state / 'mode').write_text(mode)
        curl = self.bin / 'curl'
        curl.write_text(FAKE_CURL)
        curl.chmod(0o700)
        for name in ['node', 'npm']:
            executable = self.bin / name
            executable.write_text('#!/bin/sh\nprintf "Unexpected local build" >&2\nexit 99\n')
            executable.chmod(0o700)
        env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                   FAKE_AZ_STATE=str(self.state), FAKE_CURL_PACKAGE=str(self.package))
        if deployment:
            env['FAKE_DEPLOYMENT_NAME'] = deployment
        if blob:
            env['FAKE_RELEASE_BLOB'] = blob
        return subprocess.run([
            'bash', str(GITHUB_PUBLISHER), '--subscription', SUBSCRIPTION,
            '--resource-group', 'synthetic-group', '--release', release or 'api-build-' + 'a' * 40,
        ] + (extra or []), env=env, capture_output=True, text=True, timeout=15)

    def test_controller_deployment_and_new_immutable_release_can_be_selected(self):
        result = self.run_github_publisher(
            extra=['--deployment-name', 'budget-security', '--blob-name', 'security-release-002.zip'],
            deployment='budget-security', blob='security-release-002.zip')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('API package published.', result.stdout)
        upload = next(call for call in self.calls() if call[:3] == ['storage', 'blob', 'upload'])
        self.assertEqual(upload[upload.index('--name') + 1], 'security-release-002.zip')
        self.assertEqual(upload[upload.index('--overwrite') + 1], 'false')

    def test_unsafe_controller_deployment_or_release_names_are_rejected(self):
        for extra in [['--deployment-name', '../other'], ['--blob-name', '../private.zip']]:
            result = self.run_github_publisher(extra=extra)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(self.calls(), [])

    def assert_no_function_mutation(self):
        self.assertFalse(any(call[0] in ['functionapp', 'rest'] for call in self.calls()))

    def test_missing_path_has_specific_error_before_azure(self):
        result = self.run_publisher(self.root / 'missing.zip')
        self.assertEqual(result.returncode, 2)
        self.assertIn('API ZIP file was not found at:', result.stderr)
        self.assertEqual(self.calls(), [])

    def test_outer_artifact_and_unsafe_packages_never_reach_azure(self):
        outer = self.root / 'budget-api-package.zip'
        with zipfile.ZipFile(outer, 'w') as archive:
            archive.write(self.package, 'budget-api.zip')
        invalids = [outer]
        for name, options in [('private', {'private': True}), ('missing-runtime', {'missing_runtime': True}), ('missing-entry', {'bad_main': True})]:
            path = self.root / (name + '.zip')
            make_package(path, **options)
            invalids.append(path)
        for path in invalids:
            with self.subTest(path=path.name):
                result = self.run_publisher(path)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Invalid API ZIP', result.stderr)
                self.assertNotIn('must-not-be-printed', result.stdout + result.stderr)
                self.assertEqual(self.calls(), [])

    def test_first_publish_is_immutable_and_never_reads_secrets(self):
        result = self.run_publisher()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('API package published.', result.stdout)
        self.assertIn('apiBaseUrl: https://synthetic-app.azurewebsites.net', result.stdout)
        self.assertEqual((self.state / 'remote.zip').read_bytes(), self.package.read_bytes())
        upload = next(call for call in self.calls() if call[:3] == ['storage', 'blob', 'upload'])
        self.assertEqual(upload[upload.index('--overwrite') + 1], 'false')
        self.assertFalse(any(call[:4] == ['functionapp', 'config', 'appsettings', 'list'] for call in self.calls()))

    def test_matching_existing_bytes_resume_without_upload(self):
        (self.state / 'remote.zip').write_bytes(self.package.read_bytes())
        result = self.run_publisher()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Existing release matches', result.stdout)
        self.assertFalse(any(call[:3] == ['storage', 'blob', 'upload'] for call in self.calls()))
        self.assertTrue(any(call[:3] == ['storage', 'blob', 'download'] for call in self.calls()))

    def test_different_existing_bytes_are_not_overwritten_or_activated(self):
        original = b'a different synthetic deployed package'
        (self.state / 'remote.zip').write_bytes(original)
        result = self.run_publisher()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('already contains different code', result.stderr)
        self.assertEqual((self.state / 'remote.zip').read_bytes(), original)
        self.assert_no_function_mutation()
        self.assertFalse(any(call[:3] == ['storage', 'blob', 'upload'] for call in self.calls()))

    def test_permission_failures_hide_diagnostics_and_do_not_change_function(self):
        for mode in ['exists-forbidden', 'upload-forbidden', 'english-forbidden']:
            with self.subTest(mode=mode):
                result = self.run_publisher(mode=mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Blob Data Contributor', result.stderr)
                self.assertNotIn('synthetic-sensitive-token', result.stdout + result.stderr)
                self.assertFalse((self.state / 'remote.zip').exists())
                self.assert_no_function_mutation()

    def test_same_byte_upload_race_safely_resumes(self):
        result = self.run_publisher(mode='race-same')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Existing release matches', result.stdout)

    def test_different_byte_upload_race_is_rejected(self):
        result = self.run_publisher(mode='race-different')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('already contains different code', result.stderr)
        self.assert_no_function_mutation()

    def test_sync_failure_can_resume_same_blob_on_second_attempt(self):
        first = self.run_publisher(mode='sync-once')
        self.assertNotEqual(first.returncode, 0)
        self.assertNotIn('synthetic-sensitive-token', first.stdout + first.stderr)
        second = self.run_publisher()
        self.assertEqual(second.returncode, 0, second.stderr)
        uploads = [call for call in self.calls() if call[:3] == ['storage', 'blob', 'upload']]
        self.assertEqual(len(uploads), 1)
        self.assertIn('Existing release matches', second.stdout)

    def test_failed_settings_do_not_restart_or_sync_or_leak_configuration(self):
        result = self.run_publisher(mode='settings-fail')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('synthetic private server configuration', result.stdout + result.stderr)
        self.assertFalse(any(call[:2] == ['functionapp', 'restart'] or call[:1] == ['rest'] for call in self.calls()))

    def test_github_build_downloads_and_publishes_without_running_node_or_npm(self):
        result = self.run_github_publisher()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('GitHub build checksum verified.', result.stdout)
        self.assertIn('API package published.', result.stdout)
        self.assertEqual((self.state / 'remote.zip').read_bytes(), self.package.read_bytes())
        self.assertEqual(len((self.state / 'downloads').read_text().splitlines()), 2)
        self.assertFalse(any('keys' in call or 'create' in call for call in self.calls()))

    def test_github_checksum_mismatch_stops_before_upload_or_function_changes(self):
        result = self.run_github_publisher(mode='bad-checksum')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('failed checksum verification', result.stderr)
        self.assertFalse((self.state / 'remote.zip').exists())
        self.assert_no_function_mutation()
        self.assertFalse(any(call[:2] == ['storage', 'blob'] for call in self.calls()))

    def test_github_build_requires_completed_infrastructure_before_downloading(self):
        result = self.run_github_publisher(mode='deployment-failed')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Complete the existing backend deployment', result.stderr)
        self.assertFalse((self.state / 'downloads').exists())
        self.assert_no_function_mutation()

    def test_github_release_selector_rejects_untrusted_paths_before_any_access(self):
        result = self.run_github_publisher(release='../untrusted')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.calls(), [])
        self.assertFalse((self.state / 'downloads').exists())


if __name__ == '__main__':
    unittest.main()
