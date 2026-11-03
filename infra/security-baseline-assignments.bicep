targetScope = 'resourceGroup'

param definitions array
param protectedResourceIds array
@allowed(['DoNotEnforce', 'Default'])
param enforcementMode string

resource assignments 'Microsoft.Authorization/policyAssignments@2024-04-01' = [for (definition, index) in definitions: {
  name: 'budget-${index}-${uniqueString(resourceGroup().id)}'
  properties: {
    displayName: definition.title
    description: 'Budget-specific security baseline; inspect compliance before activating enforcement.'
    policyDefinitionId: definition.id
    enforcementMode: enforcementMode
    parameters: { protectedResourceIds: { value: protectedResourceIds } }
    nonComplianceMessages: [{ message: 'This budget resource must retain the reviewed identity-only and HTTPS security settings.' }]
  }
}]

output assignmentIds array = [for (definition, index) in definitions: assignments[index].id]
