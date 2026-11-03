#!/usr/bin/env bash
# Read selected ARM/RBAC metadata only; no credentials, settings, or data reads.
set -euo pipefail
exec python3 - "$@" <<'PY'
import argparse
import json
import re
import shutil
import subprocess
from urllib.parse import urlparse

parser = argparse.ArgumentParser(description=(
    'Inventory selected security properties and assigned roles on existing budget resources. '
    'Reads public budget-backend deployment outputs and ARM/RBAC metadata only. '
    'Does not inspect app settings, keys, tokens, blobs, user records, directory memberships, '
    'or eligible/PIM roles; this is not a complete effective-access assessment.'))
parser.add_argument('--subscription', required=True, help='Subscription UUID; no default subscription is changed.')
parser.add_argument('--resource-group', required=True)
parser.add_argument('--control-storage-account', help='Optional independent lockdown account to include.')
parser.add_argument('--control-container', help='Required with --control-storage-account; never reads its blobs.')
parser.add_argument('--control-resource-group', help='Control account group; defaults to --resource-group.')
args = parser.parse_args()
patterns = {
    'subscription': r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}',
    'group': r'[A-Za-z0-9][A-Za-z0-9._()\-]{0,89}',
    'storage': r'[a-z0-9]{3,24}',
    'container': r'[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])',
    'functionApp': r'[A-Za-z0-9][A-Za-z0-9-]{0,59}',
    'cosmos': r'[a-z0-9][a-z0-9-]{1,42}[a-z0-9]',
    'cosmosName': r'[^/\\?#\x00-\x1f]{1,255}',
}
def valid(value, kind):
    return isinstance(value, str) and re.fullmatch(patterns[kind], value) is not None

if not valid(args.subscription, 'subscription') or not valid(args.resource_group, 'group'):
    parser.error('provide a subscription UUID and valid resource-group name')
if bool(args.control_storage_account) != bool(args.control_container):
    parser.error('--control-storage-account and --control-container must be supplied together')
if args.control_resource_group and not args.control_storage_account:
    parser.error('--control-resource-group requires --control-storage-account')
if args.control_storage_account and (not valid(args.control_storage_account, 'storage')
                                    or not valid(args.control_container, 'container')):
    parser.error('provide valid control storage account and container names')
control_group = args.control_resource_group or args.resource_group
if not valid(control_group, 'group'):
    parser.error('provide a valid control resource-group name')
if not shutil.which('az'):
    parser.exit(2, 'Azure CLI is required; use Azure Cloud Shell Bash.\n')

def read(label, command, query):
    command = ['az', *command, '--subscription', args.subscription, '--query', query,
               '--output', 'json', '--only-show-errors']
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=True, timeout=60)
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        # Do not print raw Azure diagnostics or partially collected inventory.
        parser.exit(1, f'Could not read {label}; check login, resource names, and scoped read permissions. No complete inventory was produced.\n')

def shape(value, kind, label):
    if not isinstance(value, kind):
        parser.exit(1, f'Azure returned unexpected {label} metadata. No complete inventory was produced.\n')
    return value

outputs = shape(read('public deployment outputs', [
    'deployment', 'group', 'show', '--resource-group', args.resource_group, '--name', 'budget-backend'],
    '{state:properties.provisioningState,functionApp:properties.outputs.functionAppName.value,'
    'storage:properties.outputs.hostStorageAccountName.value,cosmosEndpoint:properties.outputs.cosmosEndpoint.value,'
    'database:properties.outputs.cosmosDatabaseName.value,container:properties.outputs.cosmosContainerName.value,'
    'packageContainer:properties.outputs.deploymentPackageContainer.value}'), dict, 'deployment')
if outputs.get('state') != 'Succeeded':
    parser.exit(1, 'The budget-backend deployment has not succeeded; review its deployment before auditing.\n')
for field, kind in [('functionApp', 'functionApp'), ('storage', 'storage'), ('database', 'cosmosName'),
                    ('container', 'cosmosName'), ('packageContainer', 'container')]:
    if not valid(outputs.get(field), kind):
        parser.exit(1, 'The deployment is missing expected public resource outputs.\n')
