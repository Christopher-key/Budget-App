#!/usr/bin/env python3
"""Guard the optional lockdown ARM templates; no credentials or Azure access."""
import copy
import json
import sys


def require(condition, message):
    if not condition:
        raise ValueError(message)


def resources(template, kind):
    return [r for r in template.get('resources', []) if r.get('type', '').lower() == kind.lower()]


def permissions(role):
    entries = role.get('properties', {}).get('permissions', [])
    require(len(entries) == 1, 'Security roles must have one explicit permission set.')
    entry = entries[0]
    require(not entry.get('notActions') and not entry.get('notDataActions'),
            'Security roles must allow only their explicit operations.')
    return set(entry.get('actions', [])), set(entry.get('dataActions', []))


def validate_control(template):
    allowed_types = {
        'microsoft.storage/storageaccounts',
        'microsoft.storage/storageaccounts/blobservices',
        'microsoft.storage/storageaccounts/blobservices/containers',
        'microsoft.web/sites', 'microsoft.web/sites/basicpublishingcredentialspolicies',
        'microsoft.authorization/roledefinitions', 'microsoft.authorization/roleassignments',
    }
    require(all(r.get('type', '').lower() in allowed_types for r in template.get('resources', [])),
            'Control deployment must not create Cosmos resources, plans, secrets, or unrelated grants.')
    accounts = resources(template, 'Microsoft.Storage/storageAccounts')
    require(len(accounts) == 1, 'Controller requires exactly one independent host/control storage account.')
    account = accounts[0]
    require(account.get('name') == "[variables('controlName')]", 'Use the independent control storage account.')
    props = account.get('properties', {})
    require(props.get('allowSharedKeyAccess') is False and props.get('allowBlobPublicAccess') is False
            and props.get('supportsHttpsTrafficOnly') is True and props.get('minimumTlsVersion') == 'TLS1_2',
            'Control storage must use identity authentication, private blobs and HTTPS.')
    require("budgetFunctionAppName" not in str(template.get('variables', {}).get('controlName', '')),
            'Control storage must be independent of the budget host.')
    containers = resources(template, 'Microsoft.Storage/storageAccounts/blobServices/containers')
    require(len(containers) == 2 and all(r.get('properties', {}).get('publicAccess') == 'None' for r in containers),
            'Control and package containers must both be private.')
    require(template.get('variables', {}).get('controlContainerName') == 'service-control',
            'Control state must remain in the isolated service-control container.')

    sites = resources(template, 'Microsoft.Web/sites')
    require(len(sites) == 1 and sites[0].get('name') == "[variables('controllerName')]",
            'Only the independent controller app may be created by this deployment.')
    site = sites[0]
    require(site.get('identity', {}).get('type') == 'SystemAssigned', 'Controller requires its own workload identity.')
    props = site.get('properties', {})
    require(props.get('httpsOnly') is True and props.get('serverFarmId') == "[parameters('existingPlanResourceId')]",
            'Controller must require HTTPS and reuse the existing plan.')
    config = props.get('siteConfig', {})
    require(config.get('minTlsVersion') == '1.2' and config.get('scmMinTlsVersion') == '1.2'
            and config.get('ftpsState') == 'Disabled', 'Controller transport must remain restricted.')
    require(config.get('cors', {}).get('supportCredentials') is False, 'Public status must not accept browser credentials.')
    settings = {entry.get('name'): entry.get('value') for entry in config.get('appSettings', [])}
    allowed_settings = {
        'FUNCTIONS_EXTENSION_VERSION', 'FUNCTIONS_WORKER_RUNTIME',
        'AzureWebJobsStorage__accountName', 'AzureWebJobsStorage__credential',
        'WEBSITE_RUN_FROM_PACKAGE', 'WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID',
        'SERVICE_ROLE', 'APP_ORIGIN', 'LOCKDOWN_BLOB_URL', 'BUDGET_FUNCTION_RESOURCE_ID',
        'ALERT_AUTH_ISSUER', 'ALERT_AUTH_AUDIENCE', 'ALERT_AUTH_TENANT_ID',
        'ALERT_ALLOWED_CALLER_IDS', 'ALERT_ALLOWED_RULE_IDS', 'ALERT_ALLOWED_MONITORING_SERVICES',
    }
    require(set(settings) == allowed_settings, 'Controller settings must contain no budget authentication keys or connection strings.')
    require(settings['SERVICE_ROLE'] == 'security-controller'
            and settings['AzureWebJobsStorage__credential'] == 'managedidentity'
            and settings['AzureWebJobsStorage__accountName'] == account['name'],
            'Controller role and host identity must remain separate from the budget API.')
    require("variables('controlName')" in settings['LOCKDOWN_BLOB_URL'], 'Controller must read its independent control account.')
    publishing = resources(template, 'Microsoft.Web/sites/basicPublishingCredentialsPolicies')
    require(len(publishing) == 2 and all(r.get('properties', {}).get('allow') is False for r in publishing),
            'Both controller password-based publishing methods must be disabled.')

    blob_read = 'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'
    blob_write = 'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write'
    stop = 'Microsoft.Web/sites/stop/action'
    expected = {
        'Budget lockdown control read only': (set(), {blob_read}),
        'Budget lockdown operator control writer': (set(), {blob_read, blob_write}),
        'Budget security controller stop only': ({stop}, set()),
        'Budget API security operator recovery': ({'Microsoft.Web/sites/read', stop, 'Microsoft.Web/sites/start/action'}, set()),
    }
    definitions = resources(template, 'Microsoft.Authorization/roleDefinitions')
    roles = {r.get('properties', {}).get('roleName'): r for r in definitions}
    require(set(roles) == set(expected) and len(roles) == len(definitions), 'Unexpected security role definition.')
    for name, allowed in expected.items():
        require(permissions(roles[name]) == allowed, f'{name} acquired unexpected access.')

    # Inspect actual assignments, not just the role definitions. In particular,
    # a correct read-only role is insufficient if the runtime also receives owner.
    assignments = resources(template, 'Microsoft.Authorization/roleAssignments')
    require(len(assignments) == 5, 'Unexpected security principal grant.')
    seen = set()
    for grant in assignments:
        props = grant.get('properties', {})
        principal = props.get('principalId', '')
        role = props.get('roleDefinitionId', '')
        scope = grant.get('scope', '')
        if "variables('controllerName')" in principal:
            if role == "[variables('blobDataOwnerRoleId')]":
                require(scope == "[resourceId('Microsoft.Storage/storageAccounts', variables('controlName'))]",
                        'Controller host owner grant must apply only to its own storage.')
                seen.add('controller-host')
            else:
                require("'budget-api-stop-only'" in role
                        and scope == "[resourceId('Microsoft.Web/sites', parameters('budgetFunctionAppName'))]",
                        'Controller may only STOP the budget API; no start, Cosmos or settings access.')
                seen.add('controller-stop')
            require(props.get('principalType') == 'ServicePrincipal', 'Workload roles require a service principal.')
        elif "parameters('budgetFunctionAppName')" in principal:
            require("'budget-lockdown-blob-reader'" in role
                    and scope == "[resourceId('Microsoft.Storage/storageAccounts/blobServices/containers', variables('controlName'), 'default', variables('controlContainerName'))]",
                    'Budget runtime may only read the isolated control container.')
            require(props.get('principalType') == 'ServicePrincipal', 'Budget runtime must use its workload identity.')
            seen.add('budget-reader')
        else:
            require(principal == "[parameters('operatorObjectIds')[copyIndex()]]"
                    and props.get('principalType') == 'User'
                    and "parameters('budgetFunctionPrincipalId')" in grant.get('condition', ''),
                    'Recovery grants must target approved human users and exclude the runtime.')
            if "'budget-lockdown-blob-writer'" in role:
                require(scope == "[resourceId('Microsoft.Storage/storageAccounts/blobServices/containers', variables('controlName'), 'default', variables('controlContainerName'))]",
                        'Operator control writes must be scoped to the control container.')
                seen.add('operator-write')
            else:
                require("'budget-api-operator-recovery'" in role
                        and scope == "[resourceId('Microsoft.Web/sites', parameters('budgetFunctionAppName'))]",
                        'Human recovery must be scoped to the budget API.')
                seen.add('operator-recovery')
    require(seen == {'controller-host', 'controller-stop', 'budget-reader', 'operator-write', 'operator-recovery'},
            'Missing or duplicate security assignment.')
    owner_id = template.get('variables', {}).get('blobDataOwnerRoleId', '')
    require("'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'" in owner_id, 'Only the reviewed blob host role may be assigned.')
    for name in ['alertAuthIssuer', 'alertAuthAudience', 'alertAuthTenantId']:
        require(template.get('parameters', {}).get(name, {}).get('defaultValue') == '',
                'Automatic alert authentication must remain unconfigured by default.')
    for name in ['allowedCallerIds', 'allowedAlertRuleIds', 'allowedMonitoringServices']:
        require(template.get('parameters', {}).get(name, {}).get('defaultValue') == [],
                'Automatic alert sources must require explicit operator configuration.')


