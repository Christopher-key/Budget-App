# Incident lockdown and recovery

These optional files are not deployed by repository CI. The currently working
site stays unchanged until its owner provisions, publishes, and enables this
feature. Test it with invented accounts before accepting real financial records.

## Owner-authorized activation

The owner has authorized activating the prepared gate while deferring Duo and
the independent recovery portal. Run the following from a current checkout in
**Azure Cloud Shell Bash**. It uses the existing Azure login and requires no
financial records, server-key file, GitHub token or manually uploaded ZIP:

```sh
python3 infra/enable-lockdown.py \
  --subscription 70620dac-9725-46a9-b2c6-f02a9c1e31df \
  --resource-group Simpleudget_group --static-web-app SimpleBudget \
  --release api-build-b154e18663e138fef4831e73be363ee2ddfb19d5 \
  --apply
```

Omit `--apply` for a public-metadata-only plan. The owner must have resource and
role-assignment permissions. Automatic operator discovery reads the signed-in
user's object ID; if that directory lookup is unavailable, supply the approved
human user's `--operator-object-id` explicitly. The script grants code publishing
only on the two package containers and the existing scoped operator roles.

The activator verifies the GitHub ZIP/checksum before Azure changes, provisions
the separate controller/storage on the existing plan, creates an initial locked
control record with create-only semantics, and verifies the controller before
stopping the budget API. It then enables the gate while the API is stopped,
publishes the new code, and checks the locked response. **Only an unchanged first
initialization** can be commissioned open. This records initialization rather
than labeling maintenance a false security alert. Existing incidents, confirmed
initializations and previously commissioned records are never automatically
reopened. A failure after stopping the API requests another stop; inspect control
state before resuming. Do not disable the gate as a startup workaround.

Commissioning briefly interrupts API access and invalidates earlier sessions.
It does not read or change financial records or regenerate account keys. New
execution/storage charges may apply; no Duo subscription or paid alert service
is purchased. Automatic alert forwarding remains unconfigured.

On success the script prints a public `securityStatusUrl`. Set the GitHub Actions
repository variable `VITE_SECURITY_STATUS_URL` to that exact URL and rebuild the
Static Web App, or share only that public URL with Codex so the verified website
configuration can be completed. Azure Static Web App runtime settings do not
replace this GitHub/Vite build configuration. Do not enable a guessed URL.

**Future infrastructure updates:** the existing `main.bicep` owns the entire API
app-settings array. Redeploying old backend parameters can remove the gate flags
and restore an older package. Preserve the enabled control URL, enforcement flag
and new package filename in the infrastructure configuration before any later
`budget-backend` redeployment. The activator does not read or rewrite the private
account-key parameter file. The emergency Azure operator tool remains available
while independent MFA recovery is deferred.

The normal administrator experience still needs the independently hosted
8–12 digit passcode and phone MFA requested by the owner. **The Azure CLI below
is an emergency Azure-operator path; it does not enforce that independent MFA.**
Do not present an app-only PIN screen as protection against a compromised Azure
Owner. An Owner or code-deployment administrator can bypass application checks.

## What is controlled

The budget API checks an independently stored private control blob before and
after requests. A locked, missing, invalid, or unreachable control record denies
access when `SECURITY_GATE_ENFORCED=true`. A generation change invalidates old
account sessions; it does not change budget encryption keys or erase budgets.
The frontend consults the independent controller and replaces the budget page
with a service notice. It discards in-memory financial data, keys and pending
writes instead of uploading them during incident handling.

The controller also stops the budget Function App through Azure's management
plane. Stopping the API provides a control outside the budget API process;
checking a software flag alone cannot restrain compromised API code. Stop/start,
role changes and browser polling take time to propagate. Requests already
admitted may complete. A stop cannot recall previously downloaded/exported data
or instantly invalidate every stolen Azure access token. The unconnected native
iPhone app and offline devices are not remotely erased by a website lockdown.

The controller is another trusted workload: its own storage permissions permit
control writes, including an `open` value. Its Azure management role permits
**stop only**, so controller code cannot start an already stopped budget API.
This separation does not protect against a compromised subscription Owner.

## Resources, least privilege and charges

`lockdown-control.bicep` adds one Linux Function App on the existing same-region
Y1 plan and a separate Standard LRS StorageV2 account. It does not request another
Y1 plan quota. The control account must never be the budget API's host account:
that API has host-wide blob permissions on its own storage.

| Identity | Added access |
| --- | --- |
| Budget API managed identity | Read blobs only in `service-control`; no control writes |
| Controller managed identity | Blob Data Owner on its own host/control account; stop only on the budget Function App |
| Named operator users | Read/write control blobs without delete; read, stop and start the budget Function App |
| Separate code publisher | Requires Blob Data Contributor on only the controller's `function-packages` container and appropriate Function publishing rights |

