# Azure backend for app-owned accounts and encrypted sync

Keep the existing Azure Static Web App. These files separately provision a
Functions API, private host/package storage, and Cosmos database. App users create
a budget-app username/password; they never need an Azure or Microsoft account.
No Entra user-flow/app registration is required. Nothing in repository CI creates
paid resources or publishes the backend automatically.

## Resources and permissions

| Resource | Configuration |
| --- | --- |
| Function App | Linux Consumption Y1, Functions v4, Node.js 22, HTTPS/TLS 1.2, system-assigned managed identity; SCM/FTP password publishing disabled |
| Host/package storage | Standard LRS StorageV2; private package container; HTTPS/TLS 1.2; shared keys and public blobs disabled |
| Cosmos DB | NoSQL serverless, one region, Session consistency, local/key auth disabled |
| Container | `budget` / `accounts` by default; partition `/ownerId`; point reads/atomic same-partition batches; consistent indexing of system timestamp `/_ts/?` only, with document paths excluded; TTL enabled only for items supplying an expiry |
| Backups | Four-hour periodic backups, eight-hour retention, local redundancy |
| Function → Cosmos | Custom read-metadata and item read/create/replace/delete role on this container only; no queries, upsert, change feed, stored procedures, or management access |
| Function → host storage | Blob Data Owner on this host account only, needed for host containers/leases and private package reads; not subscription Owner |
| Browser → API | One exact supplied HTTPS origin; app-owned Bearer session and additional app-passcode grant; no cookies or wildcard CORS |

The Function can read all users' encrypted records in this dedicated container;
application authorization enforces owner isolation. Its permissions do not expose
plaintext financial data or password-derived decryption keys. Cosmos role
`assignableScopes` is the account, but the actual assignment is the single
container. An operator with permission to change website/API code or configuration
has a different and powerful trust boundary; do not give those rights to app
users or AI tools.

The endpoints are public HTTPS endpoints protected by authentication, not private
network endpoints. This template adds no VNet, private endpoints, WAF, or API
Management tier. App-level persistent throttling is included, but it is not an
upstream denial-of-service filter or spending cap. No Application Insights,
request-body capture, diagnostic export, analytics, or external telemetry is
configured. Azure still handles operational/network metadata.

## 1. One-time owner prerequisites

Use your own machine with Azure CLI, its Bicep component, Python 3, Node.js 22,
and an **existing** subscription/resource group. Choose a region supporting
Linux Consumption Functions and serverless Cosmos. Verify quota and provider
registration for Microsoft.Web, Microsoft.Storage, and Microsoft.DocumentDB.
Sign into Azure as the owner using `az login`; this manages infrastructure and is
unrelated to users signing into the budget app.

Provisioning needs resource creation rights and scoped role-assignment rights at
the target group. The template does not grant GitHub or a user those rights.
Later publishing needs Blob Data Contributor on the `function-packages` container
and Website Contributor on the Function App. Do not grant subscription Owner just
to publish code. Entra user application registrations and Graph permissions are
not needed.

## 2. Generate private deployment parameters

Create a private directory **outside this repository**. The helper writes two
independent random 32-byte secrets into a new owner-only file and never prints
them. It refuses to overwrite an existing file or place it inside the repository.
Replace the example region, origin, and output path with your actual values:

```sh
python3 infra/create-parameters.py \
  --output '/absolute/private/path/budget.parameters.json' \
  --location '<SUPPORTED_AZURE_REGION>' \
  --frontend-origin 'https://<YOUR_EXISTING_STATIC_WEB_APP_HOST>' \
  --name-prefix budget \
  --package-name budget-api-release-001.zip
```

Keep this file private and backed up securely. `authLookupKey` and `authPepper`
are secure ARM parameters supplying `AUTH_LOOKUP_KEY` and `AUTH_PEPPER`. They are
server-only secrets, not user passwords or budget keys. **Reuse their exact values
on every redeployment.** Changing the lookup key disconnects accounts; changing
the pepper invalidates logins. Do not regenerate them to update code.
`APP_ORIGIN` is set from `frontendOrigin`; Cosmos values are template-generated.
The server keys are not emitted in template outputs or copied into the API ZIP.
The example JSON contains placeholders only and must not hold real secrets.

## 3. Review, then provision the backend

Run the read-only plan first:

```sh
./infra/deploy.sh --subscription '<SUBSCRIPTION_ID>' \
  --resource-group '<EXISTING_RESOURCE_GROUP>' \
  --parameters '/absolute/private/path/budget.parameters.json'
```

The script uses ARM what-if and prints resource identifiers/change types only;
it keeps the full result in an owner-only temporary file and removes it on exit,
so app-setting values do not appear in its output. Review `main.bicep` for resource
settings, role scopes, region, public endpoints, and backup policy. What-if does
not prove live startup or estimate a monthly bill. After reviewing paid resources,
only this explicit flag applies changes:

```sh
./infra/deploy.sh --subscription '<SUBSCRIPTION_ID>' \
  --resource-group '<EXISTING_RESOURCE_GROUP>' \
  --parameters '/absolute/private/path/budget.parameters.json' --deploy
```

Record the non-secret outputs `functionAppName`, `apiBaseUrl`,
`hostStorageAccountName`, and package/container names. Deployment is incremental;
renaming resources does not migrate records or delete abandoned resources. There
is no automatic migration from the former Entra/plaintext API schema; use a fresh
dedicated backend container for this release rather than pointing it at old data.