def validate_baseline(template):
    require(template.get('parameters', {}).get('enforcementMode', {}).get('defaultValue') == 'DoNotEnforce',
            'Security policy must remain review-only by default.')
    definitions = resources(template, 'Microsoft.Authorization/policyDefinitions')
    require(len(definitions) == 1, 'Expected the reviewed property-policy definition loop.')
    rule = definitions[0].get('properties', {}).get('policyRule', {})
    conditions = rule.get('if', {}).get('allOf', [])
    require(any(c.get('field') == 'id' and c.get('in') == "[[parameters('protectedResourceIds')]" for c in conditions),
            'Policy must target an explicit resource ID allowlist, not the entire subscription.')
    require(rule.get('then', {}).get('effect') == 'deny', 'Reviewed property constraints must retain their explicit effect.')
    deployments = resources(template, 'Microsoft.Resources/deployments')
    require(len(deployments) == 1, 'Unexpected policy deployment scope.')
    deployment = deployments[0]
    require(deployment.get('resourceGroup') == "[parameters('resourceGroupName')]", 'Policy assignment scope must be the budget group.')
    props = deployment.get('properties', {})
    require(props.get('parameters', {}).get('enforcementMode', {}).get('value') == "[parameters('enforcementMode')]",
            'Policy assignment must preserve the review-only default.')
    assignments = resources(props.get('template', {}), 'Microsoft.Authorization/policyAssignments')
    require(len(assignments) == 1
            and assignments[0].get('properties', {}).get('enforcementMode') == "[parameters('enforcementMode')]",
            'Embedded policy assignment must not override the reviewed enforcement setting.')


