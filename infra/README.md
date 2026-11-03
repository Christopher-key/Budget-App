# Optional Azure API infrastructure

These files provision the API separately from your **existing Azure Static Web
App**. The existing GitHub SWA workflow publishes the web client using its existing
deployment-token secret. This template neither creates nor modifies a Static Web
App, Entra registration, GitHub secret, or deployment workflow. Nothing has been
deployed from this workspace.

## Resources and access

| Resource | Configuration and purpose |
| --- | --- |
| Function App and plan | Linux Consumption **Y1**, Functions v4, **Node.js 22**, HTTPS/TLS 1.2, system-assigned managed identity, password-based SCM/FTP publishing disabled. |
| Host storage | Standard LRS StorageV2; TLS 1.2; HTTPS only; shared-key authentication and public blob access disabled. Identity authenticates host storage and a private `function-packages` deployment container. No Azure Files connection string or SAS. |
| Cosmos DB for NoSQL | Serverless, one region, Session consistency; no provisioned RU/s, geo-replica, or automatic failover. Local/key authentication is disabled. |
| Database/container | Default `budget` / `accounts`, partition key **`/ownerId`**. Point reads and atomic same-partition batches; indexing disabled because this repository performs no queries. |
| Cosmos backups | Periodic backups every four hours; **eight-hour retention**, the minimum supported periodic retention; locally redundant backup storage. No continuous/PITR backup. |
| Function identity → Cosmos | Custom data-plane role, assigned to this **container only**: `readMetadata` and item `read`, `create`, `replace`, `delete`. Atomic batches use those item permissions; there is no separate transactional-batch role action. No account keys, upsert, query, change feed, stored procedure, database-management, or account-wide data role is granted. |
| Function identity → storage | **Storage Blob Data Owner** on this host storage account only. This is Microsoft's minimum built-in role for host blob containers/leases, not subscription Owner. No Queue/Table data or Storage Account Contributor role is assigned. |

The Cosmos role definition's account-level `assignableScopes` says where that role
may be assigned; its actual role assignment is the single `/dbs/.../colls/...`
scope. Cosmos RBAC does not isolate individual owner partitions: server-side JWT
validation and the repository enforce `/ownerId` isolation. The Function identity
can access all users' records in this container. Adding SDK queries later requires
a separately reviewed index and permission change.

