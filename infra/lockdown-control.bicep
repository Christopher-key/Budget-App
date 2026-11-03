targetScope = 'resourceGroup'

@description('Region of the existing Linux Y1 Functions plan. This adds a controller app and independent StorageV2 account, not another plan.')
param location string

@description('Lowercase letters/digits only; a unique suffix is added to resource names.')
@minLength(3)
@maxLength(8)
param namePrefix string = 'budget'

@description('Existing budget API app in this resource group. Its managed identity can only READ control state.')
param budgetFunctionAppName string

@description('Existing budget API managed-identity object ID, read from Azure metadata. Used to exclude the runtime from operator grants.')
@minLength(36)
@maxLength(36)
param budgetFunctionPrincipalId string

@description('Full resource ID of the existing Linux Y1 plan in this region. No new Y1 plan or quota is requested.')
param existingPlanResourceId string

@description('Exact production HTTPS frontend origin, without a path or trailing slash.')
param frontendOrigin string

@description('Approved operator USER object IDs, not app IDs. Configure MFA/PIM outside this template. No budget-data role is granted.')
@minLength(1)
param operatorObjectIds array

@description('Immutable controller package blob. Publish the same checked API build after provisioning; its SERVICE_ROLE selects controller routes only.')
param deploymentPackageBlobName string = 'budget-security-initial.zip'

@description('Leave empty until a trusted alert adapter is configured. No paid alert service is provisioned.')
param alertAuthIssuer string = ''
param alertAuthAudience string = ''
param alertAuthTenantId string = ''
@description('Trusted alert adapter service-principal OBJECT IDs (the JWT oid claim), never application/client IDs. Empty disables automatic lockdown.')
param allowedCallerIds array = []
@description('Exact approved common-alert essentials.alertRule strings. These can be display names; protect the trusted adapter and rule configuration. Empty disables automatic lockdown.')
param allowedAlertRuleIds array = []
@description('Exact approved essentials.monitoringService security-source values. Ordinary metric alerts must not be allowed. Empty disables automatic lockdown.')
param allowedMonitoringServices array = []

var controlName = 'sg${namePrefix}${uniqueString(resourceGroup().id, 'lockdown-control')}'
var controllerName = '${namePrefix}-security-${uniqueString(resourceGroup().id, 'lockdown-controller')}'
var controlContainerName = 'service-control'
var controlBlobName = 'lockdown.json'
var blobDataOwnerRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b')

resource budgetFunction 'Microsoft.Web/sites@2023-12-01' existing = {
  name: budgetFunctionAppName
}

// Never reuse the budget API host storage: that API's host role can write all
// blobs in its own account. Only the independent controller owns this account.
resource controlStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: controlName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    // Y1 has no private-network integration. Blob authentication is mandatory.
    publicNetworkAccess: 'Enabled'
    networkAcls: { defaultAction: 'Allow', bypass: 'None' }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: controlStorage
  name: 'default'
}
resource controlContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: controlContainerName
  properties: { publicAccess: 'None' }
}
resource packageContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'function-packages'
  properties: { publicAccess: 'None' }
}
var controlBlobUrl = '${controlStorage.properties.primaryEndpoints.blob}${controlContainer.name}/${controlBlobName}'

