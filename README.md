# Budget App — offline iPhone source

SwiftUI source for a personal budget app. This repository contains the app source
and supporting privacy/verification files, not a complete `.xcodeproj` or an
App Store release. No real financial records, passcodes, or signing credentials
are included.

## Features

- Read-only Home with time-of-day greeting, compact savings-bucket progress,
  current-pay-period breakdowns, and cumulative savings.
- A compact Home warning listing expense categories that have used at least 70%
  of their own current-pay-period budgets, with the amount left for each category.
- Monthly, Bi-Weekly, or Weekly pay schedules with one, two, or four selected
  calendar dates for the current month.
- Matching editable budget sections for Payroll, Extra, savings deposits and
  withdrawals, and the ten predefined expense categories.
- Self-reported transactions with category, date, amount, note, editing, and deletion.
- Combined monthly results in Trends and Excel reports.
- Savings goals with active-only contribution fields and a withdrawal popup that
  selects general Set aside or a specific bucket.
- Orange current-year and purple previous-year chart lines with green/red monthly
  points for expense budget met/exceeded, in Trends → History & Trends alongside
  read-only monthly history (including the current month in progress).
- Optional four-digit local screen lock and confirmed destructive reset.
- Local Excel `.xlsx` exports with selected months, optional notes, fresh passcode
  verification, and metadata-only export history in Settings.
- Template-style annual Excel sheets with side-by-side Projected/Actual pay-period
  blocks, plus the existing monthly, category, and transaction detail sheets.
- App-local, backup-excluded storage; no Keychain, server, analytics, or automatic uploads.

## Open in Xcode

Requires Xcode 15 or later and an **iOS App / SwiftUI** target with iOS 16 or later.

1. Open your existing iPhone project, or create one using File → New → Project →
   iOS → App, with SwiftUI and Swift selected.
2. Replace the entire contents of its `ContentView.swift` with this repository's
   file. Keep the app's existing `@main` entry point that displays `ContentView()`.
   Add `ExcelExport.swift`, `ExcelExportUI.swift`, and `SavingsBucketsUI.swift`
   to the same iOS app target.
3. Add `PrivacyInfo.xcprivacy` to the app target. Merge it with an existing manifest
   rather than creating conflicting duplicates.
4. Choose an iPhone simulator or connected iPhone, then press Command-R.
5. Keep `Verification/` out of the app target. Its Swift files are command-line
   test harnesses with top-level executable checks, not application source.

Your local app icons, signing settings, bundle identifier, and Xcode project are
not part of these source files. Configure those in Xcode.

## Export to Excel

Open **Settings → Export to Excel**, choose months, enter your app passcode, and
save the workbook through iOS. Use **On My iPhone** in Files to keep the saved copy
local. Notes are excluded by default. **Settings → Export history** records attempts
and iOS handoffs without storing a second financial payload.

See [Excel export instructions](EXCEL-EXPORT.md) for workbook sheets, security,
verification, and limits. No ChatGPT/API connection, hosting, or Microsoft sign-in
is needed. A destination you select may upload its copy; exports are not encrypted
with your app passcode, and reset cannot delete copies outside the app.

The annual sheets follow the supplied CY26 Data layout: merged date headings,
pale-yellow headers, three-column pay-period blocks, and signed cash outflows.
They are generated from app records; the private reference workbook is not included.
Savings withdrawals replace its automatic carryover line so totals retain the
app's meaning. The export instructions explain the matched and adapted features.

## Savings buckets

Create goals in **Settings → Savings buckets**. Home shows each active goal's
name and saved/target amounts in place of monthly remaining. Realistic contributions
update progress across months; Budgeted entries are plans. Bucket contributions
are additional to general Set aside and reduce remaining money once.

**Budget → Pull from savings** opens a popup to choose Set aside or a named bucket
and update that source's total withdrawal for the selected pay period. Realistic
bucket withdrawals lower its progress; general withdrawals leave bucket balances
unchanged. See [savings-bucket instructions](SAVINGS-BUCKETS.md) for examples,
archiving, accounting, and export scope.

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

Home's warning compares each category's current-period manual Realistic spending
plus its logged transactions against that category's Budgeted amount. It shows
only the title and qualifying lines such as **Electric budget left: $30.00**.
At 70% spent (30% left), that category appears; fully used or exceeded categories
show red amounts, with negative remaining amounts indicating overspending. The
banner turns red when any listed category reaches or exceeds its limit. It can
warn about one category even while the overall period is under budget.
Income, savings, other pay periods, and other months do not affect the comparison.
An untouched or invalid category is skipped; valid warnings for other categories
still appear. An explicitly entered zero budget with positive spending qualifies.
The banner adds no timer, notification service, or network call and changes no records.

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
Export history and temporary workbooks also use protected, backup-excluded local
storage. A saved or shared workbook is a separate copy under its destination's control.

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
sh Verification/check-excel-export.sh
```

The script tests the actual Foundation-only models for budget arithmetic,
calendar-year comparisons, section boundaries, schedule changes, and old-data
migration. UI rendering, device storage, app locking, and network activity require
separate iPhone/Xcode checks.
The same model harness includes savings-bucket arithmetic, migration, progress,
and withdrawal checks using synthetic records.
The Excel harness also requires Python 3 to independently inspect synthetic `.xlsx`
packages. The app and Swift-generated workbooks have not been run in this workspace.

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