The controller receives no budget Cosmos role, budget host-storage role,
`AUTH_LOOKUP_KEY`, `AUTH_PEPPER`, budget settings-read permission, or permission
to start the budget API. Existing inherited grants still matter; the template
does not remove them. Review `audit-access.sh` before claiming least privilege.

Function requests/execution, control-status polling (approximately every ten
seconds per visible browser), storage capacity/operations and bandwidth can add
charges. Reusing a plan is not a promise that usage is free. Defender/security
alert products, a separate identity/MFA provider, and optional Entra PIM or
Conditional Access can have additional licensing charges. No such service is
automatically purchased or configured by these templates. Review current region
pricing and configure billing alerts before provisioning.

## Staged installation

1. Keep `VITE_SECURITY_STATUS_URL` unset and the budget API gate disabled while
   preparing infrastructure. Save the existing server-key parameter file and
   reuse its keys; this installation never needs replacement account keys.
2. Read the existing budget Function's public managed-identity object ID and
   existing Linux Y1 plan resource ID from Azure resource metadata. Confirm the
   exact frontend HTTPS origin and approved **operator user object IDs**. An
   application/client ID is not a user object ID.
3. Create a private parameter file outside the repository for
   `lockdown-control.bicep`, supplying `location`, `budgetFunctionAppName`,
   `budgetFunctionPrincipalId`, `existingPlanResourceId`, `frontendOrigin`,
   `operatorObjectIds`, and a new immutable `deploymentPackageBlobName`.
   Leave all alert authentication/allowlist parameters empty initially. Review
   an ARM what-if and the additional charges before provisioning a deployment
   named `budget-lockdown`. The template does not initialize the control blob
   or modify existing budget API settings.
4. Publish the same checked GitHub API build to the new controller. Its
   `SERVICE_ROLE=security-controller` selects only status/alert routes. Grant
   the separate publishing identity the scoped package permissions in the table;
   the operator control-writer role intentionally cannot publish code:

   ```sh
   bash infra/publish-github-build.sh \
     --subscription '<SUBSCRIPTION_ID>' --resource-group '<RESOURCE_GROUP>' \
     --deployment-name budget-lockdown \
     --release 'api-build-<FULL_CHECKED_COMMIT_SHA>'
   ```

5. Schedule a maintenance window. Run the manual **lock** command below to
   initialize the blob locked and stop the budget API. **While the budget API
   remains stopped, first set** `LOCKDOWN_BLOB_URL` to the new deployment's public
   `controlBlobUrl` output and `SECURITY_GATE_ENFORCED=true` in its settings.
   Preserve all existing server keys/settings. Verify the control is still
   locked. Only then publish the new checked API build to the existing budget
   app using a **new** immutable blob name:

   ```sh
   bash infra/publish-github-build.sh \
     --subscription '<SUBSCRIPTION_ID>' --resource-group '<RESOURCE_GROUP>' \
     --release 'api-build-<FULL_CHECKED_COMMIT_SHA>' \
     --blob-name 'budget-api-security-002.zip'
   ```

   Publication restarts the app; the newly loaded code must immediately deny
   requests through the already enabled, locked gate. Stop the budget Function
   again during setup. Update the existing private deployment file's
   package filename to match; a future infrastructure deployment must not reset
   it to old code. Never overwrite a different package under the same blob name.
6. Only the new controller has `SERVICE_ROLE=security-controller`; the budget
   API must retain its budget role. Wait for managed-identity role propagation
   and verify locked API requests are denied after publication. If the controller
   or control cannot be read, keep the API stopped. Do not temporarily disable
   the gate to work around a missing role or failed controller startup.
7. Set the GitHub public variable `VITE_SECURITY_STATUS_URL` to
   `https://<CONTROLLER_HOST>/api/service/status` and rebuild the Static Web App.
   Confirm the notice appears without login and without any incident details.
8. Complete the independent administrator authentication setup before offering
   normal recovery. For controlled commissioning only, the emergency operator
   can review status and explicitly reopen using the commands below. Verify
   old browser sessions cannot resume, fresh sign-in works, and manual lock
   stops service on two devices without changing saved budget ciphertext.

The independent public status endpoint should stay running while the budget API
is stopped. Do not stop the controller or the Static Web App as a routine lock
action, because they provide the public notice. Package deployment, management
plane stop/start and the control blob do not form one atomic transaction. Keep a
maintenance notice in place and inspect state after each owner-side step.

## Emergency operator commands

Use an approved Azure operator session on a trusted personal machine or Azure
Cloud Shell. Do not share credentials, passcodes or MFA seeds in chat, GitHub,
terminal command arguments, or source files. Azure identity authorization on
this path is separate from the future independent administrator MFA service.