The HTTP-only host does not need queue/blob triggers or Durable Functions roles.
Optional host diagnostics written to Table Storage are intentionally unavailable;
the host may report that it cannot persist those diagnostics. See Microsoft's
[host identity permissions](https://learn.microsoft.com/azure/azure-functions/manage-connections?pivots=functions-auth-identity&tabs=host#grant-permissions-to-an-identity).
Role assignments can take several minutes to propagate after initial deployment;
restart the app after permissions and its package are available.

**The Function, Cosmos, and storage endpoints are public network endpoints.**
Private blob containers and OAuth protect access; they do not make the network
private. This template does not provision VNet integration, private endpoints,
firewall restrictions, a WAF, or an API gateway. CORS allows the one exact supplied
HTTPS web origin, with credentials disabled. CORS is a browser policy; it provides
no authentication for native clients or direct HTTP callers. Preview/custom web
origins need deliberate Entra redirect and CORS updates; wildcards are not used.

## Register sign-in manually before deployment

Use one Microsoft Entra workforce tenant or External ID customer tenant appropriate
for your users. External ID also requires its sign-up/sign-in user flow and client
association. This code accepts only `login.microsoftonline.com` or a
`*.ciamlogin.com` authority and the configured tenant's v2 issuer; other identity
providers/custom authority hosts need a code change.

1. Register an **API application** in that tenant. Expose Application ID URI
   `api://<API_APPLICATION_ID_GUID>` and exactly one delegated permission named
   **`Budget.Access`**. Set the API manifest's
   `api.requestedAccessTokenVersion` to **2**. For this v2 access token, the `aud`
   claim and `AUTH_AUDIENCE` are the **API application's GUID**, while the requested
   scope is `api://<API_APPLICATION_ID_GUID>/Budget.Access`.
2. Register a separate **SPA public client**. Add the **Single-page application**
   platform with the exact production redirect, normally
   `https://<EXISTING_SWA_HOST>/`. The current web callback uses origin plus the
   current pathname, so register every intended callback path exactly and start
   sign-in at that path. Add only the API's delegated `Budget.Access` permission
   and consent/preauthorize it as your tenant policy requires. Remove the default
   Microsoft Graph `User.Read` permission if added. Do not enable implicit grants,
   create a client secret, or register it as a confidential web application.
3. Register a separate **native public client** under **Mobile and desktop
   applications**. Register the exact native callback URI from the native client's
   configuration and corresponding iOS URL scheme. If using MSAL's iOS platform
   configuration, use the actual bundle ID and its generated callback rather than
   inventing one. Authorize only delegated `Budget.Access`; enable public-client
   flows if required by that registration. Native sign-in must use the system
   authentication browser, authorization code and **PKCE S256**, state validation,
   and no client secret. A registration alone does not add native sign-in code.
4. Both clients use authorization code with PKCE. Request only the budget API
   scope; do not add Graph, Mail, Files, or `offline_access`. No mailbox/file access
   or refresh-token permission is needed. The API never accepts an ID token in
   place of its access token.
5. Read the tenant-specific v2 OpenID configuration and copy its exact `issuer`.
   Use `https://login.microsoftonline.com/<TENANT_ID>/v2.0` for the usual workforce
   issuer, or the tenant's actual `https://<TENANT_SUBDOMAIN>.ciamlogin.com/<TENANT_ID>/v2.0`
   issuer for External ID. Use a tenant-specific authority, not `common`,
   `organizations`, or `consumers`.

Configure these API settings through the Bicep parameters:

| Setting | Value |
| --- | --- |
| `AUTH_ISSUER` | Exact trusted v2 issuer, without trailing slash. |
| `AUTH_AUDIENCE` | API application ID GUID. |
| `AUTH_TENANT_ID` | Trusted tenant ID GUID. |
| `AUTH_ALLOWED_CLIENT_IDS` | Comma-separated SPA and native application ID GUIDs; each must match an access-token `azp` claim. |
| `COSMOS_ENDPOINT` | Template-generated HTTPS Cosmos account endpoint. |
| `DATABASE_NAME`, `CONTAINER_NAME` | Template-generated database/container names. |

The API functions use Functions `authLevel: anonymous` because the application
validates each **Bearer** access token itself: RS256 signature, issuer, API
audience, expiry, token age/version, tenant, authorized client, and `Budget.Access`
scope. Anonymous Functions routing does not grant access to budget records. Do
not substitute SWA identity headers, an API key, a client-provided owner ID, or
Function keys for that validation. Account ownership derives from the verified
issuer, tenant and object ID. A PIN is an additional application lock, not the
Microsoft identity or Cosmos credential.

## Review the plan, then deploy manually

Use your own authenticated machine with Azure CLI, its Bicep component, Python 3,
and an **existing** target resource group. Choose a region that supports both
Linux Consumption Functions and Cosmos serverless; check subscription quota and
Microsoft.Web, Microsoft.Storage and Microsoft.DocumentDB provider registration.
Resource/provider registration and resource-group creation are manual prerequisites.
The deployer needs resource creation rights (for example Contributor) and scoped
`Microsoft.Authorization/roleAssignments/write` rights for the storage role (for
example Role Based Access Control Administrator at the target group). Entra
application-registration/consent rights are separate. This template grants no
operator or GitHub principal those privileges.

Copy [params.example.json](params.example.json) to a private local file and replace
**every** placeholder. It contains identifiers/configuration, never secrets,
financial records, PINs, database keys, or real user account identifiers. Use a
3–16 character lowercase `namePrefix`, one exact HTTPS `frontendOrigin` without
trailing slash, and an immutable ZIP filename such as `budget-api-release-001.zip`.

From the repository root, run the read-only ARM plan first:

```sh
./infra/deploy.sh --subscription '<SUBSCRIPTION_ID>' \
  --resource-group '<EXISTING_RESOURCE_GROUP>' \
  --parameters '/absolute/path/to/private.parameters.json'
```

The script defaults to **`az deployment group what-if`**. It neither logs in,
creates a resource group, publishes code, nor applies a deployment. Review the
selected subscription, region, resource names, access assignments, public endpoints,
backup policy, and estimated charges. What-if can fail without necessary read or
provider permissions and does not prove runtime compatibility. Only this explicit
flag makes resource changes:

```sh
./infra/deploy.sh --subscription '<SUBSCRIPTION_ID>' \
  --resource-group '<EXISTING_RESOURCE_GROUP>' \
  --parameters '/absolute/path/to/private.parameters.json' --deploy
```

No deployment is performed by repository CI. This uses incremental deployment:
renaming resources/parameters does not migrate data or remove old resources, and
reapplying settings can restart the Function App. Do not change database/container
names or `/ownerId` expecting an automatic migration.

## Publish the API package separately

The SWA workflow deploys only the browser app. Infrastructure provisioning alone
does not deploy executable API code. Linux Consumption with identity-based host
storage uses an **external private ZIP package**, not `WEBSITE_RUN_FROM_PACKAGE=1`
or a storage-key-dependent remote build. See
[Microsoft's external-package instructions](https://learn.microsoft.com/azure/azure-functions/deployment-zip-push#run-from-an-external-package-url).

1. On Linux with Node.js 22, build `api/` using its locked dependencies. Stage only
   `host.json`, `package.json`, `package-lock.json`, the entire built `dist/` tree,
   and production `node_modules/`. Run `npm ci --omit=dev` in that staging
   directory. ZIP **the staging directory's contents**, so `host.json` is at ZIP
   root and `package.json`'s `main` resolves to `dist/api/src/functions.js`. Keep
   `.env`, local settings, test fixtures, user records, and development caches out
   of the ZIP. Build the shared code through `npm --prefix api run build`; its
   compiled shared files are part of `api/dist/`.
2. Upload that ZIP to the output storage account's private `function-packages`
   container under the exact `deploymentPackageBlobName` supplied to the template.
   Use Entra authentication (`az storage blob upload --auth-mode login`) and an
   operator granted **Storage Blob Data Contributor on this container**. Do not
   enable shared keys/public blobs or generate a SAS. The Function's existing
   account-scoped Blob Data Owner role covers package reads. The template sets
   `WEBSITE_RUN_FROM_PACKAGE` to this private URL and
   `WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID=SystemAssigned`.
3. After upload and role propagation, restart the Function App and sync triggers.
   An operator with **Website Contributor on this Function App** can perform
   those operations; no publishing profile is needed. For Azure CLI, use
   `az functionapp restart` and the ARM
   `POST <FUNCTION_RESOURCE_ID>/syncfunctiontriggers?api-version=2016-08-01`
   operation through `az rest`. Pass your subscription explicitly.
4. For a subsequent release, upload a new immutable package name first, update
   `deploymentPackageBlobName` in the private parameter file, repeat what-if and
   explicit deployment, then restart/sync. Keep the previous package for a
   deliberate rollback. Do not overwrite the live blob. The infrastructure
   template owns the package URL, so changing it only in the portal will be
   overwritten on the next template deployment.

Before the first package upload, the newly created app can fail startup because
its package does not yet exist. Infrastructure success is not an API health check.
Use synthetic records to verify missing/wrong tokens fail, two identities remain
isolated, atomic writes survive conflicts, and the intended reset succeeds before
entering real financial information.

## Connect the existing frontend

After provisioning, use the `apiBaseUrl` output as **the Function origin without
`/api`**; the client adds API paths itself. Configure the existing SWA workflow's
public settings with the SPA application ID, tenant-specific authority, exact
`api://<API_APPLICATION_ID_GUID>/Budget.Access` scope, and this API origin as
documented in [web/.env.example](../web/.env.example). Public identifiers belong
in runtime/build configuration; no client secret, Cosmos credential, deployment
token, PIN, or user record belongs there. Keep the existing SWA token secret in
GitHub. An API deployment is independent of SWA deployment and does not require a
new SWA resource or token.

## Costs, privacy, and production limits

This is a minimal development/small-workload deployment, not a production privacy
or availability certification. Functions execution/memory, Cosmos consumed RUs and
stored data, Blob capacity/operations, backup storage, and outbound traffic can
cost money. Existing SWA and Entra plans have their own quotas and charges. Free
allowances are not a spending cap; no budget alert or hard charge limit is created.
Check current regional prices and set your own Azure budget/alerts before deploying.

Y1 has cold starts and resource/time limits. This application's host timeout is
one minute. Linux Consumption is scheduled to retire on **30 September 2028**;
Node.js 22 is its final supported Node major. Plan migration to a supported host
and Node release before their respective retirement/support deadlines. A single
Cosmos region and locally redundant backups do not provide regional disaster
recovery. Cosmos's 2 MB item limit applies to the per-user ledger document; this
design needs a migration before large histories exceed that limit. This template
adds no per-account rate limiter or upstream denial-of-service protection.

No Application Insights, diagnostic-setting export, request-body logging,
financial analytics, Graph/Mail/Files permissions, or external telemetry sink is
configured. Host/application error logs should use generic messages only. Azure
still processes service/operational metadata and provider-controlled diagnostics;
disabling application telemetry does not eliminate all provider records. Host
storage contains deployment/runtime artifacts; financial records are in Cosmos.
Use synthetic data for diagnostics and never log Authorization headers, PINs,
financial bodies, notes, or JWTs.

Deleting/resetting a live ledger does **not** immediately erase provider backups,
existing exports, or independent copies. Periodic snapshots may still contain
deleted records until Azure expires them under its retention/provider handling;
eight-hour configured retention is not an instant-erasure guarantee. Review and
test restore/deletion procedures, authentication policy, abuse controls, capacity,
and regional recovery requirements before serving real users.

Local verification: `main.bicep` compiles with Bicep CLI **0.48.1**; the example JSON
parses and `bash -n infra/deploy.sh` passes. Azure CLI, ARM what-if, deployment,
identity propagation, package startup, and live Azure behavior have **not** been
run or verified in this workspace.
