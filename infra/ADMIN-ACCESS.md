# Administrator identity and management access

This is an evaluation and proposed permission model. No Entra policy, administrator
portal, manager role, or developer allowlist was enabled by writing this document.
The existing lockdown operator CLI remains the implemented emergency control.

## Free Microsoft Entra MFA

Microsoft documents **Security Defaults** as available with Microsoft Entra ID
Free, with no additional MFA license. It requires MFA registration across the
tenant, MFA for administrators and Azure management, and blocks legacy
authentication. This can protect the named people administering this app without
adding Microsoft sign-in to budget customers' accounts.

Security Defaults is tenant-wide, with no selective exceptions or custom
per-action controls. Conditional Access normally requires Entra ID P1; risk-based
Conditional Access requires P2. Do not describe the free setting as enforcing a
fresh phone approval for every reopen operation, two-person approval, or a chosen
phishing-resistant authentication method. Existing Microsoft 365 subscriptions
may already include premium entitlements; inspect licenses before buying anything.
Hosting, optional premium security products and hardware keys have separate costs.

This option uses Microsoft's identity system. A phone is a separate possession
factor, but Entra is not an independent provider like Duo. Adopting it would relax
the earlier requirement to keep the MFA provider outside Microsoft's platform.
Duo remains on hold unless the needed integration is free beyond a trial.

Microsoft's documentation was checked through its public MicrosoftDocs source:

- [Security Defaults](https://learn.microsoft.com/en-us/entra/fundamentals/security-defaults)
- [MFA licensing](https://learn.microsoft.com/en-us/entra/identity/authentication/concept-mfa-licensing)

Do not enable Security Defaults blindly from an application deployment script:
it affects the whole Entra tenant, including other Microsoft services. An Entra
administrator must review existing Conditional Access, enroll factors and verify
emergency access before changing tenant authentication policy. Azure subscription
ownership alone does not imply permission to manage Entra authentication policy.

## Management interface recommendation

Use **Azure Portal and the operator CLI initially**, authenticated as individually
named administrators, with MFA. A custom management portal has not been built.
If built later, give it a separate application registration, origin, narrowly
scoped service identity and authorization checks. A different URL alone does not
establish a separate security boundary.

A server-verified approved-user list is appropriate for granting specific roles.
Bind identities to the configured tenant and immutable object ID, and validate
token signature, issuer, audience, expiry and roles. Browser-visible controls
must never confer permissions on their own. A username, email address, hidden
button, app passcode, or editable local role flag must not authorize an operation.

Proposed roles for a future management portal:

| Person | Allowed work | Excluded by default |
| --- | --- | --- |
| Budget customer | Access their own budget | All service administration |
| Developer | Development/test and reviewed source changes | Production recovery, user budgets, server keys |
| Manager | Read minimal service/incident metadata; record review | Restarting service, code deployment, user budgets |
| Security operator | Initiate lockdown and review incidents | Budget records and encryption keys |
| Designated recovery operator | Explicitly reopen after reviewed remediation | Unrelated subscription-wide management |

These proposed roles are not current assignments. The existing emergency
operator role includes stop/start and control writes; do not give that combined
role to every manager or developer. Prefer direct named-user assignments for a
small initial team, with the exact effective permissions reviewed. Do not assume
premium group-based enterprise-app assignment or PIM features are free.

Protect deployment accounts and reviewed production changes: someone who can
replace website code can affect what future users see and enter. Keep standing
Owner/Global Administrator access limited and retain independently protected
emergency access. MFA on a sign-in does not neutralize an already stolen session
or a compromised Owner account.

For administrators, prefer strong account credentials and phishing-resistant
sign-in where supported. The earlier 8–12 digit code can be an additional check;
it must not replace a verified administrator identity and MFA. Failed admin
authentication must never erase customers' budgets or trigger a public global
outage that an attacker can deliberately cause.
