# Independent administrator MFA with Duo

Status: **design and activation checklist only**. No Duo account, application,
secret, administrator portal, or recovery endpoint has been connected or deployed.
**Cost condition: use Duo only if the required integration has $0 MFA licensing
and integration fees on both the service and user sides beyond any trial.**
Until that is confirmed, Duo is on hold; select another approach if it requires
payment. Separate hosting and operational charges also need review before activation.
The existing [lockdown operator tool](lockdown-control.py) uses Azure authorization;
it does **not** enforce Duo. Its Azure access is an emergency recovery path and
must not be represented as independent MFA.

## Intended administrator experience

An administrator opens a separate recovery portal, enters a permanent **8–12 digit
administrator passcode**, and approves a second factor with Duo. Prefer 12 randomly
generated digits. This passcode is separate from every user's four-digit budget
passcode and must never trigger deletion of financial records.

The portal displays only security control metadata: whether access is paused, the
incident reference, current generation, and review state. It offers separate
actions to lock access, confirm an incident, and reopen after selecting
`false-positive` or `remediated`. A phone approval establishes the operator's
identity; reviewing alert evidence establishes whether an attack occurred.
No timer, resolved alert, or successful phone approval automatically reopens access.

## Keep the authentication boundary outside Azure

Use a separately administered identity/recovery service and portal hosted outside
the budget application's Azure environment. That service authenticates the
primary passcode and performs the supported Duo MFA flow. Duo MFA by itself does
not necessarily provide storage or verification for a custom primary passcode.
Select the primary identity provider and supported Duo integration before writing
that part of the connection.

The administrator passcode verifier, Duo client secrets, Duo integration secrets,
and approval-signing private key stay outside Azure. Do not place them in the
budget app, Static Web App configuration, Function settings, GitHub, or this chat.
Phone registration and backup-factor enrollment happen directly in the provider's
secure administrator interface. An offline authenticator generates codes without
Azure, but storing its shared verification seed in Azure would still leave the
verification boundary there. Duo's documented factors and availability depend on
the selected integration; do not assume offline codes are supported by every flow.

After authentication, the external recovery service should issue a short-lived
signed approval bound to the exact **incident, generation, action, resolution,
expiry, intended recovery service, and a one-use random challenge**. Azure receives
only this approval and public verification keys. The budget API must not receive
the administrator passcode or Duo secrets.

Server-side verification must check the signature, fixed issuer and audience,
approved operator, required fresh MFA assurance, challenge, expiry, and exact
requested transition. Consumption of the challenge and update of the control
record must use conditional writes so a concurrent alert or replay cannot reopen
a different incident. Provider claims and the MFA requirement must be verified
against the chosen integration; a client-supplied `mfa: true` value is insufficient.
Do not create a public recovery endpoint until this contract and its tests exist.

A local script that prompts for Duo and then runs `az` does not enforce this
boundary: anyone holding the same Azure permissions can skip the prompt. A genuine
recovery service needs its own narrowly scoped execution identity and must verify
external authorization on the server. Keep the existing Azure emergency path
explicit, restrict its operators, and audit its use.

## Activation prerequisites and costs

Before activation, confirm the following with the account owner:

- A suitable Duo application/integration and supported second factor, plus a
  separately protected Duo administrator account and recovery factors.
- A primary identity service that can enforce the requested passcode policy,
  memory-hard salted password verification, online attempt limits, and safe
  account recovery. A numeric passcode needs strict online limits and MFA;
  8–12 digits alone is not a sufficient public administrator login.
- Separate hosting, domain/TLS, secret management, signing-key rotation, audit
  retention, and supported access from the recovery service to Azure.
- Explicitly scoped recovery permissions: update the security control record
  and stop/start the budget API, with no access to financial records, budget
  encryption keys, or application authentication keys.
- Tests for missing/bad/expired approvals, absent MFA, replay, wrong operator,
  changed incident/generation, unavailable Duo, and an alert arriving during
  recovery. Recovery must remain closed on authentication failures.

Duo pricing, supported integrations, minimum seats, and free-tier eligibility have
**not been verified** for this project. Do not assume the required server-side
integration is free because a phone authenticator app is free. Review the current
[Duo pricing](https://duo.com/editions-and-pricing) and the chosen identity/hosting
provider's charges before activation. A free trial does not meet the owner's cost
condition. This repository does not enroll in a trial, purchase a plan, or provision
the external portal. No paid fallback is authorized by selecting Duo as a candidate.

## Limits during a serious compromise

A different provider adds a separate authentication boundary. It does not prevent
an attacker with Azure Owner permissions from changing Azure code, role grants,
or control records. Azure administrator restrictions and a clean emergency account
remain necessary. A compromised administrator device or Duo account can also
undermine recovery. Independent MFA cannot revoke previously copied data, erase
offline exports, or guarantee that an attack has been fully contained.

For an Azure control-plane compromise, secure the administrator accounts and
restore trusted code and permissions before reopening. See
[LOCKDOWN-OPERATIONS.md](LOCKDOWN-OPERATIONS.md) for the prepared service controls
and their current deployment status.
