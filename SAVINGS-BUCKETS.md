# Savings buckets

Savings buckets track goals such as a car, a trip, or a large household purchase.
They work locally with the existing app lock and protected, backup-excluded storage.
No account, bank connection, or server is added.

## Add to Xcode

Replace the existing app source with the current versions of `ContentView.swift`,
`ExcelExport.swift`, and `ExcelExportUI.swift`. Add the new **SavingsBucketsUI.swift**
to the same iOS app target. Keep every file in `Verification/` out of that target.
The existing GitHub Mac workflow type-checks all four app source files.

## Create and fund a bucket

1. Open **Settings → Savings buckets** and tap **+**.
2. Enter a unique name and positive target amount, leave **Active** on, and save.
3. In **Budget**, choose a pay period. An additional contribution field appears
   for each active bucket under both Realistic and Budgeted savings.
4. Enter what you plan to save under Budgeted and what you actually set aside
   under Realistic. Only Realistic entries update saved progress.

Buckets start at zero. Home replaces its monthly-remaining section with a compact
read-only row per active bucket: **name — amount saved / target amount**. Saved
progress is the sum of that bucket's Realistic contributions minus its Realistic
withdrawals across all recorded months. Targets do not cap balances or automatically
archive a bucket. Total Savings includes general savings and bucket funds together.

Bucket contributions are **additional to Set aside**. For example, $50 of general
savings and a $100 bucket contribution deduct $150 from that pay period's remaining
amount, once. They are savings allocations, not expenses, so they do not change
the expense-only graph or category warning thresholds.

## Pull from savings

In a Budget card, tap **Pull from savings** to open the location popup. Choose:

- **Set aside (general)** for the existing general savings account.
- A named bucket, including inactive buckets whose recorded funds/history remain.

Enter the **total pulled from that location for the selected pay period**, then
save. Each location has its own total; editing it replaces that total rather than
adding a new transaction. Clear a location's amount to remove its withdrawal for
that period. To correct a previously chosen location, clear the old location and
enter the amount under the correct one.

Under Realistic, a bucket withdrawal reduces that bucket's saved progress and
increases the pay period's available money by the same amount. A Set aside
withdrawal affects general savings only. Budgeted withdrawals are plans and do
not change actual saved progress. Purchases are still reported separately as
expenses; withdrawing money is not a second purchase or additional earned income.

For example, a bucket with $100 of Realistic contributions and a $40 withdrawal
shows $60 saved. The withdrawal makes $40 available in that period's budget.
Recording the corresponding $40 expense then uses that money. Saved balances
are reported records, not verified bank balances. If withdrawals exceed recorded
bucket contributions, the negative balance is shown in red rather than hidden.

Existing recorded general savings can be allocated to a bucket without creating
new money: record a Set aside withdrawal and an equal bucket contribution in the
same period. This leaves total savings and remaining money unchanged while moving
the recorded allocation to that goal.

## Edit or archive

Tap a bucket in Settings to edit its name, target, or Active switch. Swipe to
archive/reactivate. Archiving hides the Home preview and contribution inputs; it
does not erase savings, imply that money was spent, or remove historical records.
Recorded inactive contributions remain visible as read-only budget information.
The location popup still permits withdrawals from inactive buckets.

Changing a name or target does not change recorded money. Stable bucket identifiers
link records across months, while entry-name snapshots remain available for history.
Erasing all app data removes the buckets and their local records along with budgets,
passcode, and export history. External copies of Excel reports cannot be recalled.

## Accounting and compatibility

The budget's remaining amount is:

```text
Income + general withdrawals + bucket withdrawals
       - expenses - Set aside - bucket contributions
```

Older budgets decode missing bucket-entry arrays as empty arrays, preserving their
original totals. Reducing pay-period count merges contributions and withdrawals
by bucket ID without dropping funds. Adding periods starts their entries blank.
The ledger and bucket definitions are committed together to the same protected
settings file. Unreadable or inconsistent saved records block normal use rather
than silently replacing funded goals with empty balances.

## Excel reports

Existing monthly, pay-period, and CY savings totals include general and bucket
funding exactly once. When selected records contain bucket entries, an additional
last **Savings Buckets** sheet lists the selected period, Budgeted/Realistic plan,
historical bucket name, contribution, withdrawal, and net contribution.

The export remains limited to selected months. It omits internal bucket IDs,
global goal targets, and all-time progress that could reveal unselected records.
Blank and entered-zero funding amounts remain distinct. Reports with no selected
bucket entries retain the existing sheet list. Notes remain separately opt-in.

## Verification

Run `sh Verification/check-chart.sh` and `sh Verification/check-excel-export.sh`
on a Mac, or inspect the existing GitHub Actions Mac run. Synthetic checks cover
additional deductions, general/bucket withdrawal separation, Realistic-only
progress, migration, archive/rename, schedule changes, invalid entries, expense
graph independence, and Excel reconciliation. No real financial records are used.

Type-checking does not replace device interaction tests. Before release, exercise
goal creation/editing, source selection, correcting period totals, inactive buckets,
month rollover with an open popup, automatic lock, relaunch, and confirmed reset
using sample records. The Home screen remains read-only.