try:
    endpoint = urlparse(outputs.get('cosmosEndpoint', ''))
    cosmos_name = (endpoint.hostname or '').split('.')[0]
    if endpoint.scheme != 'https' or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment \
            or endpoint.port not in (None, 443) or endpoint.path not in ('', '/') or not valid(cosmos_name, 'cosmos') \
            or endpoint.hostname not in [cosmos_name + '.documents.' + suffix for suffix in ('azure.com', 'azure.us', 'azure.cn')]:
        raise ValueError()
except (TypeError, ValueError):
    parser.exit(1, 'The deployment is missing a recognized public Cosmos endpoint.\n')

subscription_scope = f'/subscriptions/{args.subscription}'
group_scope = f'{subscription_scope}/resourceGroups/{args.resource_group}'
function_id = f"{group_scope}/providers/Microsoft.Web/sites/{outputs['functionApp']}"
cosmos_id = f'{group_scope}/providers/Microsoft.DocumentDB/databaseAccounts/{cosmos_name}'
storage_id = f"{group_scope}/providers/Microsoft.Storage/storageAccounts/{outputs['storage']}"
container_id = f"{storage_id}/blobServices/default/containers/{outputs['packageContainer']}"
data_id = f"{cosmos_id}/sqlDatabases/{outputs['database']}/containers/{outputs['container']}"

role_ids = set()
def roles(scope):
    assignments = shape(read('Azure role assignments', ['role', 'assignment', 'list', '--scope', scope,
        '--include-inherited', '--fill-principal-name', 'false'],
        '[].{id:id,principalId:principalId,principalType:principalType,roleDefinitionId:roleDefinitionId,'
        'scope:scope,condition:condition,conditionVersion:conditionVersion}'), list, 'role assignment')
    projected = []
    for item in assignments:
        shape(item, dict, 'role assignment')
        role_id = item.get('roleDefinitionId')
        if isinstance(role_id, str) and valid(role_id.rsplit('/', 1)[-1], 'subscription'):
            role_ids.add(role_id.rsplit('/', 1)[-1])
        else:
            parser.exit(1, 'Azure returned an invalid role definition ID. No complete inventory was produced.\n')
        projected.append({**{key: item.get(key) for key in (
            'id', 'principalId', 'principalType', 'roleDefinitionId', 'scope', 'conditionVersion')},
            'conditionPresent': bool(item.get('condition'))})
    return projected

storage_query = ('{id:id,allowSharedKeyAccess:allowSharedKeyAccess,allowBlobPublicAccess:allowBlobPublicAccess,'
                 'httpsOnly:enableHttpsTrafficOnly,minimumTlsVersion:minimumTlsVersion,'
                 'defaultToOAuthAuthentication:defaultToOAuthAuthentication,publicNetworkAccess:publicNetworkAccess,'
                 'networkDefaultAction:networkRuleSet.defaultAction,networkBypass:networkRuleSet.bypass}')
def storage_metadata(name, group):
    return shape(read('storage security properties', ['storage', 'account', 'show', '--name', name,
        '--resource-group', group], storage_query), dict, 'storage security')

def container_metadata(account, name, group):
    return shape(read('container security properties', ['storage', 'container-rm', 'show',
        '--storage-account', account, '--name', name, '--resource-group', group],
        '{id:id,publicAccess:publicAccess}'), dict, 'container security')

