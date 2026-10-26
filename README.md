# Budget App — offline iPhone source

SwiftUI source for a personal budget app. This repository contains the app source
and supporting privacy/verification files, not a complete `.xcodeproj` or an
App Store release. No real financial records, passcodes, or signing credentials
are included.

## Features

- Read-only Home with time-of-day greeting, a compact monthly-remaining summary,
  larger current-pay-period breakdowns, and cumulative savings.
- Monthly, Bi-Weekly, or Weekly pay schedules with one, two, or four selected
  calendar dates for the current month.
- Matching editable budget sections for Payroll, Extra, savings deposits and
  withdrawals, and the ten predefined expense categories.
- Self-reported transactions with category, date, amount, note, editing, and deletion.
- One combined monthly result for Home's compact summary and the Trends tab.
- Orange current-year and purple previous-year chart lines with green/red monthly
  points for expense budget met/exceeded, in Trends → History & Trends alongside
  read-only monthly history (including the current month in progress).
- Optional four-digit local screen lock and confirmed destructive reset.
- App-local, backup-excluded storage; no Keychain, server, analytics, or app network calls.

## Open in Xcode

Requires Xcode 15 or later and an **iOS App / SwiftUI** target with iOS 16 or later.

1. Open your existing iPhone project, or create one using File → New → Project →
   iOS → App, with SwiftUI and Swift selected.
2. Replace the entire contents of its `ContentView.swift` with this repository's
   file. Keep the app's existing `@main` entry point that displays `ContentView()`.
3. Add `PrivacyInfo.xcprivacy` to the app target. Merge it with an existing manifest
   rather than creating conflicting duplicates.
4. Choose an iPhone simulator or connected iPhone, then press Command-R.
5. Keep `Verification/` out of the app target. Its Swift file is a command-line
   test harness with top-level executable checks, not application source.

Your local app icons, signing settings, bundle identifier, and Xcode project are
not part of these source files. Configure those in Xcode.

## Pay dates and budget sections

In the app, open Settings → Pay schedule. Choose a type, select exactly the
required number of distinct dates on the calendar, and tap Save.

| Type | Selected pay dates | Budget sections |
| --- | --- | --- |
| Monthly | 1 | 1 |
| Bi-Weekly | 2 | 2 |
| Weekly | 4 | 4 |

These are manually selected dates for each calendar month, not an automatic
recurring payroll engine. Some real weekly/14-day schedules have additional
paydays in a month; this version uses the requested fixed selection counts.
The selected type is reused for new months; calendar dates are selected anew.

The first section starts on the 1st, each later selected payday starts another
section, and the last section ends at month end. Days before the first payday
belong to the first section so every calendar day is covered exactly once.

For example, Bi-Weekly dates on the 1st and 15th produce **1–14** and
**15–month end**. Weekly dates on the 1st, 8th, 15th, and 22nd produce four sections.
Until configured, the default is the two-section 1–14 / 15–month end split.

Income, manual expenses, and savings are entered separately in each section.
Transactions are allocated by their dates. The large Home cards automatically
show the current date's budget section. Monthly summaries add every section
and count each transaction once. Changing date boundaries retains manual values
in section order. Adding sections starts them blank; reducing sections merges
removed values into the last retained section, preserving monthly totals. Older
monthly-only records migrate into the first section with additional sections blank.

## Graph calculation

Each monthly point is **total budgeted expenses minus total Realistic expenses**,
including reported transactions from all budget sections. At or above zero is
green; below zero is red. Income and savings are excluded from this comparison.
The current month is in progress. Missing/invalid months are blank and break the
lines; no prior-year results are fabricated.

## Data and privacy

Financial records, pay schedules, local recovery copies, and lock information use
the app's Application Support/MyBudget directory with backup exclusion and iOS
file protection. Existing app-owned defaults are migrated after a successful write.
The passcode is a screen lock, not separate database encryption. Reset requires
an explicit destructive confirmation. The app cannot delete existing external
backups or control Apple's system diagnostics and device services.

See `APP-STORE-PRIVACY.md` for the submission checklist and
`PRIVACY-POLICY-DRAFT.md` for policy text to complete before publishing.

## Verification status

The Swift source has been reviewed, the privacy manifest parsed, and the
verification shell script syntax checked. **The iOS app and Swift checks have not
been compiled/run in the Linux cloud workspace.** Build and test in Xcode before
publishing; this is not an App Store readiness certification.

On a Mac with Swift command-line tools, run:

```sh
sh Verification/check-chart.sh
```

The script tests the actual Foundation-only models for budget arithmetic,
calendar-year comparisons, section boundaries, schedule changes, and old-data
migration. UI rendering, device storage, app locking, and network activity require
separate iPhone/Xcode checks.

## Performance review

Chart points, monthly summaries, and transaction ordering are reused within each
render. Summary fields are parsed once for both totals and validation; category
transaction totals are grouped in one pass. Passcode countdowns use a finite
schedule that ends at expiry instead of refreshing idle forms every second.
Unchanged preferences cause no write, related lock metadata saves together, and
existing directory setup is reused while backup exclusion is still verified.

Budget edits still save immediately and atomically. The app still serializes the
full ledger on each edit, so typing with a large history can remain a bottleneck.
No CPU reduction or latency improvement has been measured in this workspace.

On an iPhone, use Xcode's **Product → Profile → Time Profiler** to compare typing
in Budget, scrolling Transactions, opening Trends, and leaving passcode settings
idle. Use the same representative sample records for each comparison. Also check
that edits survive an immediate relaunch, five incorrect passcodes trigger the
30-second cooldown across relaunches, and confirmed reset clears records before
removing the lock. Run the model checks above before using the updated source.
