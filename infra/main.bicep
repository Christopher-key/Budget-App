targetScope = 'resourceGroup'

@description('Azure region supporting Linux Consumption Functions and single-region Cosmos DB serverless.')
param location string

@description('Lowercase letters, numbers, and hyphens; start with a letter. Names gain a resource-group-specific suffix.')
@minLength(3)
@maxLength(16)
param namePrefix string = 'budget'

@description('Exact production HTTPS origin of the existing Static Web App, without a path or trailing slash. No wildcards.')
@minLength(1)
param frontendOrigin string

@secure()
@description('Stable random 32-byte base64url account-lookup key. Generate outside the repository; do not rotate without a migration.')
@minLength(43)
@maxLength(43)
param authLookupKey string

@secure()
@description('Independent random 32-byte base64url password-verifier pepper. Generate outside the repository; do not rotate without a migration.')
@minLength(43)
@maxLength(43)
param authPepper string

@description('Cosmos NoSQL database name. Changing this does not migrate existing records.')
param databaseName string = 'budget'

@description('Cosmos NoSQL container name. Partition key is permanently /ownerId.')
param containerName string = 'accounts'

@description('Immutable release ZIP name in the private function-packages container. Upload that built package after provisioning.')
@minLength(1)
param deploymentPackageBlobName string = 'budget-api-initial.zip'

var functionName = '${namePrefix}-${uniqueString(resourceGroup().id, 'function')}'
var cosmosName = '${namePrefix}-${uniqueString(resourceGroup().id, 'cosmos')}'
var storageName = 'st${uniqueString(resourceGroup().id, namePrefix)}'
var blobDataOwnerRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b')

// HTTP-only Functions host storage. No account key, SAS, Azure Files share,
// public blob access, queue trigger, or application financial record is configured.
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Enabled'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource packageContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'function-packages'
  properties: { publicAccess: 'None' }
}

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: cosmosName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    capabilities: [{ name: 'EnableServerless' }]
    locations: [{ locationName: location, failoverPriority: 0, isZoneRedundant: false }]
    enableAutomaticFailover: false
    enableMultipleWriteLocations: false
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    disableLocalAuth: true
    disableKeyBasedMetadataWriteAccess: true
    minimalTlsVersion: 'Tls12'
    publicNetworkAccess: 'Enabled'
    isVirtualNetworkFilterEnabled: false
    networkAclBypass: 'None'
    backupPolicy: {
      type: 'Periodic'
      periodicModeProperties: {
        backupIntervalInMinutes: 240
        backupRetentionIntervalInHours: 8
        backupStorageRedundancy: 'Local'
      }
    }
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: cosmos
  name: databaseName
  properties: {
    resource: { id: databaseName }
    options: {}
  }
}

resource container 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: database
  name: containerName
  properties: {
    resource: {
      id: containerName
      partitionKey: { paths: ['/ownerId'], kind: 'Hash', version: 2 }
      // Only rate-limit documents carry a positive per-item TTL. Accounts do not expire.
      defaultTtl: -1
      // Cosmos requires consistent indexing when TTL is enabled. Index only
      // the system timestamp used by expiry, keeping credentials/ciphertext out.
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [{ path: '/_ts/?' }]
        excludedPaths: [{ path: '/*' }]
      }
    }
    options: {}
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${functionName}-plan'
  location: location
  kind: 'linux'
  sku: { name: 'Y1', tier: 'Dynamic' }
  properties: { reserved: true }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionName
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
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
        { name: 'AzureWebJobsStorage__accountName', value: storage.name }
        { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '${storage.properties.primaryEndpoints.blob}${packageContainer.name}/${deploymentPackageBlobName}' }
        { name: 'WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID', value: 'SystemAssigned' }
        { name: 'AUTH_LOOKUP_KEY', value: authLookupKey }
        { name: 'AUTH_PEPPER', value: authPepper }
        { name: 'APP_ORIGIN', value: frontendOrigin }
        { name: 'COSMOS_ENDPOINT', value: cosmos.properties.documentEndpoint }
        { name: 'DATABASE_NAME', value: databaseName }
        { name: 'CONTAINER_NAME', value: containerName }
      ]
    }
  }
}

resource disableScmPassword 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: functionApp
  name: 'scm'
  properties: { allow: false }
}

resource disableFtpPassword 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: functionApp
  name: 'ftp'
  properties: { allow: false }
}

// Functions host needs Blob Data Owner for its blob leases/host containers.
// This is the data-plane role at this storage account, not Azure subscription Owner.
resource hostBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functionApp.id, blobDataOwnerRoleId)
  scope: storage
  properties: {
    roleDefinitionId: blobDataOwnerRoleId
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource cosmosItemsRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleDefinitions@2024-05-15' = {
  parent: cosmos
  name: guid(cosmos.id, 'budget-point-reads-atomic-writes')
  properties: {
    roleName: 'Budget point reads and atomic item writes'
    type: 'CustomRole'
    assignableScopes: [cosmos.id]
    permissions: [{
      dataActions: [
        'Microsoft.DocumentDB/databaseAccounts/readMetadata'
        'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/read'
        'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/create'
        'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/replace'
        'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/delete'
      ]
    }]
  }
}

resource cosmosItemsAssignment 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmos
  name: guid(cosmos.id, functionApp.id, databaseName, containerName)
  properties: {
    principalId: functionApp.identity.principalId
    roleDefinitionId: cosmosItemsRole.id
    scope: '${cosmos.id}/dbs/${databaseName}/colls/${containerName}'
  }
  dependsOn: [container]
}

output functionAppName string = functionApp.name
output apiBaseUrl string = 'https://${functionApp.properties.defaultHostName}'
output functionPrincipalId string = functionApp.identity.principalId
output cosmosEndpoint string = cosmos.properties.documentEndpoint
output cosmosDatabaseName string = database.name
output cosmosContainerName string = container.name
output hostStorageAccountName string = storage.name
output deploymentPackageContainer string = packageContainer.name
output deploymentPackageBlob string = deploymentPackageBlobName