def regression_checks(control, baseline):
    """Prove the checker rejects dangerous mutations of the actual compiled input."""
    trials = []
    trial = copy.deepcopy(control)
    resources(trial, 'Microsoft.Storage/storageAccounts')[0]['properties']['allowSharedKeyAccess'] = True
    trials.append((validate_control, trial))
    trial = copy.deepcopy(control)
    role = next(r for r in resources(trial, 'Microsoft.Authorization/roleDefinitions')
                if r['properties']['roleName'] == 'Budget security controller stop only')
    role['properties']['permissions'][0]['actions'].append('Microsoft.Web/sites/start/action')
    trials.append((validate_control, trial))
    trial = copy.deepcopy(control)
    grant = next(r for r in resources(trial, 'Microsoft.Authorization/roleAssignments')
                 if "parameters('budgetFunctionAppName')" in r['properties']['principalId'])
    grant['properties']['roleDefinitionId'] = "[variables('blobDataOwnerRoleId')]"
    trials.append((validate_control, trial))
    trial = copy.deepcopy(control)
    resources(trial, 'Microsoft.Web/sites')[0]['properties']['siteConfig']['appSettings'].append({'name': 'AUTH_PEPPER', 'value': 'unsafe'})
    trials.append((validate_control, trial))
    trial = copy.deepcopy(baseline)
    trial['parameters']['enforcementMode']['defaultValue'] = 'Default'
    trials.append((validate_baseline, trial))
    for check, trial in trials:
        try:
            check(trial)
        except ValueError:
            continue
        raise ValueError('Security template checker failed its negative regression check.')


def main():
    if len(sys.argv) != 3:
        raise SystemExit('Usage: python3 Verification/check-lockdown-template.py CONTROL.json BASELINE.json')
    with open(sys.argv[1], encoding='utf-8') as source:
        control = json.load(source)
    with open(sys.argv[2], encoding='utf-8') as source:
        baseline = json.load(source)
    try:
        validate_control(control)
        validate_baseline(baseline)
        regression_checks(control, baseline)
    except ValueError as error:
        raise SystemExit(str(error))
    print('Lockdown template checks passed: isolated storage, scoped roles, stop-only automation, no budget secrets, optional policy enforcement; 5 unsafe mutations rejected.')


if __name__ == '__main__':
    main()