resources = [
    {'purpose': 'functionApp', 'id': function_id, 'security': shape(read('function security properties',
        ['functionapp', 'show', '--resource-group', args.resource_group, '--name', outputs['functionApp']],
        '{id:id,httpsOnly:httpsOnly,publicNetworkAccess:publicNetworkAccess,'
        'identity:{type:identity.type,principalId:identity.principalId}}'), dict, 'function security')},
    {'purpose': 'hostStorage', 'id': storage_id, 'security': storage_metadata(outputs['storage'], args.resource_group)},
    {'purpose': 'packageContainer', 'id': container_id,
     'security': container_metadata(outputs['storage'], outputs['packageContainer'], args.resource_group)},
    {'purpose': 'cosmosAccount', 'id': cosmos_id, 'security': shape(read('Cosmos security properties',
        ['cosmosdb', 'show', '--resource-group', args.resource_group, '--name', cosmos_name],
        '{id:id,disableLocalAuth:disableLocalAuth,disableKeyBasedMetadataWriteAccess:disableKeyBasedMetadataWriteAccess,'
        'minimalTlsVersion:minimalTlsVersion,publicNetworkAccess:publicNetworkAccess,'
        'isVirtualNetworkFilterEnabled:isVirtualNetworkFilterEnabled,networkAclBypass:networkAclBypass}'), dict, 'Cosmos security')},
    {'purpose': 'cosmosDataContainer', 'id': data_id},
]
resources[0]['transport'] = shape(read('function transport properties', ['functionapp', 'config', 'show',
    '--resource-group', args.resource_group, '--name', outputs['functionApp']],
    '{minTlsVersion:minTlsVersion,scmMinTlsVersion:scmMinTlsVersion,ftpsState:ftpsState}'), dict, 'function transport')
resources[0]['basicPublishing'] = {}
for kind in ('scm', 'ftp'):
    resources[0]['basicPublishing'][kind] = shape(read('publishing authentication policy', ['resource', 'show',
        '--ids', f'{function_id}/basicPublishingCredentialsPolicies/{kind}', '--api-version', '2023-12-01'],
        '{allow:properties.allow}'), dict, 'publishing authentication')
if args.control_storage_account:
    control_id = f'{subscription_scope}/resourceGroups/{control_group}/providers/Microsoft.Storage/storageAccounts/{args.control_storage_account}'
    resources.extend([
        {'purpose': 'controlStorage', 'id': control_id,
         'security': storage_metadata(args.control_storage_account, control_group)},
        {'purpose': 'controlContainer', 'id': f'{control_id}/blobServices/default/containers/{args.control_container}',
         'security': container_metadata(args.control_storage_account, args.control_container, control_group)},
    ])
for resource in resources:
    resource['azureRoleAssignmentsIncludingInherited'] = roles(resource['id'])

role_definitions = []
for role_id in sorted(role_ids):
    definitions = shape(read('Azure role permissions', ['role', 'definition', 'list', '--name', role_id,
        '--scope', subscription_scope], '[].{id:id,roleType:roleType,assignableScopes:assignableScopes,permissions:permissions}'),
        list, 'role definition')
    if not definitions:
        parser.exit(1, 'An assigned Azure role definition was not readable. No complete inventory was produced.\n')
    role_definitions.extend(definitions)
cosmos_arguments = ['--resource-group', args.resource_group, '--account-name', cosmos_name]
cosmos_assignments = shape(read('Cosmos SQL role assignments', ['cosmosdb', 'sql', 'role', 'assignment', 'list',
    *cosmos_arguments], '[].{id:id,principalId:principalId,roleDefinitionId:roleDefinitionId,scope:scope}'), list, 'Cosmos role assignment')
cosmos_definitions = shape(read('Cosmos SQL role permissions', ['cosmosdb', 'sql', 'role', 'definition', 'list',
    *cosmos_arguments], '[].{id:id,type:type,assignableScopes:assignableScopes,permissions:permissions}'), list, 'Cosmos role definition')

print(json.dumps({'subscriptionId': args.subscription, 'resourceGroup': args.resource_group,
    'resources': resources, 'azureRoleDefinitions': role_definitions,
    'cosmosSqlRoleAssignments': cosmos_assignments, 'cosmosSqlRoleDefinitions': cosmos_definitions,
    'limitations': [
        'This is an assigned-role and resource-metadata inventory, not a complete effective-access assessment.',
        'Directory group membership, eligible/PIM roles, deny assignments, and assignments hidden by reader permissions are not resolved.',
        'Role conditions are reported by presence only; review their expressions separately before deciding effective access.',
        'Object IDs do not identify a principal as human, AI, or trusted; external credentials and grants are not assessed.',
        'No app settings, keys, tokens, blob contents, control record, or user records were requested.',
    ]}, indent=2))
PY
