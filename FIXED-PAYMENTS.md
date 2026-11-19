# Fixed payments: manual planning and payment recording

In **Savings & Payoffs**, use **+ Fixed payment** for a loan, car payment, lease,
insurance policy or another monthly obligation. Enter its suggested amount,
expense category, due day, starting month and optional final month. Enable its
reminders when you want it displayed on Home and beside that category in Budget.
A due day beyond month end uses the month's last day.

## Both Budgeted and Realistic are manual

Enabling a reminder, reaching a due date, or opening a forecast does not add an
expense amount. In Budget, the notice sits beside its matching expense category.
Each fixed payment has its own controls, even when several share one category.

- For **Budgeted**, choose the suggested amount or enter a custom plan amount and
  explicitly save it. Change or clear that payment's planned amount there later.
  Planning does not record spending or reduce a payoff balance.
- For **Realistic**, use **Apply payment**, confirm the amount actually paid,
  payment date and statement interest when applicable. Saving records one reported
  expense and one payment-tracker entry together. Spending belongs to the pay
  period containing the payment date, which may differ from the due-date period.

The normal category input is for additional unlogged expenses. Keep the same
payment out of that manual amount and out of a second reported transaction.
**Do not report an applied payment again in Transactions.**

A monthly recorded amount can be corrected using its payment controls; updating
it replaces that month's linked payment instead of adding another expense. This
flow keeps one dated entry per fixed payment per month, rather than itemizing
separate installments. The chosen date controls the whole entry's pay-period
placement. Applying actual spending is limited to the current month and dates
that have already occurred; future months contain Budgeted plans only.

Existing planned amounts from the earlier automatic version are retained rather
than silently erased. They can be changed or cleared explicitly. Editing a
suggested amount, hiding a reminder, changing its due day or completing a payoff
does not rewrite saved manual plans. Copying a plan to a fresh forecast is an
explicit action and copies eligible planned fixed payments once. Existing entered
forecasts are not overwritten. Historical snapshots keep their recorded amounts.

## Payment history and corrections

The payment tracker shows recorded amounts for loans and for recurring payments
without a payoff balance. Insurance/lease records do not invent a principal or
remaining debt balance. Actual-payment records are linked to their reported
expenses, so Transactions directs corrections to the fixed-payment controls
instead of letting one side of the record change independently.

Only current-month linked entries can be corrected here. For a tracked payoff,
the entry must still be the latest tracker record and its balance must be
unchanged. A later record or a balance reconciled against a statement can prevent
automatic reversal. An undo restores the recorded principal and removes linked
spending together; it is not a bank refund. Older linked history is read only.

Older entries marked as tracker-only stay tracker-only. The app never generates
spending from old history, since that spending may already have been reported.

## Optional payoff and interest

Enter a current statement balance and an APR or APY from 0% to 100%, with up to
four decimal places. Use 0 for an interest-free payoff. APR is divided into twelve
monthly rates; APY uses its equivalent monthly compounded rate. Interest rounds
to cents before principal is reduced. The live estimate shows payments remaining,
remaining interest and a smaller final payment where appropriate. An insufficient
or interest-only monthly plan has no finite payoff estimate. Calculations beyond
1,200 monthly payments are marked as beyond the estimate limit.

When recording actual payments, confirm **Interest included** against the lender's
statement; enter 0 for a principal-only payment. For a correction, use the total
interest included in that month's corrected total payment. An amount exceeding
the payoff balance plus the entered interest must be corrected before recording;
actual spending is never silently reduced to a different amount. Daily interest,
fees and lender terms can change actual payoff figures. No lender is connected.

## Privacy, reports and compatibility

All definitions, manual plans and payment links stay inside the encrypted ledger.
There is no new backend endpoint, bank connection or Azure resource. Limits remain
200 fixed payments, 1,000 total payment-history entries and the existing one-MiB
ledger limit. Category-removal safeguards remain: unapply or reassign reminders
before removing a category used by them; existing recorded money stays retained.

Excel includes manual plans and applied actual spending exactly once in category,
pay-period and monthly totals. The payoff history is not a separate workbook
sheet. Update other open browser tabs after this release: older versions reject
unsupported fields instead of silently dropping them. Native integration remains
a separate paused release.
