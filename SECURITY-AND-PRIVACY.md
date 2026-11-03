# Web account security and privacy

This describes the app-owned account and encrypted-sync design implemented in
this repository. Enabled controls depend on the deployed code and configuration;
source changes alone do not activate optional security features. No hosting
provider can give an unconditional "no AI will ever see data" guarantee.

## What is kept where

| Information | Browser | API / Azure storage |
| --- | --- | --- |
| Account password | Entered for login or creation; not persisted by app code | Never uploaded or stored |
| Username | Entered for login; not persisted by app code | Used transiently; stored account lookup is a keyed pseudonymous digest |
| Login proof | Derived for authentication; transient | Received over HTTPS; stored only as salted scrypt verifier with an independent server pepper |
| Account session | Opaque expiring token in page memory | Only a token hash and expiry |
| Budget encryption key | Usable nonextractable CryptoKey in page memory | Password-encrypted key envelope only |
| Budget records / goals / export history | Decrypted while budget is open | AES-256-GCM ciphertext and random nonce only |
| Four-digit app passcode | Entered to unlock or authorize export; not persisted by app code | Salted, slow-hashed verifier, never plaintext |
| Security metadata | Current epoch, revision, session status | Pseudonymous owner ID, salts, epochs/revisions, bounded attempt counters, timestamps, expiring rate-limit records, deletion tombstone |

The hosting provider also processes connection metadata such as IP addresses,
request times, sizes, infrastructure billing, and provider-controlled diagnostics.
Budget names, amounts, transaction notes, and targets are not included in API
routes or application logs. HTTPS is required for a deployed API.

Locking immediately clears the displayed budget. Pending edits get a bounded,
encrypted save attempt before the old unlock grant is revoked. Closing the
browser, losing connectivity, or an expired session can prevent the last edit
from saving; the app does not retain an offline financial queue. Wait for the
sync indicator to finish before closing the page when a save matters.

## Encryption and password verification

The browser uses PBKDF2-HMAC-SHA-256 with 600,000 iterations and a random salt,
then HKDF with separate purposes for the authentication proof and AES wrapping
key. A random 256-bit budget key encrypts financial records using AES-GCM with a
fresh random nonce. Authenticated context binds ciphertext to the account and
its budget epoch/revision, so a different account's or stale record cannot simply
be substituted under a different authenticated context. Normal version checks
reject stale writes; this is not a cryptographic guarantee against a fully
compromised server replaying an entire older valid state.

The API receives a high-entropy authentication proof, not the password or the
password-derived wrapping key. It stores a fresh-salted scrypt verifier using
N=131072, r=8, p=1 and an independent server-side pepper. Session/unlock tokens
are random and stored only as hashes. The server's lookup key and pepper are
independent 32-byte secrets supplied through secure deployment parameters;
neither is shipped to the browser, source repository, or package artifact.
They are encrypted at rest by Azure's app-setting platform and readable only to
principals with the relevant Azure configuration permissions. They are not
budget decryption keys. Losing or casually rotating them makes existing accounts
unusable; migration requires a deliberate design.

The four-digit passcode remains an authenticated online lock, not a substitute
for a strong password. A password of at least 12 characters is required. Salts,
slow hashing, and encryption reduce risk; they cannot make a weak password or
compromised device safe.

## Access, AI, and logs

This app includes no AI client, ChatGPT plugin/API, financial analytics SDK,
third-party tracking script, external font dependency, or automatic financial
export. Its content security policy restricts browser connections to the website
and the explicitly configured API. The backend has no route for an AI service or
administrator to retrieve decrypted budgets, and no private decryption key is
stored by it.

The Function's managed identity receives item access only on the dedicated
Cosmos container, plus required Blob host/package access. It receives no Graph,
mail, files, subscription-owner, account-key, or database-management permission.
Account/session checks enforce user isolation; Cosmos itself does not grant
separate RBAC roles to individual user partitions. The Function process can read
all encrypted records in its container, not their decryption keys.

No Application Insights, diagnostic exports, request-body logging, financial
analytics, or telemetry sink is configured. Never enable request/response-body
capture, print headers, copy real records into support tools, or give an AI tool
production secret/database access. Repository tests and artifacts contain code
and invented test records only. Manual Excel exports leave the encrypted sync
boundary and are not password-encrypted by the app.

The app cannot control a hosting provider's internal policies, authorized
administrators' future actions, malicious changes to served JavaScript, browser
extensions, operating-system access, screenshots, password-manager choices, or
data someone deliberately pastes into another service. An administrator capable
of changing the website could serve code that captures future passwords and
plaintext while a user logs in. End-to-end encryption protects stored records;
it does not eliminate the need to trust the software delivered to devices.
Only the app owner should hold production Azure/GitHub administration rights;
use scoped roles, protected deployments, and reviewed changes.

The API build runs in GitHub with read-only repository access and no Azure
credentials. A separate job receives repository-content write permission only
to publish the tested, code-only package and its checksum. The package contains
no production account records, server settings, or budget keys. Cloud Shell
downloads that package and uses the owner's Azure identity to publish it; no
Node build or manual ZIP upload is required there. The checksum detects a changed
or damaged download; it cannot establish that a compromised builder produced
safe code.

The existing website workflow separately uses its resource-specific Static Web
Apps deployment token from GitHub Secrets. That token can update the website,
which is why repository/workflow administration remains part of the software
trust boundary. It is not a budget-app user password or database credential.

Optional resource-scoped Azure Policy templates and an access-audit helper are
included in `infra/`. Policy assignments default to `DoNotEnforce`; compiling or
committing them does not enable live denial. Check the resource-provider aliases
and compliance results before opting into enforcement. Azure Policy can reject
unsafe resource settings, such as enabling shared storage keys; it cannot
recognize every AI client or cancel every existing administrator permission.

