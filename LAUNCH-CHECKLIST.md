# Launch readiness checklist

Prepared 12 November 2026 against source release `04b221f`.

**Recommended current status: controlled beta.** Launch the website first if its
gates pass; the paused iPhone integration is a separate release. This checklist
does not certify that software is free of vulnerabilities.

Checked items below mean previously delivered and tested in source. Unchecked
items are outstanding work, decisions, or production facts that still need
evidence. They do not all imply a newly discovered defect. For each launch gate,
record its owner, completion date, release identifier, and evidence before
checking it off. Use synthetic accounts and records; keep actual financial data,
credentials, server settings, and private security reports out of this repository.

## Already delivered

- [x] App-owned sign-in and device-side encrypted budget sync; automated tests for account isolation, stale writes, and account erasure.
- [x] Budgeting, four-month forecasts, transactions, savings buckets and withdrawals, monthly history, and Excel reports.
- [x] APR/APY monthly dividend calculator; exact cent rounding, mobile/desktop browser checks, and separate planning estimates.
- [x] Manual service lockdown/reopen tooling and the neutral “Unscheduled Maintenance” screen.
- [x] Source hardening for bounded uploads and distributed authentication limits in release `be27263`.
- [x] Pinned workflow actions, scoped GitHub permissions, dependency updates, secret-history scans, and CodeQL checks.

Evidence: [source security review](WEB-SECURITY-REVIEW.md),
[feature and platform boundaries](README.md), and the corresponding GitHub runs.
Earlier clean scans and tests are evidence for those revisions, not permanent
assurance or proof of the configuration currently running in Azure.

## 1. Verify the deployed service — required for web launch

- [ ] **Confirm both API publications finished.** Record the running budget API and security-controller release/package identifiers. We have the owner's report that the publishing commands started, but no final success evidence for both. Confirm `be27263` or a subsequently reviewed release is installed; use the [pinned upgrade instructions](WEB-SECURITY-REVIEW.md#apply-the-api-hardening).
- [ ] **Run a production smoke test with disposable accounts.** Create an account, set a PIN, save/reload a budget, sync between two browsers/devices, export to Excel, lock, sign out, and sign in again. Verify one account cannot access another's records.
- [ ] **Exercise destructive and interrupted flows safely.** Verify the third consecutive wrong app PIN erases the disposable account; wrong account passwords do not. Check reconnecting devices and delayed saves cannot restore erased records. Test an interrupted save, session expiry, and a conflicting edit from another device.
- [ ] **Record the production configuration.** Verify HTTPS, exact allowed origins/CORS/CSP, enabled lockdown enforcement, correct service roles, protected package storage, and no request-body/credential logging. Record safe metadata only, not complete app-setting dumps.

Owner: Azure operator + developer. Completion evidence: release IDs and a dated
synthetic smoke-test record for the actual deployed website/API/controller.

## 2. Security and account protection — required for web launch

- [ ] **Complete an independent web/API penetration test and retest fixes.** Agree scope and safe testing conditions first. Cover authentication, account isolation, session/unlock handling, encryption boundaries, export, erasure, administrative controls, and abuse limits. Resolve critical/high findings; document the owner and treatment of any remaining findings.
- [ ] **Protect administrator and deployment identities.** Verify MFA for named Azure and GitHub administrators, least-privilege production roles, limited standing Owner access, and tested emergency access. Resolve the requested independent-MFA requirement explicitly; verify any chosen provider's continuing costs before enabling it. A custom manager portal is not needed for the first launch if the existing Portal/CLI access is properly protected.
- [ ] **Enforce GitHub release controls.** Verify protected main-branch rules, required tests/security checks, reviewed production changes, scoped deployment credentials, and available secret/push protection. Merely having workflow files does not enforce branch rules.
- [ ] **Provide a tested account-password compromise response.** The implemented account service has no password-change or forgotten-password recovery route. Before general release, provide authenticated password change with safe encryption-key rewrapping and revocation of older sessions, or an explicitly approved alternative. An administrator password reset must not bypass budget encryption. Keep the forgotten-password limitations clear.
- [ ] **Approve and clearly explain the three-wrong-PIN policy.** Preserve the chosen policy unless the owner changes it. Explain the difference between account password and app PIN before users create a budget, and test that users understand the data-loss consequence. Compromised account credentials can deliberately trigger erasure without the correct app PIN.

