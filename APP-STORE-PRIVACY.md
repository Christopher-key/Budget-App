# Offline App Store submission notes

## Prepared artifacts

- `ContentView.swift`: current complete app source. Financial records, recovery
  copies, passcode verifier, and lock retry metadata use Application Support/MyBudget.
  Parent backup exclusion is set and verified before writing. Files use iOS
  complete file protection and atomic writes. Redundant individual file backup
  flags are also attempted; parent exclusion covers atomic replacements.
- Settings includes a static, offline Privacy Policy screen. Keep that text and
  the published policy consistent with the final shipped app.
- Trends → History & Trends includes an on-device Swift Charts comparison of current/prior calendar
  years. Orange is current year, purple/dashed is prior year; green/red monthly
  points indicate expense budget met/exceeded. It adds no packages or network
  calls. The metric is budgeted expenses minus realistic expenses, including
  logged transactions. Savings and income do not affect this metric. Untouched,
  invalid, and future-current-year months are not plotted; missing months break
  the lines. Current-month values are month-to-date, not a completed-month result.
- Settings → Pay schedule lets users choose Monthly (one date), Bi-Weekly
  (two dates), or Weekly (four dates) for the current calendar month. Each selected
  payday after the first starts another budget section; the first section starts
  on the 1st and the last ends at month end. Default Bi-Weekly sections are days
  1–14 and 15–month end until dates are configured. This is a manual monthly
  schedule, not an automatically recurring 14-day/7-day payroll engine.
  The selected type carries forward to new months; dates are chosen each month.
- The Budget tab edits each section separately. Home's compact summary shows
  monthly remaining totals, while its larger cards show the current pay period.
  All sections combine into one monthly Trends/history/chart result. Transactions use their selected dates, and
  monthly totals count them once. Reducing section count merges manual amounts
  rather than dropping them. Legacy monthly values migrate into the first section.
- Existing `MyBudget.*` UserDefaults records are migrated only after a successful
  local-file write; only those app-owned legacy keys are then removed. This does
  not erase preexisting device backups.
- `PrivacyInfo.xcprivacy`: declares no tracking/collected data for this source and
  CA92.1 for access to this app's own legacy UserDefaults during migration.
- `PRIVACY-POLICY-DRAFT.md`: editable policy text. Fill in the app name, date, and
  contact information, then host the finished policy at a publicly accessible URL.

## Add to Xcode

1. Replace the existing ContentView.swift contents with this version.
2. Add PrivacyInfo.xcprivacy to the app target. If a manifest already exists,
   merge these entries instead of adding a conflicting duplicate. Check target
   membership and that the manifest is included in the built app.
3. Do not add analytics/ad SDKs, iCloud/CloudKit, remote push registration, remote
   web content, or network-based support inside the app without reassessing this
   privacy design. Check Package Dependencies and Signing & Capabilities in the
   actual project; they were not available for this source-only audit.
4. Local notifications can support offline reminders. Remote push notifications
   require network services and do not fit a strict no-network design.

## Verify on your Mac and iPhone

This cloud workspace cannot compile the iOS app or verify device behavior.

Optional chart accounting checks can be run on your Mac from this folder with
`sh Verification/check-chart.sh`. The script extracts the actual app models and
checks budget classification, exact cents, logged spending, missing data, and
calendar-year alignment. Do not add the Verification folder to the app target.
Its Swift checks were not executed in the cloud workspace because Swift is not
installed there. These checks do not validate SwiftUI chart rendering.

- Build and run on a real iPhone and in the simulator. Exercise all tabs, savings,
  transaction add/edit/delete, historical dates, restart, and month rollover.
- Test migration using an installation of the previous version with sample data.
  Update in place; do not uninstall it first. Check all records remain present.
- Set one, two, and four pay dates; confirm matching budget sections and date
  boundaries, including February and the last day of a month. Check that schedule
  changes preserve monthly totals and that the annual plot still has one point
  per month. Make sure unlogged amounts do not duplicate logged transactions.
- Test PIN setup, change, disable, failed-attempt delay, relaunch, and leaving the
  app with an editing sheet open. Verify app-switcher concealment on the device.
- With sample data, test Cancel and Confirm on both reset routes. Check erased
  records do not return after relaunch. Test storage failures where practical.
- Inspect Application Support/MyBudget file protection and backup-exclusion
  attributes, including after edits and reset. Verify app-owned legacy defaults
  have been removed after successful migration.
- Test in Airplane Mode. This verifies offline functionality, not absence of all
  network activity. Separately enable iPhone App Privacy Report and inspect app
  network activity while exercising the app; use appropriate network tracing
  (for example Instruments) for a release-build check.
- Audit the final archive's bundled frameworks, privacy manifests, entitlements,
  and release settings. Validate the archive in Xcode before uploading it.

## App Store Connect

If the final app and every embedded SDK match the audited offline design, its
App Privacy answer can be **Data Not Collected**. On-device-only processing does
not by itself count as collecting data under Apple's App Privacy definition.
The label is a declaration, not a technical network block or certification.

Provide the finished privacy policy's public URL and the normal support URL,
screenshots, description, age rating, and other required listing information.
Distribution requires an Apple Developer Program membership and a signed archive.
Review the latest App Store Connect questions during submission.

## Limits of the claim

Use: **“The app does not transmit your budget data and requires no account or
internet connection for its budgeting features.”**

Avoid an absolute promise that no information can ever leave a phone. The app
does not control Apple system diagnostics, existing backups, screenshots, user
actions, or other operating-system services. iOS has no general app entitlement
that acts as a deny-all network firewall; App Transport Security is not one.

Backup exclusion requests that iOS omit these app files; it is not proof about
every backup already made or all OS-managed behavior. User-visible deletion is
logical deletion, not a claim of forensic secure erasure.

## Apple references

- https://developer.apple.com/app-store/app-privacy-details/
- https://developer.apple.com/documentation/foundation/urlresourcevalues/isexcludedfrombackup
- https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api
- https://developer.apple.com/documentation/bundleresources/privacy-manifest-files

These are reference links. Live Apple documentation could not be retrieved from
the cloud workspace because its network policy blocked developer.apple.com.
Check current requirements in Xcode and App Store Connect before submission.