If deployment fails partway through, some resources may already exist. Correct
the template and retry the incremental deployment with the same parameter file,
region, names, and server keys. Restore the saved private settings if temporary
Cloud Shell files expire; do not generate replacement keys for a partially
deployed backend. The failed Cosmos container can be retried without deleting
the resource group or the existing website.

Cosmos requires consistent indexing when container TTL is present, including
`defaultTtl: -1`. The timestamp-only index supports expiring rate-limit records
while document paths remain excluded. Documents without a positive item TTL,
including account records and encrypted budgets, do not expire automatically.

## 4. Build and publish API code

Provisioning creates infrastructure; it does not install the API package. A new
Function App may fail startup until its private package and roles are available.
The Cloud application checks GitHub workflow produces a downloadable
`budget-api-package` artifact (three-day retention). It contains code and locked
runtime dependencies, no private parameters or user records. Unzip the artifact
to obtain `budget-api.zip`, or build locally on Node.js 22:

```sh
npm ci --prefix api
./infra/package-api.sh /tmp/budget-api-release-001.zip
```

The package helper stages only `host.json`, package metadata, compiled `dist/`,
and production dependencies. `host.json` is at ZIP root. It uses locked dependency
versions with install scripts disabled and does not copy `.env`, tests, or local
development records. Choose a fresh output path; it refuses overwrites.

Use the non-secret deployment outputs to publish to those existing resources:

```sh
./infra/publish-api.sh --subscription '<SUBSCRIPTION_ID>' \
  --resource-group '<EXISTING_RESOURCE_GROUP>' \
  --function-app '<FUNCTION_APP_NAME>' \
  --storage-account '<HOST_STORAGE_ACCOUNT_NAME>' \
  --blob-name budget-api-release-001.zip \
  --package /tmp/budget-api-release-001.zip
```

The script uploads with your Azure CLI identity, refuses to overwrite the release
blob, points the app at its private package URL, restarts, and syncs triggers. It
never enables storage keys, generates SAS URLs, retrieves user data, or prints app
settings. The Function uses its managed identity to read the private ZIP. Initial
role propagation can take several minutes; retry startup after permissions settle.
Your owner account must have the scoped publishing permissions noted above.

For later releases, change only `deploymentPackageBlobName` in your existing
private parameter file to a new immutable ZIP name. Build/publish that release,
and retain the prior package for a deliberate code rollback. The Bicep template
also owns the package URL, so keep the private parameter filename value aligned
with the release you publish. Code rollback does not reverse account erasure or
migrate schemas. Securely delete unneeded old code packages when no longer useful.

## 5. Connect the existing website

The existing SimpleBudget website workflow defaults to its deployed API origin,
`https://simplebudget-q5q2a6ddopmq4.azurewebsites.net`. For a different backend,
set `VITE_API_BASE_URL` in GitHub repository **Settings → Secrets and variables →
Actions → Variables** to the public `apiBaseUrl` output, without `/api` or a
trailing slash. That variable overrides the workflow default. Then run **Azure
Static Web Apps CI/CD** again. The existing SWA deployment secret is preserved.
There are no frontend Azure client IDs, scopes, user tenant
registrations, client secrets, database keys, or password values to configure.
A custom website domain requires the exact `frontendOrigin`/`APP_ORIGIN` to be
updated deliberately; no wildcard is accepted.

Before real use, test with invented records: create two accounts, open the same
account in two browsers, verify cross-account requests fail, save on each device,
check conflict handling, and confirm the third wrong *app passcode* erases the
account while wrong account passwords merely throttle. Check browser requests
contain encrypted financial payloads, not readable amounts, names, or notes.
Do not upload an existing personal spreadsheet for diagnostics.

## Costs and operational limits

Functions execution/memory, Cosmos requests/storage, Blob capacity/operations,
backup storage, and outbound bandwidth may incur charges. Existing Static Web App
plans have separate quotas. There is no added per-user Microsoft-login licensing
requirement, but Azure hosting is not guaranteed free. Check current pricing in
your chosen region and configure Azure budget alerts. Free allowances and alerts
are not hard spending limits.

Linux Consumption Y1 has cold starts and resource limits and is scheduled to
retire on 30 September 2028; Node.js 22 is its final supported Node major. Plan a
supported host/runtime migration before their respective support deadlines.
Single-region storage and local backup redundancy do not provide regional disaster
recovery. Encrypted document size limits require history migration before large
accounts reach Cosmos's item limit. Abuse protection, review of dependency/code
changes, backup restoration, deletion metadata, availability, and capacity still
need owner attention before broad public use.

The native SwiftUI app remains local-only; this release supports the web app in
Safari and other browsers, not silent native-app synchronization. See
[security and privacy details](../SECURITY-AND-PRIVACY.md) for encryption, no-AI
boundaries, forgotten passwords, offline devices, and provider backup limitations.

## Verification status

Local syntax/build/package checks can be run without Azure credentials. The
repository tests use synthetic accounts only. ARM what-if, paid resource creation,
managed-identity propagation, package startup, billing, and live Azure access must
be verified in your subscription; they are not implied by a successful local test
or Static Web App deployment.