Owner: developer + security reviewer + product owner. Completion evidence:
private test/retest reports, an access review, and approved account-security flows.

## 3. Recovery and incident operation — required for web launch

- [ ] **Define and test service backup/recovery.** Agree acceptable downtime and data loss, verify actual Azure backup retention, and rehearse restoration using synthetic encrypted records. Protect and recover the existing lookup key/pepper and other essential server secrets through an approved private process. Do not casually regenerate them during recovery.
- [ ] **Ensure recovery respects deletion.** A restore must not silently revive erased accounts, old credentials, or sessions. Test how deletion tombstones, epochs, retention, and restored backups interact; document provider-backup limits honestly.
- [ ] **Decide the customer backup promise.** Excel exports are readable reports, not complete account-restoration backups. Either deliver and test an encrypted user backup/import feature, or explicitly approve and disclose the absence of customer restoration and the consequences of lost passwords/erasure. Do not advertise recovery that is not implemented.
- [ ] **Rehearse lockdown and recovery.** On an agreed test window, show “Unscheduled Maintenance,” deny API access, confirm budget data is retained, record incident review, and explicitly reopen for both a false positive and a remediated incident. Verify older sessions remain invalid after reopening.
- [ ] **Assign operational monitoring and response.** Set up privacy-preserving website/API availability, error, and abuse alerts; name the person receiving them and the response procedure. The public security-status endpoint alone does not prove the budget API is healthy. Confirm logs exclude financial records, PINs, passwords, and tokens.
- [ ] **Resolve automatic lockdown scope.** The verified-alert integration remains unconfigured. Either configure/test approved high-severity alerts and false-positive handling, or explicitly approve a staffed manual-only first release. Ordinary login failures must not let an attacker shut down the entire service. Finish an incident/customer-communication procedure.

Owner: Azure/security operator + product owner. Completion evidence: recovery and
lockdown drill records, alert delivery tests, and named operational responsibility.
See [lockdown operations](infra/LOCKDOWN-OPERATIONS.md) and
[administrator access guidance](infra/ADMIN-ACCESS.md).

## 4. Product quality and usability — required for web launch

- [ ] **Test the supported browser/device matrix.** Include an actual iPhone with Safari, desktop Safari, Chrome, and Edge. Check touch/keyboard entry, zoom, labels, VoiceOver/screen-reader use, backgrounding, downloads, refresh, interrupted connectivity, and reconnect. Chromium phone emulation is useful but does not replace Safari testing.
- [ ] **Reconcile financial totals with an independent reference.** Verify all pay periods, reported/manual expense handling, general savings and buckets, withdrawal sources, history/charts, and exports. Cover zero/overspend values, exact cents, leap years, month/year rollover, and shorter months.
- [ ] **Verify forecast and interest boundaries.** Confirm four future months, no overwrite of entered plans, no fabricated Realistic amounts, and no forecast contributions added to actual savings. Check APR versus APY, payout rounding, and that estimates do not create recorded income.
- [ ] **Make pay-schedule labels accurate.** Current “Bi-Weekly” means two selected dates per month; “Weekly” means four. Decide whether to describe/rename this manual monthly scheduling clearly or implement recurring 14-day/7-day schedules with extra-payday months. Market only the behavior actually supported.
- [ ] **Exercise capacity and performance limits.** Use a larger synthetic budget, concurrent edits and sign-ins, cold starts, export/history limits, and failure states. Load-test for the intended initial population against the shared authentication limits; set an initial user cap and clear retry messages. Resolve data-loss and blocking usability bugs.
- [ ] **Validate exported files in real software.** Open representative workbooks in Microsoft Excel and, if supported, Apple Numbers; verify totals, dates, selected months, excluded notes, and text/formula safety.

