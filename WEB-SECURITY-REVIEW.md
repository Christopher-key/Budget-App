# Repository security review — 4 November 2026

Reviewed the web, shared financial/export logic, API, Azure infrastructure and
operator scripts, GitHub workflows, committed Swift source, and the older offline
source archive. The native cloud draft was reviewed separately and remains paused
and unpublished. The deployed forecast-input fix is website build `5bf9000`.

## Result and fixes

This source review found no confirmed authentication bypass, cross-account access,
browser script injection, plaintext budget upload, or lockdown/reopen bypass in
the web/API code. Two medium availability issues were found and fixed in source;
their API deployment is still required. This is a scoped review result, not a
numerical vulnerability score, guarantee, or penetration-test clearance.

Changes made:

1. **Bound request-body memory.** The API previously called `request.text()` before
   checking the actual byte count. A missing or understated `Content-Length` could
   cause an oversized upload to be collected before rejection. HTTP streaming is
   now enabled, and a bounded reader cancels the body as soon as the route's byte
   limit is exceeded. Login/parameter requests remain limited to 1 KiB,
   registration to 2 KiB, trusted alerts to 64 KiB, and encrypted budget/setup
   requests to 1,600,000 bytes. Invalid UTF-8 and incorrect JSON media types are
   rejected. This reduces application memory amplification; it does not provide
   network-level denial-of-service protection. Azure Functions host 4.28 or later
   is required for streaming.
2. **Bound distributed authentication allocations.** Public parameter discovery
   lacked an aggregate limit, and login/registration created source/name counters
   before their aggregate gate. Rotating names and source addresses could therefore
   create unnecessary database records and reads. A fixed shared admission bucket
   now runs first: 600 parameter requests/minute, separately from 120 combined
   login/registration requests/minute. Existing account/source limits remain.
   Exhaustion returns HTTP 429 until the window resets; it does not erase accounts
   or activate site lockdown. These limits trade new-sign-in availability under
   load for bounded application work and do not prevent network-level attacks.
3. **Constrain deployment updates.** Every workflow action now uses a full commit
   SHA, checkout does not retain Git credentials, and verification uses read-only
   repository permissions. The API release job retains its narrowly scoped
   contents-write permission. The CodeQL check is read-only, does not upload
   source databases or duplicate any existing default code-scanning setup.
   The action guard discovers every workflow. Full runtime/build dependency
   advisories block website deployment and API package publication. Azure's pinned
   deployment action still uses a vendor-maintained container tag; these pins do
   not freeze its entire transitive supply chain.
4. **Add continuing checks.** A new workflow scans reachable Git history with a
   checksum-pinned Gitleaks binary, audits dependencies, and runs JavaScript/
   TypeScript and Python CodeQL security analysis on pushes, PRs, weekly, or by
   manual dispatch. Potential secrets are withheld from logs and artifacts.
   Dependabot proposes weekly action/npm updates without automatic merging.
   The CodeQL result guard fails its check on reported findings or invalid/missing
   reports. This does not close existing alerts; review the repository's
   code-scanning alerts and require appropriate checks through GitHub branch rules.
5. **Remove actual redundancy.** Removed three unused browser imports, the unused
   plaintext save-request interface and unused error-code union, and a duplicated
   Excel money-limit constant. Unused local/parameter compiler checks now run for
   web, API, and shared TypeScript. Repeated authorization checks, compare-and-swap
   reads, and stale-response checks were retained because they prevent races.

## Verification

Synthetic checks cover missing/forged identity, origin rejection, account and
session isolation, session expiry/revocation, stale-write conflicts, encrypted
payloads, three-wrong-PIN erasure, deletion races, and lockdown/recovery.
Browser/shared checks also cover authenticated encryption, strict schemas,
stale-response cancellation, Excel formula injection, and forecasting.

Local verification passed: 51 API tests, 42 browser tests, 16 shared/export/forecast
tests, 3 browser/API integration tests, and 72 infrastructure/workflow/result checks.
Type checks and the production website build passed. New cases cover bounded
stream reads, rotating names/sources across instances, unchanged account data
under rate exhaustion, and workflow action pins. The real Azure SDK request
stream was exercised in the parser tests.

