#!/usr/bin/env python3
"""Commission optional lockdown using an existing owner's Azure Cloud Shell login."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen
from uuid import NAMESPACE_URL, uuid5
from zipfile import ZipFile, BadZipFile

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('budget_lockdown_control', ROOT / 'infra/lockdown-control.py')
CONTROL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONTROL)
GUID = re.compile(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z')
GROUP = re.compile(r'[A-Za-z0-9][A-Za-z0-9._()-]{0,89}\Z')
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9-]{1,58}[A-Za-z0-9]\Z')
BLOB_ROLE = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
SAFE_AZURE_CODES = {
    'AuthorizationFailed', 'AuthorizationPermissionMismatch', 'AuthenticationFailed',
    'InvalidAuthenticationToken', 'InvalidAuthenticationTokenTenant', 'ExpiredAuthenticationToken',
    'SubscriptionNotFound', 'ResourceGroupNotFound', 'ResourceNotFound', 'DeploymentNotFound',
    'InvalidTemplateDeployment', 'DeploymentFailed', 'InvalidTemplate', 'BadRequest',
    'MissingSubscriptionRegistration', 'NoRegisteredProviderFound',
    'RoleAssignmentExists', 'PrincipalNotFound', 'RoleDefinitionDoesNotExist',
    'SubscriptionIsOverQuotaForSku', 'ServiceUnavailable', 'TooManyRequests',
}


def operation_label(arguments):
    """Labels contain only fixed command names, never supplied argument values."""
    labels = {
        ('account', 'show'): 'read the Azure subscription context',
        ('deployment', 'group', 'show'): 'read the deployment state',
        ('deployment', 'group', 'create'): 'create the security deployment',
        ('functionapp', 'show'): 'read Function App metadata',
        ('staticwebapp', 'show'): 'read Static Web App metadata',
        ('ad', 'signed-in-user', 'show'): 'look up the signed-in administrator',
        ('role', 'assignment', 'list'): 'check scoped role assignments',
        ('role', 'assignment', 'create'): 'assign a scoped operator role',
        ('role', 'definition', 'list'): 'read a security role definition',
        ('functionapp', 'config', 'appsettings', 'set'): 'enable the budget security gate',
    }
    return next((label for prefix, label in labels.items() if arguments[:len(prefix)] == list(prefix)),
                'complete an Azure operation')


def azure_error_code(message):
    """Extract a known top-level code; never echo diagnostics or arbitrary text."""
    try:
        document = json.loads(re.sub(r'^ERROR:\s*', '', message.strip(), count=1))
        code = document.get('code') or document.get('error', {}).get('code')
        if isinstance(code, str) and code in SAFE_AZURE_CODES:
            return code
    except (ValueError, AttributeError, TypeError):
        pass
    match = re.match(r'^ERROR:\s*\(([A-Za-z][A-Za-z0-9]*)\)(?:\s|$)', message.strip())
    if match and match.group(1) in SAFE_AZURE_CODES:
        return match.group(1)
    if re.search(r'(?m)^ERROR:\s*unrecognized arguments:', message):
        return 'CLI_ARGUMENT_ERROR'
    if re.search(r"(?mi)^ERROR:.*(?:run ['\"]?az login|please log in)", message):
        return 'LOGIN_REQUIRED'
    return 'UNCLASSIFIED'


class ActivationError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def az(arguments, *, optional=False):
    label = operation_label(arguments)
    try:
        result = subprocess.run(['az', *arguments, '--only-show-errors'], capture_output=True,
                                text=True, timeout=55, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ActivationError(f'Azure could not {label} within the time limit. Retry from Azure Cloud Shell; no secret diagnostics were printed.') from None
    if result.returncode:
        code = azure_error_code(result.stderr)
        if optional and code in {'DeploymentNotFound', 'ResourceNotFound'}:
            return None
        raise ActivationError(f'Azure could not {label} ({code}). Check the current login and scoped permissions; credentials and raw diagnostics were not printed.')
    if not result.stdout.strip():
        return None
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise ActivationError(f'Azure returned unexpected metadata while trying to {label}.') from None


def require(condition, message):
    if not condition:
        raise ActivationError(message)


def metadata(args):
    common = ['--subscription', args.subscription, '--resource-group', args.resource_group]
    budget = az(['deployment', 'group', 'show', *common, '--name', 'budget-backend', '--output', 'json', '--query',
                 '{state:properties.provisioningState,functionApp:properties.outputs.functionAppName.value,storage:properties.outputs.hostStorageAccountName.value}'])
    require(isinstance(budget, dict) and budget.get('state') == 'Succeeded' and isinstance(budget.get('functionApp'), str)
            and NAME.fullmatch(budget['functionApp']) and re.fullmatch(r'[a-z0-9]{3,24}', budget.get('storage', '')),
            'The existing budget-backend deployment must have succeeded and contain public Function/storage outputs.')
    function = az(['functionapp', 'show', *common, '--name', budget['functionApp'], '--output', 'json', '--query',
                   '{id:id,location:location,plan:serverFarmId,principalId:identity.principalId,hostname:defaultHostName,state:state}'])
    site = az(['staticwebapp', 'show', *common, '--name', args.static_web_app, '--output', 'json', '--query', '{hostname:defaultHostname}'])
    prefix = f'/subscriptions/{args.subscription}/resourceGroups/{args.resource_group}/providers/'
    require(isinstance(function, dict) and isinstance(function.get('principalId'), str) and GUID.fullmatch(function['principalId'])
            and str(function.get('id', '')).lower() == (prefix + 'Microsoft.Web/sites/' + budget['functionApp']).lower()
            and isinstance(function.get('plan'), str) and function['plan'].lower().startswith(prefix.lower() + 'microsoft.web/serverfarms/')
            and isinstance(function.get('location'), str) and bool(function['location'])
            and re.fullmatch(r'[a-zA-Z0-9.-]+\.azurewebsites\.net', function.get('hostname', '')),
            'Budget Function metadata does not match the requested deployment.')
    require(isinstance(site, dict) and re.fullmatch(r'[a-zA-Z0-9.-]+\.azurestaticapps\.net', site.get('hostname', '')),
            'The Static Web App did not return a recognized public hostname.')
    operator = args.operator_object_id
    if operator is None:
        # This Microsoft Graph command explicitly ignores the CLI subscription
        # argument. Check the tenant context, then omit the unsupported flag.
        selected_tenant = az(['account', 'show', '--subscription', args.subscription,
                              '--query', 'tenantId', '--output', 'json'])
        active_tenant = az(['account', 'show', '--query', 'tenantId', '--output', 'json'])
        require(isinstance(selected_tenant, str) and GUID.fullmatch(selected_tenant)
                and isinstance(active_tenant, str) and selected_tenant.lower() == active_tenant.lower(),
                'The active Azure login uses a different tenant. Select the target subscription with az account set, '
                'or supply the approved user object ID with --operator-object-id. No resources were changed.')
        operator = az(['ad', 'signed-in-user', 'show', '--query', 'id', '--output', 'json'])
    require(isinstance(operator, str) and GUID.fullmatch(operator), 'Supply an approved human operator object ID; automatic discovery requires a user Azure login.')
    require(operator.lower() != function['principalId'].lower(), 'The budget runtime cannot be the security operator.')
    # App Service can return display names such as "East US"; Storage expects
    # the canonical ARM region. Reuse the existing plan's region, never the RG's.
    function['location'] = re.sub(r'\s+', '', function['location']).lower()
    require(re.fullmatch(r'[a-z0-9]+', function['location']), 'The Function returned an unsupported region name.')
    return {**budget, **function, 'frontend': 'https://' + site['hostname'], 'operator': operator,
            'groupId': prefix.rsplit('/providers/', 1)[0]}


def download_package(release, work):
    base = 'https://github.com/Christopher-key/Budget-App/releases/download/' + release
    try:
        with urlopen(base + '/budget-api.zip.sha256', timeout=25) as response:
            checksum = response.read(1025).decode('ascii').strip()
        match = re.fullmatch(r'([0-9a-f]{64})\s+\*?budget-api\.zip', checksum)
        require(match is not None, 'The GitHub checksum document was invalid.')
        package = Path(work) / 'budget-api.zip'
        digest = hashlib.sha256()
        size = 0
        with urlopen(base + '/budget-api.zip', timeout=25) as response, package.open('xb') as target:
            while True:
                data = response.read(1024 * 1024)
                if not data:
                    break
                size += len(data)
                require(size <= 256 * 1024 * 1024, 'The code package exceeded the allowed size.')
                digest.update(data)
                target.write(data)
        require(digest.hexdigest() == match.group(1), 'GitHub package checksum verification failed; nothing was deployed.')
        with ZipFile(package) as archive:
            names = archive.namelist()
            required = {'host.json', 'package.json', 'dist/api/src/functions.js', 'dist/api/src/lockdown.js',
                        'dist/api/src/alerts.js', 'dist/shared/security.js', 'node_modules/@azure/functions/package.json'}
            require(required <= set(names) and len(names) == len(set(names))
                    and all(name.split('/')[0] in {'host.json', 'package.json', 'package-lock.json', 'dist', 'node_modules'}
                            and '..' not in Path(name).parts for name in names)
                    and sum(item.file_size for item in archive.infolist()) <= 512 * 1024 * 1024
                    and archive.testzip() is None, 'The release is not the expected code-only lockdown package.')
            for name in ['host.json', 'package.json', 'node_modules/@azure/functions/package.json']:
                require(archive.getinfo(name).file_size <= 1024 * 1024, 'An API runtime manifest was unexpectedly large.')
            host = json.loads(archive.read('host.json'))
            manifest = json.loads(archive.read('package.json'))
            runtime = json.loads(archive.read('node_modules/@azure/functions/package.json'))
            require(isinstance(host, dict) and isinstance(manifest, dict) and isinstance(runtime, dict)
                    and host.get('version') == '2.0' and manifest.get('main') == 'dist/api/src/functions.js',
                    'The release has an unexpected Azure Functions manifest.')
            runtime_main = runtime.get('main')
            require(isinstance(runtime_main, str) and str(Path('node_modules/@azure/functions') / runtime_main) in names,
                    'The release is missing its Functions runtime entry point.')
        return package
    except ActivationError:
        raise
    except (OSError, ValueError, HTTPError, URLError, BadZipFile):
        raise ActivationError('The checked GitHub API build could not be downloaded or validated. Wait for its Cloud application checks and release publication; the live API was not stopped.') from None


def control_outputs(args, data, work):
    common = ['--subscription', args.subscription, '--resource-group', args.resource_group]
    query = ('{state:properties.provisioningState,functionApp:properties.outputs.functionAppName.value,'
             'storage:properties.outputs.hostStorageAccountName.value,blob:properties.outputs.deploymentPackageBlob.value,'
             'apiBaseUrl:properties.outputs.apiBaseUrl.value,controlBlobUrl:properties.outputs.controlBlobUrl.value,'
             'budgetId:properties.outputs.budgetFunctionResourceId.value}')
    command = ['deployment', 'group', 'show', *common, '--name', 'budget-lockdown', '--query', query, '--output', 'json']
    existing = az(command, optional=True)
    require(existing is None or existing.get('state') not in {'Failed', 'Canceled'},
            'An existing security deployment failed or was canceled. Review its partial resources before retrying; activation will not overwrite controller settings.')
    if existing is None:
        parameters = {'location': data['location'], 'budgetFunctionAppName': data['functionApp'],
                      'budgetFunctionPrincipalId': data['principalId'], 'existingPlanResourceId': data['plan'],
                      'frontendOrigin': data['frontend'], 'operatorObjectIds': [data['operator']],
                      'deploymentPackageBlobName': 'budget-security-' + args.release[-40:-28] + '.zip'}
        path = Path(work) / 'control-parameters.json'
        path.write_text(json.dumps({'parameters': {name: {'value': value} for name, value in parameters.items()}}))
        print('Provisioning the independent security controller and scoped roles; the budget API remains running.', flush=True)
        az(['deployment', 'group', 'create', *common, '--name', 'budget-lockdown',
            '--template-file', str(ROOT / 'infra/lockdown-control.bicep'), '--parameters', '@' + str(path), '--no-wait', '--output', 'none'])
    for attempt in range(180):
        if attempt % 3 == 0:
            print('Waiting for security infrastructure provisioning...', flush=True)
        value = az(command)
        require(isinstance(value, dict), 'Azure did not return the security deployment state.')
        if value.get('state') == 'Succeeded':
            require(str(value.get('budgetId', '')).lower() == data['id'].lower()
                    and isinstance(value.get('functionApp'), str) and NAME.fullmatch(value['functionApp'])
                    and value['functionApp'].lower() != data['functionApp'].lower()
                    and re.fullmatch(r'[a-z0-9]{3,24}', value.get('storage', ''))
                    and value['storage'] != data['storage']
                    and re.fullmatch(r'https://[a-zA-Z0-9.-]+\.azurewebsites\.net', value.get('apiBaseUrl', ''))
                    and value.get('controlBlobUrl') == 'https://' + value['storage'] + '.blob.core.windows.net/service-control/lockdown.json',
                    'Existing security resources do not match this budget deployment. No budget changes were applied.')
            hostname = az(['functionapp', 'show', *common, '--name', value['functionApp'], '--query', 'defaultHostName', '--output', 'json'])
            require(isinstance(hostname, str) and value['apiBaseUrl'] == 'https://' + hostname,
                    'The controller status origin does not match Azure Function metadata.')
            return value
        require(value.get('state') not in {'Failed', 'Canceled'}, 'The security deployment failed. The budget API was not stopped; review Azure Portal deployment operations.')
        time.sleep(5)
    raise ActivationError('Security deployment is still pending. Retry after it completes; the budget API was not stopped.')


def assign_role(args, principal, role, scope):
    assignments = az(['role', 'assignment', 'list', '--subscription', args.subscription, '--scope', scope,
                      '--query', f"[?principalId=='{principal}' && ends_with(roleDefinitionId, '/{role.rsplit('/', 1)[-1]}')].id", '--output', 'json'])
    if assignments:
        return
    az(['role', 'assignment', 'create', '--subscription', args.subscription,
        '--name', str(uuid5(NAMESPACE_URL, scope.lower() + principal.lower() + role.lower())),
        '--assignee-object-id', principal, '--assignee-principal-type', 'User', '--role', role,
        '--scope', scope, '--output', 'none'])


def publisher_access(args, data, control):
    for storage in [data['storage'], control['storage']]:
        scope = data['groupId'] + '/providers/Microsoft.Storage/storageAccounts/' + storage + '/blobServices/default/containers/function-packages'
        assign_role(args, data['operator'], BLOB_ROLE, scope)
    for name, scope in [('Budget lockdown operator control writer', control['controlBlobUrl']),
                        ('Budget API security operator recovery', data['id'])]:
        definitions = az(['role', 'definition', 'list', '--subscription', args.subscription, '--scope', data['groupId'],
                          '--name', name, '--query', '[].id', '--output', 'json'])
        require(isinstance(definitions, list) and len(definitions) == 1 and isinstance(definitions[0], str),
                'The expected scoped security operator role could not be found.')
        if name.endswith('control writer'):
            scope = data['groupId'] + '/providers/Microsoft.Storage/storageAccounts/' + control['storage'] + '/blobServices/default/containers/service-control'
        assign_role(args, data['operator'], definitions[0], scope)


def publish(args, function, storage, blob, package):
    try:
        result = subprocess.run(['bash', str(ROOT / 'infra/publish-api.sh'), '--subscription', args.subscription,
                                 '--resource-group', args.resource_group, '--function-app', function,
                                 '--storage-account', storage, '--blob-name', blob, '--package', str(package)],
                                timeout=300, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ActivationError('Code publication did not finish. Retry using the same immutable release.') from None
    require(result.returncode == 0, 'Code publication failed. Review the publisher message; do not disable the security gate.')


def response_json(url, *, origin=None, body=None):
    headers = {'Accept': 'application/json'}
    if origin:
        headers['Origin'] = origin
    if body is not None:
        headers['Content-Type'] = 'application/json'
    request = Request(url, headers=headers, data=None if body is None else json.dumps(body).encode(),
                      method='GET' if body is None else 'POST')
    try:
        response = build_opener(NoRedirect()).open(request, timeout=15)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read(2049)
        require(len(raw) <= 2048, 'The service did not return the expected bounded public status.')
        return response.status, json.loads(raw)


def wait_for(check, label, attempts=60):
    for attempt in range(attempts):
        try:
            result = check()
            if result:
                return result
        except (ActivationError, CONTROL.ControlError, OSError, ValueError):
            pass
        if attempt % 3 == 0:
            print('Waiting for ' + label + '...', flush=True)
        time.sleep(5)
    raise ActivationError('Could not verify ' + label + '. Leave the budget API stopped if commissioning has started; review roles and service startup before retrying.')


def initial_locked(state):
    return (state is not None and state['locked'] and state['generation'] == 1
            and state['reason'] == 'initialization' and state['review'] == 'pending'
            and not state['handledAlertHashes'])


def commission(control, *, configure_gate, publish_budget, verify_status, verify_locked, verify_open):
    current, etag = control.read()
    if current is None:
        control.write(CONTROL.transition(None, 'lock'), None)
        current, etag = control.read()
    require(initial_locked(current), 'Control is already commissioned or records an incident. Activation will not reopen or overwrite it; use the reviewed operator recovery procedure.')
    require(verify_status('locked', 1), 'The independent controller must report locked generation 1 before budget changes.')
    started = False
    own_open = None
    try:
        started = True
        control.power('stop')
        configure_gate()
        publish_budget()
        require(verify_locked(), 'New API code did not verify the locked gate. Keep the API stopped.')
        require(verify_status('locked', 1), 'The controller changed while commissioning; keep the API stopped.')
        latest, latest_etag = control.read()
        require(latest == current and latest_etag == etag and initial_locked(latest),
                'An operator or alert changed control state. Activation will not overwrite the change.')
        own_open = {**latest, 'locked': False, 'generation': 2, 'reason': 'initialization', 'review': 'none',
                    'incidentId': None, 'updatedAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')}
        control.write(CONTROL.valid_state(own_open), etag)
        control.power('start')
        require(verify_status('open', 2) and verify_open(), 'Commissioning did not verify open service with the gate enabled.')
        after, _ = control.read()
        require(after == own_open, 'A security change interrupted commissioning. The API must remain stopped.')
    except Exception:
        if started:
            if own_open is not None:
                try:
                    after, after_etag = control.read()
                    if after == own_open:
                        control.write(CONTROL.transition(after, 'lock'), after_etag)
                except Exception:
                    pass
            try:
                control.power('stop')
            except Exception:
                raise ActivationError('Commissioning failed and API stop was not confirmed. Stop the budget Function App in Azure Portal immediately.') from None
        raise ActivationError('Commissioning stopped safely. The script requested API stop and retained the gate; inspect control state before recovery. No account data was erased.') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--subscription', required=True)
    parser.add_argument('--resource-group', required=True)
    parser.add_argument('--static-web-app', required=True)
    parser.add_argument('--operator-object-id')
    parser.add_argument('--release', required=True, help='api-build- plus a full checked source commit SHA')
    parser.add_argument('--apply', action='store_true', help='Provision controller, commission the gate, and leave normal service OPEN.')
    args = parser.parse_args()
    require(GUID.fullmatch(args.subscription) and GROUP.fullmatch(args.resource_group) and NAME.fullmatch(args.static_web_app)
            and re.fullmatch(r'api-build-[0-9a-f]{40}', args.release)
            and (args.operator_object_id is None or GUID.fullmatch(args.operator_object_id)), 'Provide valid public resource identifiers and a full API build tag.')
    require(shutil.which('az') and shutil.which('bash'), 'Run this command in Azure Cloud Shell Bash with your existing owner login.')
    os.umask(0o077)
    data = metadata(args)
    if not args.apply:
        print(json.dumps({'mode': 'plan-only', 'budgetFunction': data['functionApp'], 'frontendOrigin': data['frontend'],
                          'existingPlan': data['plan'], 'release': args.release,
                          'changes': ['Independent controller and storage; existing Y1 plan reused', 'Container-scoped code publishing and operator roles',
                                      'Budget gate enabled; initial commissioning leaves service open'],
                          'limits': ['Azure execution/storage usage charges still apply', 'No Duo or paid alert service is connected',
                                     'Website status URL needs a GitHub build configuration update after success']}, indent=2))
        return
    with tempfile.TemporaryDirectory(prefix='budget-lockdown-enable-') as work:
        print('Downloading and verifying the checked API code before any Azure changes...', flush=True)
        package = download_package(args.release, work)
        outputs = control_outputs(args, data, work)
        publisher_access(args, data, outputs)
        control_args = argparse.Namespace(subscription=args.subscription, resource_group=args.resource_group,
                                          function_app=data['functionApp'], storage_account=outputs['storage'])
        control = CONTROL.AzureControl(control_args, work)
        # RBAC propagation checks do not stop or alter the running budget API.
        current, _ = wait_for(lambda: control.read(), 'operator access to security control')
        require(current is None or initial_locked(current), 'Existing control is not an uncommissioned initialization. No automatic recovery will be performed.')
        short_sha = args.release[-40:-28]
        publish(args, outputs['functionApp'], outputs['storage'], 'budget-security-' + short_sha + '.zip', package)
        status_url = outputs['apiBaseUrl'] + '/api/service/status'
        def status_matches(state, generation):
            return wait_for(lambda: response_json(status_url) == (200, {'schemaVersion': 1, 'state': state, 'generation': generation}), 'controller ' + state + ' status')
        def configure_gate():
            print('Enabling the gate while the budget API is stopped; existing account keys are preserved.', flush=True)
            az(['functionapp', 'config', 'appsettings', 'set', '--subscription', args.subscription, '--resource-group', args.resource_group,
                '--name', data['functionApp'], '--settings', 'SECURITY_GATE_ENFORCED=true', 'LOCKDOWN_BLOB_URL=' + outputs['controlBlobUrl'], '--output', 'none'])
        def api_matches(code, status):
            return wait_for(lambda: response_json('https://' + data['hostname'] + '/api/auth/parameters', origin=data['frontend'], body={'username': ''})
                            == (status, {'code': code}), 'budget API ' + code)
        commission(control, configure_gate=configure_gate,
                   publish_budget=lambda: publish(args, data['functionApp'], data['storage'], 'budget-api-security-' + short_sha + '.zip', package),
                   verify_status=status_matches, verify_locked=lambda: api_matches('SERVICE_LOCKED', 503),
                   verify_open=lambda: api_matches('INVALID_DATA', 400))
        print('Budget API lockdown gate enabled; service is OPEN. No user account or financial record was read or changed.')
        print('Automatic alert integration and Duo remain unconfigured. Keep the emergency Azure operator procedure available.')
        print('securityStatusUrl: ' + status_url)
        print('Set the GitHub public variable VITE_SECURITY_STATUS_URL to that URL and rebuild the website, or share ONLY that public URL with Codex to finish the website configuration.')


if __name__ == '__main__':
    try:
        main()
    except (ActivationError, CONTROL.ControlError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