## Site-wide lockdown and recovery

The optional lockdown feature is disabled until its independent control service
is deployed and explicitly configured. Deploying a new website build alone does
not activate it. See [the operations guide](infra/LOCKDOWN-OPERATIONS.md) for the
staged activation procedure and the additional Azure resources.

The control record lives in a separate storage account. The budget API's managed
identity can read that record but cannot update it. With enforcement enabled,
every account/budget route checks control state before doing work and before
returning success. Missing, invalid or unreadable control state denies access.
A separate controller publishes a small public status document containing only
the state and generation. It has no budget database role or financial keys.
It can lock the control and stop the budget Function App; it has no permission
to start that app. This provides an independent stop operation even if a change
to the budget API were to ignore its software gate.

Automatic lockdown is optional and rejects requests until its trusted alert
source is configured. The alert adapter requires authenticated, approved security
alerts; public password failures and ordinary metric alerts do not trigger a
site-wide outage. An alert is a reason to pause and investigate, not proof that
financial data was accessed. Resolved alerts never reopen the service.

Lockdown clears the web app's displayed ledger, encryption-key references,
session tokens and pending financial writes when the browser detects it. That
path does not flush a save, export records, or erase an account. Status polling
and checks on visibility changes do not make a disconnected browser remotely
erasable. A request admitted before the flag changes may still finish writing;
the control and budget records are not one distributed transaction. Stopping
Azure Functions also has propagation time. Copies already exported, downloaded,
photographed or exfiltrated cannot be recalled by this feature.

An authorized operator can manually lock, mark an incident confirmed, or reopen
after recording `false-positive` or `remediated`. Confirmation alone keeps the
service stopped. Recovery uses a fresh control generation and conditional writes
to avoid overwriting a simultaneous incident. Old sessions and unlock grants
cannot resume after reopening; users must sign in again. A generation change
does not alter or delete users' encrypted financial records.

The current operator CLI uses the operator's Azure identity. It is an emergency
administrative path, **not an independently enforced MFA portal**. Merely checking
a phone code in a local script would be bypassable by someone with the same
Azure permissions. Do not publish a numeric-code-only recovery endpoint.

The requested next recovery layer is a permanent 8–12 digit **administrator**
passcode plus MFA enforced outside Azure. **Duo is a candidate only if its required
integration is free on both the service and user sides beyond any trial.** Until
that is verified, leave it unconnected and choose another approach if it charges.
These are separate from
users' four-digit app locks. Prefer 12 randomly chosen digits and provider-side
attempt limits; do not store the passcode or phone authenticator secret in Azure,
GitHub, logs or source. Duo retains the second-factor enrollment. A separately
protected primary identity service or recovery portal must verify the permanent
passcode; Duo MFA alone is not a password store. To keep both secrets out of
Azure, that primary verifier must also be hosted independently. The external
recovery service would issue short-lived signed approvals. Azure would
hold public verification keys and narrowly scoped issuer/audience/operator
configuration. Recovery approval must be bound to the incident, generation,
action and expiry, with replay prevention and fresh MFA enforcement. Provider
enrollment and that approval integration are not implemented by the current CLI.
See [Duo recovery preparation](infra/DUO-RECOVERY.md). No admin passcode, MFA seed
or third-party account has been created.

Authenticator apps can generate codes without a subscription or SMS fee, and
GitHub offers account 2FA without a separate MFA license. Neither alone enforces
MFA on this recovery path. An independent hosted identity provider may charge
for enforced MFA. Open-source identity systems have no software-license fee but
need separate hosting, updates and recovery operations. Verify the selected
provider's current MFA entitlement before activation; this repository does not
assume a particular Duo integration is included in a free plan. The optional
controller and storage are also subject to Azure usage charges; reusing the
existing plan does not guarantee a zero bill.

Any owner able to change Azure roles, controller code or served JavaScript can
bypass controls hosted under that ownership. External MFA improves separation
but does not by itself survive a fully compromised Azure Owner account. Limit
standing owner permissions, protect deployment accounts and retain an
independently protected incident-recovery process. These policies and the
lockdown mechanism are not a guarantee against every sophisticated attack.

## Deletion and recovery

Three consecutive wrong app-passcode entries on authenticated sessions trigger
server-side atomic deletion of active encrypted budget data, account credentials,
wrapped keys, and grants. Correct entries reset the shared consecutive counter.
Replay-resistant attempt identifiers avoid counting an identical retry twice.
Public account-password failures are throttled instead of deleting data, so a
stranger cannot erase an account by guessing its password three times.

A minimal pseudonymous tombstone/epoch survives to reject stale writes. Open
connected web sessions detect revoked accounts on their next request or status
check and clear their records. An offline device cannot receive an immediate
remote-erasure command; independent copies, screenshots, exports, and browser or
OS memory snapshots are outside this guarantee.

Deletion of active Azure records is not instantaneous destruction of every
provider backup. The template chooses four-hour periodic Cosmos backups with
8-hour configured retention (the minimum periodic retention supported by this
configuration). A backup can contain historical ciphertext and encrypted keys
until its retention expires; deletion metadata needs to be preserved if backups
are ever restored. Possession of a weak password plus a historic backup can
still permit offline password guessing. Azure's own operational retention and
legal requirements remain separate.

There is no email or identity-provider recovery path. Without the correct
password, the API cannot decrypt the budget key. There is no app-readable
plaintext backup. Excel reports are independent readable exports, not a full
account-restoration format.