All three application lockfiles, including development dependencies, reported
**zero known dependency advisories**. A Gitleaks scan of available reachable Git
history reported **zero potential secrets**; its detection/redaction was verified
using an invented credential pattern in a disposable local repository. Neither
result establishes that unknown vulnerabilities or unrecognized secrets cannot
exist. The offline ZIP also passed its source-only/unsafe-path/private-pattern
inspection.

GitHub verified source commit `be27263f0db40c3dcb008d728efe598a248955a2`:
[security/CodeQL checks](https://github.com/Christopher-key/Budget-App/actions/runs/41759036568),
[cloud checks and API release](https://github.com/Christopher-key/Budget-App/actions/runs/41759036518),
[Swift checks](https://github.com/Christopher-key/Budget-App/actions/runs/41759036500),
and [website deployment](https://github.com/Christopher-key/Budget-App/actions/runs/41759036476)
all succeeded. Both CodeQL analyses passed the no-findings result gate. This
applies to the selected queries and source commit, not live Azure settings.

## Native draft and remaining limits

Native code is excluded from `web/dist` and the API package. The paused, uncommitted
connected draft has three release blockers/concerns: an unsupported initializer
argument in `NativeCloudUI.swift`, failure handling in `NativeCloudSession.swift`
that can admit a late decrypted response, and a timeout that clears a task handle
before cancelling it. These were reported without resuming native development;
do not ship that draft. They are not deployed web SaaS vulnerabilities.

The committed offline edition uses iOS file protection and backup exclusions;
its four-digit PIN is a screen lock, not separate budget encryption. Extracted
local files are outside meaningful protection from its fast PIN verifier. Its
five-attempt cooldown differs from the cloud account's deliberate three-attempt
erasure. `OfflineBudgetSource.zip` remains a frozen older duplicate; README now
directs current development to the individual source files on `main`.

Actual account records, production credentials, live Azure control-plane settings,
and private GitHub settings were not accessed. No attack traffic was sent to the
deployed service. Provider permissions, forwarding-header provenance, real-host
streaming behavior, backup retention, branch protection, push protection, and
required-check settings still need operator verification and the planned
independent penetration test. Automatic lockdown alerts and independent admin
MFA remain unconfigured in this app; this update does not activate them or assess
the operator's Azure identity MFA. The chosen three-wrong-PIN erasure policy means
compromised account credentials can be used to destroy active account data even
without the correct PIN. Keep an independent financial record.

## Apply the API hardening

The website deploys through GitHub Actions. The API package is built and tested
there but must still be published using the owner's Azure identity. Source changes
alone do not patch a running Function App. No Azure identity is available in the
Codex workspace, so that live publication cannot be performed here.

Run the following in Azure Cloud Shell **Bash**. It is pinned to the release whose
checks and code package were verified above, so a later documentation-only commit
does not require a nonexistent new API build. It downloads only that tested
code package and preserves
existing keys, account data, and lockdown settings. New immutable package names
avoid replacing a different release. Publication restarts each Function App and
may briefly interrupt service. Both hosts use the same package with distinct
service roles; their existing roles remain unchanged.

```bash
set -euo pipefail
budget_review_sha=be27263f0db40c3dcb008d728efe598a248955a2
budget_review_dir=$(mktemp -d)
git -c advice.detachedHead=false clone --quiet --depth 1 \
  --branch "api-build-$budget_review_sha" \
  https://github.com/Christopher-key/Budget-App.git "$budget_review_dir/repository"
bash "$budget_review_dir/repository/infra/publish-github-build.sh" \
  --subscription 70620dac-9725-46a9-b2c6-f02a9c1e31df \
  --resource-group Simpleudget_group \
  --release "api-build-$budget_review_sha" \
  --blob-name "budget-api-$budget_review_sha.zip"
bash "$budget_review_dir/repository/infra/publish-github-build.sh" \
  --subscription 70620dac-9725-46a9-b2c6-f02a9c1e31df \
  --resource-group Simpleudget_group \
  --deployment-name budget-lockdown \
  --release "api-build-$budget_review_sha" \
  --blob-name "budget-security-$budget_review_sha.zip"
```

For a future upgrade, choose a newly verified API release explicitly and retain
new immutable package filenames. Verify login, sync, and manual lockdown/reopen with a disposable test account
before using actual financial data. Keep an independent record of your finances;
three consecutive wrong app PINs deliberately erase the active cloud account.