All commands require the **independent control storage account**, not the old
budget host storage account. Supply the same public deployment names each time:

```sh
python3 infra/lockdown-control.py \
  --subscription '<SUBSCRIPTION_ID>' --resource-group '<RESOURCE_GROUP>' \
  --function-app '<BUDGET_FUNCTION_APP>' --storage-account '<CONTROL_STORAGE>' \
  --action lock
```

`lock` initializes missing state as locked or increments the generation for a new
incident. It attempts to stop the API even if control read/write fails. A warning
that the blob could not be secured means keep the API stopped and repair control
before recovery; do not treat it as a normally initialized lockdown.

Run the same command with `--action status` to read only bounded incident
metadata. Review the actual trusted security alert, Azure Activity Log, workload
access and code changes. MFA proves the administrator's identity; it does not
prove that the alert was a real attack. Record the outcome in a restricted
incident system, without copying financial records or raw credentials.

To mark an incident confirmed, use `--action confirm --expected-generation N`
with the generation from that fresh status check. Confirmation keeps the service
stopped. To recover after investigation/remediation, use:

```sh
python3 infra/lockdown-control.py \
  --subscription '<SUBSCRIPTION_ID>' --resource-group '<RESOURCE_GROUP>' \
  --function-app '<BUDGET_FUNCTION_APP>' --storage-account '<CONTROL_STORAGE>' \
  --action reopen --expected-generation '<FRESH_GENERATION>' \
  --resolution remediated
```

Use `--resolution false-positive` only after reviewing an incorrect alert. A
resolution is an operator assertion, not automated evidence verification. Reopen
increments the generation and explicitly starts the API. If start/read-back
fails, the script tries to relock and stops the API; review status again. A CAS
conflict means another incident/operator changed the record. Never retry a stale
recovery command blindly. No alert timeout, resolved event, or normal app login
automatically reopens service. Do not use a blanket platform-wide erase as an
incident response: it would destroy user budgets without stopping compromise.

If API code, the controller or Azure credentials may be compromised, a stop alone
is insufficient. Preserve incident evidence, revoke/rotate affected credentials
and workload grants deliberately, audit deployment access, deploy reviewed code
and test with synthetic records before recovery. Do not rotate the budget
account lookup key/pepper casually; doing so breaks existing account access.

## Automatic trigger: disabled until a trusted adapter is configured

The optional alert route accepts a signed Entra application token from an exact
tenant, issuer and audience, with the `Budget.Lockdown.Trigger` app role and an
explicitly allowed service-principal **object ID** (`oid`). Configure only a
dedicated, controlled adapter identity; a shared Azure Monitor identity plus a
rule display name does not establish that an alert came from your own rule.

The supported body is Azure Monitor common-alert schema: an exact approved
`essentials.alertRule`, exact approved `essentials.monitoringService`, `Fired`
condition, high mapped severity (`Sev0`/`Sev1`), a recent fired timestamp and the
exact budget Function resource ID. All authentication and rule/source allowlists
must be configured; empty defaults deny automatic triggering. Do not allow a
generic metric alert or ordinary failed login to stop the SaaS. Protect and
verify the adapter's link to the real high-severity security alert. The controller
does not independently prove an attack from the submitted description.

The controller stores only bounded incident metadata and alert-ID hashes for
deduplication, then requests API stop. It never retains alert bodies, financial
records, passwords or authentication tokens. Replayed notifications can retry
an interrupted stop; resolved notifications cannot reopen service. Alert setup,
trusted-source verification and end-to-end tests in your tenant remain owner-side
requirements, separate from local unit tests.

## Optional configuration guardrails and access inventory

`audit-access.sh` reads selected deployment outputs, ARM properties and assigned
role definitions. It does not read budget documents, control contents, app
settings, tokens or account keys. It is an inventory, not a full effective-access
analysis: nested groups, eligible/PIM grants, deny assignments, role conditions
and hidden grants need separate review. Object IDs do not identify a principal
as an AI tool or prove trustworthiness.

Before reviewing the policy baseline, run `check-security-aliases.sh` with the
subscription and resource group. It reads live alias metadata; a local Bicep
compile cannot prove those aliases exist/evaluate correctly in the subscription.
`security-baseline.bicep` requires an explicit resource-ID allowlist and defaults
to `DoNotEnforce`. Its optional Deny rules guard identity-only Storage/Cosmos
authentication and secure transport settings on those resources. Start with
compliance review and test representative intended deployments before switching
to `Default`. The templates neither create arbitrary owner-defined Azure deny
assignments nor prevent an Owner from modifying/removing policies. They cannot
universally classify or block all AI software, identities or administrator tools.
