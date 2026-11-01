# Local Excel export

The app creates a genuine Microsoft Excel `.xlsx` workbook on the iPhone.
It uses no API, server, Microsoft sign-in, OpenAI connection, third-party package,
or hosting service. Creating the workbook adds no service fee. The application
you choose to open or store the file may have its own account or license terms.

## Install the updated source

This is a source package, not a complete Xcode project. Replace `ContentView.swift`
and add **both** `ExcelExport.swift` and `ExcelExportUI.swift` to the same iOS app
target. When dragging them into Xcode, select the app under **Add to targets**.
Keep the existing `@main` app entry point. Do not add `Verification/` to the target.
Requires the existing iOS 16+/Xcode 15+ SwiftUI setup.

### Resolving Xcode import and missing-type errors

`ExcelExportUI.swift` must explicitly import `Combine` for `@Published` and
`ObservableObject`, even when another source file imports that module.

If Xcode cannot find `MonthlyBudget`, `LocalPreferences`, `BudgetStore`, or
`AppLockStore`, confirm that the complete `ContentView.swift` is installed. All
four types are defined there at module scope; replacing only the `ContentView`
view declaration does not install the models. Then select each of the three
app Swift files, open the File Inspector with **Option-Command-1**, and check the
same app under **Target Membership**. Choose **Product → Clean Build Folder**
(Shift-Command-K), then **Command-B**. Remaining diagnostics may be cascading;
resolve the first fresh build error before changing other declarations.

## Use on the iPhone

1. Set an app passcode in Settings if none is enabled.
2. Open **Settings → Export to Excel**.
3. Select the months to include. Only the current month is selected initially.
4. Optionally include transaction notes; they are excluded by default.
5. Enter the existing four-digit app passcode and tap **Create Excel export**.
6. Use **Save to Files**, or another destination offered by iOS. To keep the saved
   copy on the phone, choose **On My iPhone**. An iCloud Drive, OneDrive, email, or
   other cloud-backed destination can send the copy outside the phone.
7. Open the saved `.xlsx` file in Microsoft Excel or another compatible spreadsheet
   app. Workbook edits do not update records in the budget app.

Every export requires fresh passcode entry. Wrong attempts use the existing
persisted five-attempt/30-second retry delay. The passcode is not included in the
workbook and does not password-encrypt the exported copy.

## Workbook sheets

| Sheet | Contents |
| --- | --- |
| Read Me | Scope, creation time, currency, calculations, and limitations |
| Monthly Summary | Budgeted/Realistic income, spending, savings, remaining, and spending variance |
| Pay Periods | Payroll, Extra, income, expenses, savings deposits/withdrawals, and remaining for each section |
| Categories | Manual and logged amounts by category, plan, month, and pay period |
| Transactions | Recorded date, month, pay period, category, amount, and optional notes |

All amounts use the app's USD convention. Monetary values are numeric cells with
two decimal places; text uses literal string cells rather than executable formulas.
Blank manual fields remain blank in detail sheets; explicitly entered zero stays
numeric zero. Computed totals treat blanks as zero, matching the app.

Realistic expenses equal unlogged manual spending plus reported transactions,
counted once. Other sheets are breakdowns of those totals, not additional spending.
Savings change describes each selected row's period, not an all-time bank balance.
Budgeted categories are plans; this app does not infer bill due dates or recurring
payment schedules. Current-month results are in progress.

Invalid inputs, duplicate months/transaction IDs, incomplete schedules, sub-cent
transactions, amounts exceeding Excel's cent-preserving precision, or oversized
reports block export instead of silently changing amounts. Select fewer months
if a workbook exceeds the 32 MB report limit. Excel itself uses limited numeric
precision; the source app continues calculating with `Decimal`.

## History and file lifecycle

**Settings → Export history** records timestamps, chosen months, transaction counts,
note inclusion, format, and outcome. It contains no financial amounts, note text,
security codes, or export payloads. It is local history, not a tamper-proof audit.

History is saved successfully before a file is offered for sharing. A failed
security/history write blocks file release. Workbook generation runs off the main
thread using a snapshot of value models and does not modify the saved ledger.

The root view owns sharing, so the existing automatic lock can remove budget
screens without discarding an authorized file transfer. Temporary files remain
protected and backup-excluded through the activity callback. Cancellation before
handoff invalidates that request. A completed iOS activity is labeled **Handoff
reported by iOS**; it does not prove Excel opened the file or that a cloud service
stored it successfully. A process interruption leaves an unconfirmed history entry.

Temporary files are cleaned after activity completion/cancellation and abandoned
files are cleaned on next launch. An iOS complete-protection file can become
unavailable when the device locks; the app does not weaken protection to complete
a transfer. The privacy curtain and sharing transitions require real-device tests.

Confirmed reset cancels pending work, removes local temporary exports and history,
and clears app records before deleting the passcode. Old callbacks cannot recreate
erased history. Reset cannot remove a workbook saved or shared outside the app.

## Privacy and costs

The budget database remains local. This feature does not connect to ChatGPT and
does not require hosting, a domain, an API key, an API subscription, or an app-side
Microsoft account. The user chooses when and where an external copy is created.
Cloud-backed destinations operate under their own privacy and retention policies.

The workbook is not password-encrypted. The local passcode gates export access;
after saving, the destination's protection applies. Never commit actual workbooks,
financial records, passcodes, signing credentials, or other secrets to this repo.

## Verification

On a Mac with Swift command-line tools and Python 3, run:

```sh
sh Verification/check-chart.sh
sh Verification/check-excel-export.sh
```

The export harness uses synthetic records and independently inspects the generated
ZIP/XML package with Python. It checks exact totals, selected scope, blanks/zero,
literal formula-like notes, omitted IDs/secrets, invalid inputs, and ledger immutability.
Temporary synthetic workbooks are removed by the harness; no real data is required.

Swift/iOS tooling is unavailable in this Linux workspace. The new app source and
Swift-generated workbooks have **not been compiled or executed here**. Shell/Python
syntax and repository checks do not replace the Mac harness or an Xcode build.

Before using real records, exercise save/open in Excel, wrong codes and relaunch,
note toggles, cancellation, backgrounding during generation and sharing, device
lock, app-switcher snapshots, history persistence, and reset with synthetic data.
Verify no preparation or cancelled request can share later without another code.