Owner: developer + independent beta testers. Completion evidence: browser/device
test results, reconciled sample workbooks, and closed or explicitly accepted bugs.

## 5. Public information and launch operation — required before marketing

- [ ] **Publish a web-specific privacy policy.** The current [privacy draft](PRIVACY-POLICY-DRAFT.md) describes the offline edition and is not suitable unchanged for Azure sync. Describe encrypted cloud records, authentication/security metadata, hosting providers, retention/backups, deletion limits, exports, support contact, and the absence of bank/AI/tracking integrations. Review requirements for the intended launch locations; avoid absolute “no data ever leaves your device” claims.
- [ ] **Publish support and service information.** Supply a working contact/help route, appropriate terms, and clear instructions for passwords/PINs, erasure, exports, savings estimates, and incidents. Support should never request passwords, PINs, or complete financial records.
- [ ] **Approve the launch promise.** Choose the audience, free/paid scope, supported platforms, and expected availability. Notifications and native/web parity are not established launch features; implement/test them if advertised, or leave them off the initial offer. If charging, separately validate billing/cancellation/refund obligations and flows.
- [ ] **Prepare the public identity and costs.** Choose the product name, URL, and accurate screenshots. A custom domain is optional; if added, verify TLS and update allowed origins/public configuration before retesting login. Set an Azure spending budget, alerts and an initial capacity cap; account for storage/backups and chosen domain/MFA/security services.
- [ ] **Complete a controlled beta and launch decision.** Suggested trial: 2–4 weeks with a small agreed cohort, including real iPhone Safari use and a month-boundary test. Track defects and support needs without collecting financial records. Require no unresolved critical/high security issues, data-loss bugs, or blocking core-flow failures; record the disposition of other issues.

Owner: product/release owner + privacy/legal reviewer as appropriate to the market.
Completion evidence: public policy/help URLs, an agreed operating budget, beta
results, and a dated release decision. A trial's duration alone is not a pass.

## Separate iPhone/App Store release — paused

These are additional gates for a native release, not reasons to hold a ready web
release indefinitely. Keep unpublished native draft changes out of web releases.

- [ ] Resolve Apple's developer/account review hold and verify signing/distribution eligibility.
- [ ] Fix and test the native draft's initializer/build blocker, stale-response invalidation, and task-cancellation concerns recorded in the [security review](WEB-SECURITY-REVIEW.md#native-draft-and-remaining-limits).
- [ ] Complete the explicitly requested login/budget/lockdown parity and deliberate local-data migration; test with the website on real devices. Do not claim parity while the published native edition remains local-only.
- [ ] Test the final Xcode project/archive, physical-device background/storage/export behavior, and supported iOS versions. A source-only CI type check is not an App Store archive or device test.
- [ ] Update native privacy manifests, in-app/published policies, App Privacy answers, review notes and screenshots to match the actual shipping architecture. The offline edition's “Data Not Collected” reasoning must not be reused automatically for a connected edition.
- [ ] Complete TestFlight validation and App Store review requirements for the chosen release. See [submission notes](APP-STORE-PRIVACY.md) and verify current Apple requirements at submission time.

## Release sign-off record

Do not mark the general public launch approved merely because CI is green.
Close the applicable gates above with evidence and explicit treatment of any
accepted limitation. Record web and native decisions separately.

| Field | Record at sign-off |
| --- | --- |
| Release scope | Web / native; intended audience and free/paid scope |
| Website commit | Exact reviewed source revision |
| Budget API / controller | Exact running releases and configuration evidence |
| Security | Pen-test/retest disposition and administrator-access review |
| Recovery / incidents | Backup and lockdown drill references; response owner |
| Quality / beta | Device tests, financial reconciliation, accepted issues |
| Public information | Privacy, terms and help URLs |
| Decision | Release owner, date, approved scope and rollout/user cap |
