# Custom expense categories

On the website, open **Budget → Manage expenses** to add an expense name, remove
an unused category, or restore a removed one. For example, remove **Home** when
you do not need a housing payment, or add **Childcare** or **Pet care**.

Changes apply to the current month and saved future budgets. Past months keep
their own category lists: a newly added category does not appear retroactively,
and removing one does not erase its historical entries. Forecast previews and
new months use the active category list. Removing is reversible; definitions
remain available to restore. Names must be unique regardless of capitalization.

## Existing money is retained

Removing a category hides its editable fields. Any nonzero amounts already saved
in this month or a saved future plan remain visible under **Previously recorded**
and continue to count in totals. Reported transactions are retained too. Clear a
planned amount before removing its category if that cost is no longer expected.
Restore the category to edit a retained manual amount later.

Copying the current plan to a fresh forecast does not carry removed categories
forward. A forecast that already contains entered amounts still cannot be
overwritten by copying. Historical charts and monthly totals include every
recorded amount, including amounts for categories that are now removed.

## Transactions and fixed payments

New reported expenses use the category list belonging to the transaction's month.
Existing transactions in removed categories can still be viewed and edited.
Changing a transaction's date uses the destination month's available categories.

Fixed payments can use custom categories as well as the defaults. Before removing
a category used by an applied fixed payment, unapply that payment or move it to
another category in **Savings & Payoffs**. Removing a category never silently
deletes a loan, payoff balance, or payment history.

## Reports, storage, and compatibility

Excel exports use each month's categories and retain recorded amounts for removed
ones. Monthly totals remain complete; blank entries in a removed category do not
become new expense records. Category names are literal text, never formulas.

The calendar-year workbook aligns month blocks side by side. Inapplicable
category labels and values are blank in each block; blank alignment rows may
remain because Excel cannot hide a row for only one month block.

Category settings and monthly snapshots stay inside the existing encrypted budget
document. This feature adds no backend endpoint, bank connection, or extra Azure
resource. Existing ledgers keep their previous shape until category settings are
changed. Older browser versions reject unsupported fields rather than discard
them; refresh other open tabs after the update. The limit is 100 categories,
including removed ones, within the existing total ledger-size limit.
