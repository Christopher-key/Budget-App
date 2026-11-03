targetScope = 'subscription'

@description('Existing budget resource group. Assignments apply only to protected resource IDs in this group.')
param resourceGroupName string

@description('Explicit full resource IDs of budget host/control Storage, Cosmos, and Function resources. No wildcard or subscription-wide target.')
@minLength(1)
param protectedResourceIds array

@allowed(['DoNotEnforce', 'Default'])
@description('Start with DoNotEnforce for compliance review. Default activates Deny on future noncompliant resource changes.')
param enforcementMode string = 'DoNotEnforce'

resource budgetGroup 'Microsoft.Resources/resourceGroups@2024-03-01' existing = {
  name: resourceGroupName
}

var rules = [
  {
    name: 'budget-storage-identity-and-transport'
    title: 'Budget storage requires identity authentication and secure transport'
    resourceType: 'Microsoft.Storage/storageAccounts'
    insecure: [
      { field: 'Microsoft.Storage/storageAccounts/allowSharedKeyAccess', notEquals: false }
      { field: 'Microsoft.Storage/storageAccounts/allowBlobPublicAccess', notEquals: false }
      { field: 'Microsoft.Storage/storageAccounts/supportsHttpsTrafficOnly', notEquals: true }
      { field: 'Microsoft.Storage/storageAccounts/minimumTlsVersion', notEquals: 'TLS1_2' }
    ]
  }
  {
    name: 'budget-cosmos-identity-only'
    title: 'Budget Cosmos accounts require identity authentication'
    resourceType: 'Microsoft.DocumentDB/databaseAccounts'
    insecure: [{ field: 'Microsoft.DocumentDB/databaseAccounts/disableLocalAuth', notEquals: true }]
  }
  {
    name: 'budget-function-https-only'
    title: 'Budget API requires HTTPS'
    resourceType: 'Microsoft.Web/sites'
    insecure: [{ field: 'Microsoft.Web/sites/httpsOnly', notEquals: true }]
  }
]

resource definitions 'Microsoft.Authorization/policyDefinitions@2023-04-01' = [for rule in rules: {
  name: '${rule.name}-${uniqueString(subscription().subscriptionId, resourceGroupName)}'
  properties: {
    policyType: 'Custom'
    mode: 'All'
    displayName: rule.title
    description: 'Protect selected budget resources. This policy constrains resource properties; it does not classify AI identities or grant/revoke data-plane roles.'
    metadata: { category: 'Budget application security', version: '1.0.0' }
    parameters: {
      protectedResourceIds: {
        type: 'Array'
        metadata: { displayName: 'Explicit protected resource IDs' }
      }
    }
    policyRule: {
      if: {
        allOf: [
          { field: 'type', equals: rule.resourceType }
          { field: 'id', in: '[parameters(\'protectedResourceIds\')]' }
          { anyOf: rule.insecure }
        ]
      }
      then: { effect: 'deny' }
    }
  }
}]

module assignments 'security-baseline-assignments.bicep' = {
  name: 'budget-security-assignments'
  scope: budgetGroup
  params: {
    definitions: [for (rule, index) in rules: { id: definitions[index].id, title: rule.title }]
    protectedResourceIds: protectedResourceIds
    enforcementMode: enforcementMode
  }
}

output policyEnforcementMode string = enforcementMode
output protectedResourceCount int = length(protectedResourceIds)
output assignmentIds array = assignments.outputs.assignmentIds