resource controller 'Microsoft.Web/sites@2023-12-01' = {
  name: controllerName
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: existingPlanResourceId
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'NODE|22'
      alwaysOn: false
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      http20Enabled: true
      httpLoggingEnabled: false
      requestTracingEnabled: false
      detailedErrorLoggingEnabled: false
      cors: { allowedOrigins: [frontendOrigin], supportCredentials: false }
      appSettings: [
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'AzureWebJobsStorage__accountName', value: controlStorage.name }
        { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '${controlStorage.properties.primaryEndpoints.blob}${packageContainer.name}/${deploymentPackageBlobName}' }
        { name: 'WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID', value: 'SystemAssigned' }
        { name: 'SERVICE_ROLE', value: 'security-controller' }
        { name: 'APP_ORIGIN', value: frontendOrigin }
        { name: 'LOCKDOWN_BLOB_URL', value: controlBlobUrl }
        { name: 'BUDGET_FUNCTION_RESOURCE_ID', value: budgetFunction.id }
        { name: 'ALERT_AUTH_ISSUER', value: alertAuthIssuer }
        { name: 'ALERT_AUTH_AUDIENCE', value: alertAuthAudience }
        { name: 'ALERT_AUTH_TENANT_ID', value: alertAuthTenantId }
        { name: 'ALERT_ALLOWED_CALLER_IDS', value: join(allowedCallerIds, ',') }
        { name: 'ALERT_ALLOWED_RULE_IDS', value: join(allowedAlertRuleIds, ',') }
        { name: 'ALERT_ALLOWED_MONITORING_SERVICES', value: join(allowedMonitoringServices, ',') }
      ]
    }
  }
}
resource disableScmPassword 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: controller
  name: 'scm'
  properties: { allow: false }
}
resource disableFtpPassword 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: controller
  name: 'ftp'
  properties: { allow: false }
}
resource controllerHostRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(controlStorage.id, controller.id, blobDataOwnerRoleId)
  scope: controlStorage
  properties: {
    roleDefinitionId: blobDataOwnerRoleId
    principalId: controller.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource controlReaderRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'budget-lockdown-blob-reader')
  properties: {
    roleName: 'Budget lockdown control read only'
    description: 'Read control state. No writes, deletes, keys, SAS, management or budget-data permissions.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [{
      actions: []
      notActions: []
      dataActions: ['Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read']
      notDataActions: []
    }]
  }
}
resource runtimeControlRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(controlContainer.id, budgetFunction.id, controlReaderRole.id)
  scope: controlContainer
  properties: {
    principalId: budgetFunction.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: controlReaderRole.id
  }
}

resource controlWriterRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'budget-lockdown-blob-writer')
  properties: {
    roleName: 'Budget lockdown operator control writer'
    description: 'Read and update security control state; no deletes, keys, SAS, package/code or budget-data access.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [{
      actions: []
      notActions: []
      dataActions: [
        'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'
        'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write'
      ]
      notDataActions: []
    }]
  }
}
// Operator parameters must identify USERS. The runtime principal is additionally
// excluded to prevent a mistaken entry granting it control writes.
resource operatorControlWriters 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in operatorObjectIds: if (toLower(principalId) != toLower(budgetFunctionPrincipalId)) {
  name: guid(controlContainer.id, principalId, controlWriterRole.id)
  scope: controlContainer
  properties: {
    principalId: principalId
    principalType: 'User'
    roleDefinitionId: controlWriterRole.id
  }
}]

resource stopOnlyRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'budget-api-stop-only')
  properties: {
    roleName: 'Budget security controller stop only'
    description: 'Stop the budget API. Cannot start it, modify code/settings, change roles, or read budgets.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [{
      actions: ['Microsoft.Web/sites/stop/action']
      notActions: []
      dataActions: []
      notDataActions: []
    }]
  }
}
resource controllerStop 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(budgetFunction.id, controller.id, stopOnlyRole.id)
  scope: budgetFunction
  properties: {
    principalId: controller.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: stopOnlyRole.id
  }
}
resource recoveryRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'budget-api-operator-recovery')
  properties: {
    roleName: 'Budget API security operator recovery'
    description: 'Approved operator can inspect, stop and start this API, but cannot modify code/settings or read budget records through this role.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [{
      actions: [
        'Microsoft.Web/sites/read'
        'Microsoft.Web/sites/stop/action'
        'Microsoft.Web/sites/start/action'
      ]
      notActions: []
      dataActions: []
      notDataActions: []
    }]
  }
}
resource operatorRecovery 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in operatorObjectIds: if (toLower(principalId) != toLower(budgetFunctionPrincipalId)) {
  name: guid(budgetFunction.id, principalId, recoveryRole.id)
  scope: budgetFunction
  properties: {
    principalId: principalId
    principalType: 'User'
    roleDefinitionId: recoveryRole.id
  }
}]

// No AUTH_* secrets, Cosmos role, budget storage role, or start right is granted
// to the independent controller. Operator initialization of the blob is separate.
output functionAppName string = controller.name
output apiBaseUrl string = 'https://${controller.properties.defaultHostName}'
output functionPrincipalId string = controller.identity.principalId
output hostStorageAccountName string = controlStorage.name
output deploymentPackageContainer string = packageContainer.name
output deploymentPackageBlob string = deploymentPackageBlobName
output controlBlobUrl string = controlBlobUrl
output controlContainerName string = controlContainer.name
output controlBlobName string = controlBlobName
output controlStorageAccountId string = controlStorage.id
output budgetFunctionResourceId string = budgetFunction.id
output runtimeCanWriteControl bool = false
