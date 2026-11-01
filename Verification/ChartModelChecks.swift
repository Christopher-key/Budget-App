// Mac command-line check only; do not add to app target.
// This file is appended to the actual Foundation-only models by check-chart.sh.
// It is not an app target source file and should not be added to the Xcode app.

var completedChartChecks = 0

func checkChart(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else { fatalError("FAIL: \(message)") }
    completedChartChecks += 1
    print("PASS: \(message)")
}

func expectedDecimal(_ text: String) -> Decimal {
    guard let value = Decimal(string: text, locale: Locale(identifier: "en_US_POSIX")) else {
        fatalError("Invalid numeric test fixture: \(text)")
    }
    return value
}

func chartInput(_ text: String) -> String {
    // Keep fixture digits ASCII, matching the input parser, while respecting
    // the current locale's decimal separator without grouping separators.
    _ = expectedDecimal(text)
    return text.replacingOccurrences(of: ".", with: Locale.current.decimalSeparator ?? ".")
}

func chartFixture(
    id: String,
    budget: String? = nil,
    actual: String? = nil,
    transactionAmounts: [String] = []
) -> MonthlyBudget {
    // The chart deliberately uses the persisted Gregorian month ID, not the
    // display date, to avoid device timezone/calendar changes moving a point.
    var record = MonthlyBudget(id: id, date: Date(timeIntervalSince1970: 0))
    if let budget = budget {
        record.periods[0].budgeted.expenses[0].amount = chartInput(budget)
    }
    if let actual = actual {
        record.periods[0].realistic.expenses[0].amount = chartInput(actual)
    }
    record.transactions = transactionAmounts.map { amount in
        var transaction = ReportedExpense()
        transaction.category = "Grocery"
        transaction.amount = expectedDecimal(amount)
        return transaction
    }
    return record
}

func chartPoints(_ records: [MonthlyBudget], current: String = "2026-10") -> [AnnualBudgetPoint] {
    AnnualBudgetComparison.points(months: records, currentMonthID: current)
}

// Classification at, below, and above the spending limit.
let onBudget = chartPoints([chartFixture(id: "2026-01", budget: "100", actual: "100")])
checkChart(onBudget.count == 1, "An explicitly entered on-budget month is plotted")
checkChart(onBudget.first?.variance == Decimal.zero && onBudget.first?.metBudget == true,
           "Exactly on budget is green with zero variance")

let underBudget = chartPoints([chartFixture(id: "2026-02", budget: "100", actual: "75")])
checkChart(underBudget.first?.variance == expectedDecimal("25") && underBudget.first?.metBudget == true,
           "Spending below budget is green and above zero")

let overBudget = chartPoints([chartFixture(id: "2026-03", budget: "100", actual: "125")])
checkChart(overBudget.first?.variance == expectedDecimal("-25") && overBudget.first?.metBudget == false,
           "Spending above budget is red and below zero")

// Decimal arithmetic and automatic transaction contributions.
let exactCents = chartPoints([
    chartFixture(id: "2026-04", budget: "0.30", actual: "0.10", transactionAmounts: ["0.20"])
])
checkChart(exactCents.first?.variance == Decimal.zero && exactCents.first?.metBudget == true,
           "Ten cents plus twenty cents is exactly thirty cents")

let combined = chartPoints([
    chartFixture(id: "2026-05", budget: "200", actual: "100", transactionAmounts: ["35", "15"])
])
checkChart(combined.first?.realisticExpenses == expectedDecimal("150"),
           "Reported transactions add to manual Realistic expenses once")
checkChart(combined.first?.budgetedExpenses == expectedDecimal("200")
           && combined.first?.variance == expectedDecimal("50"),
           "Reported transactions leave the budgeted limit unchanged")

// Missing information must not manufacture a successful month.
checkChart(chartPoints([chartFixture(id: "2026-06")]).isEmpty,
           "An untouched month has no point")
checkChart(chartPoints([chartFixture(id: "2026-06", actual: "10")]).isEmpty,
           "Actual spending without any entered budget has no point")
checkChart(chartPoints([chartFixture(id: "2026-06", budget: "100")]).isEmpty,
           "A budget without entered actual spending has no point")

let explicitZero = chartPoints([chartFixture(id: "2026-06", budget: "0", actual: "0")])
checkChart(explicitZero.count == 1 && explicitZero.first?.metBudget == true,
           "Explicit zero budget and zero spending count as on budget")
let zeroBudgetExceeded = chartPoints([chartFixture(id: "2026-06", budget: "0", actual: "1")])
checkChart(zeroBudgetExceeded.first?.metBudget == false,
           "Spending against an explicit zero budget is over budget")
checkChart(chartPoints([
    chartFixture(id: "2026-06", budget: "100", transactionAmounts: ["20"])
]).first?.realisticExpenses == expectedDecimal("20"),
           "Transactions alone establish actual spending without a manual entry")

var invalidBudget = chartFixture(id: "2026-07", budget: "100", actual: "50")
invalidBudget.periods[0].budgeted.expenses[1].amount = "not a number"
checkChart(chartPoints([invalidBudget]).isEmpty, "Invalid budgeted expense input skips the point")
var invalidActual = chartFixture(id: "2026-07", budget: "100", actual: "50")
invalidActual.periods[0].realistic.expenses[1].amount = "not a number"
checkChart(chartPoints([invalidActual]).isEmpty, "Invalid actual expense input skips the point")

var unrelatedInvalid = chartFixture(id: "2026-07", budget: "100", actual: "50")
unrelatedInvalid.periods[0].realistic.payroll = "not a number"
unrelatedInvalid.periods[0].realistic.savings = "not a number"
unrelatedInvalid.periods[0].budgeted.extra = "not a number"
unrelatedInvalid.periods[0].budgeted.savingsWithdrawn = "not a number"
checkChart(chartPoints([unrelatedInvalid]).first?.variance == expectedDecimal("50"),
           "Income and savings inputs do not change the expense-only chart")

// Calendar-year alignment includes all prior-year data, not just year to date.
let calendarPoints = chartPoints([
    chartFixture(id: "2025-12", budget: "100", actual: "90"),
    chartFixture(id: "2026-10", budget: "100", actual: "90"),
    chartFixture(id: "2026-11", budget: "100", actual: "90"),
    chartFixture(id: "2024-12", budget: "100", actual: "90"),
    chartFixture(id: "2027-01", budget: "100", actual: "90")
])
checkChart(calendarPoints.map(\.id) == ["2025-12", "2026-10"],
           "Prior December and current month are included; future and unrelated years are excluded")
checkChart(chartPoints([chartFixture(id: "invalid", budget: "1", actual: "1")]).isEmpty,
           "Malformed record month identifiers do not make points")
checkChart(chartPoints([chartFixture(id: "2026-01", budget: "1", actual: "1")], current: "invalid").isEmpty,
           "An invalid current-month identifier produces an empty comparison")

// Lines may connect consecutive months, but must not cross missing-month gaps.
let gapPoints = chartPoints([
    chartFixture(id: "2026-05", budget: "100", actual: "90"),
    chartFixture(id: "2026-01", budget: "100", actual: "90"),
    chartFixture(id: "2025-12", budget: "100", actual: "90"),
    chartFixture(id: "2026-04", budget: "100", actual: "90"),
    chartFixture(id: "2026-02", budget: "100", actual: "90")
])
let gapSegments = AnnualBudgetComparison.segments(points: Array(gapPoints.reversed()))
checkChart(gapSegments.map { $0.points.map(\.month) } == [[12], [1, 2], [4, 5]],
           "Unsorted points become year-specific contiguous runs with a gap for March")
checkChart(Set(gapSegments.map(\.id)).count == gapSegments.count,
           "Independent line runs have unique series identities")
checkChart(AnnualBudgetComparison.segments(points: []).isEmpty,
           "An empty comparison has no line segments")

// Pay schedules and monthly aggregation must not double-count period entries.
func datedExpense(monthID: String, day: Int, amount: String) -> ReportedExpense {
    guard let start = BudgetDates.bounds(for: monthID)?.start,
          let date = BudgetDates.calendar.date(byAdding: .day, value: day - 1, to: start) else {
        fatalError("Invalid dated expense fixture")
    }
    var expense = ReportedExpense()
    expense.date = date
    expense.amount = expectedDecimal(amount)
    return expense
}

var splitMonth = chartFixture(id: "2026-01", budget: "100", actual: "125")
splitMonth.periods[1].budgeted.expenses[0].amount = chartInput("200")
splitMonth.periods[1].realistic.expenses[0].amount = chartInput("150")
let splitPoint = chartPoints([splitMonth]).first
checkChart(splitPoint?.variance == expectedDecimal("25") && splitPoint?.metBudget == true,
           "An over-budget first section and under-budget second section combine into one monthly result")

var routedMonth = chartFixture(id: "2026-01", budget: "100", actual: "30")
routedMonth.periods[1].budgeted.expenses[0].amount = chartInput("100")
routedMonth.periods[1].realistic.expenses[0].amount = chartInput("40")
routedMonth.periods[0].realistic.payroll = chartInput("1000")
routedMonth.periods[1].realistic.payroll = chartInput("1500")
routedMonth.periods[0].realistic.savings = chartInput("100")
routedMonth.periods[1].realistic.savings = chartInput("150")
routedMonth.transactions = [
    datedExpense(monthID: routedMonth.id, day: 14, amount: "5"),
    datedExpense(monthID: routedMonth.id, day: 15, amount: "10"),
    datedExpense(monthID: routedMonth.id, day: 31, amount: "20")
]
checkChart(routedMonth.windows.map(\.title) == ["1–14", "15–31"],
           "Default Bi-Weekly sections cover the 1st–14th and 15th–month end")
checkChart(routedMonth.transactions(in: routedMonth.windows[0]).map(\.dayOfMonth) == [14]
           && routedMonth.transactions(in: routedMonth.windows[1]).map(\.dayOfMonth) == [15, 31],
           "The 14th, 15th, and last day route to exactly one section")
checkChart(routedMonth.realisticSummary.totalExpenses == expectedDecimal("105")
           && routedMonth.realisticSummary.totalIncome == expectedDecimal("2500")
           && routedMonth.realisticSummary.totalSavings == expectedDecimal("250"),
           "Monthly summaries include all section income, expenses, savings, and each transaction once")
checkChart(routedMonth.realisticSummary(for: routedMonth.windows[0]).remaining == expectedDecimal("865")
           && routedMonth.realisticSummary(for: routedMonth.windows[1]).remaining == expectedDecimal("1280")
           && routedMonth.realisticSummary.remaining == expectedDecimal("2145"),
           "Current-period Home breakdowns stay separate while compact remaining totals combine the month")

let beforeSchedule = routedMonth.realisticSummary
checkChart(routedMonth.applyPaySchedule(PaySchedule(frequency: .weekly, days: [1, 8, 15, 22])),
           "Weekly accepts four distinct selected dates")
checkChart(routedMonth.periods.count == 4
           && routedMonth.windows.map(\.title) == ["1–7", "8–14", "15–21", "22–31"],
           "Weekly creates four matching budget sections")
checkChart((1...31).allSatisfy { day in routedMonth.windows.filter { $0.contains(day: day) }.count == 1 },
           "Weekly sections cover every calendar day exactly once")
checkChart(routedMonth.transactions(in: routedMonth.windows[1]).map(\.dayOfMonth) == [14]
           && routedMonth.transactions(in: routedMonth.windows[2]).map(\.dayOfMonth) == [15]
           && routedMonth.transactions(in: routedMonth.windows[3]).map(\.dayOfMonth) == [31],
           "Changing pay dates reassigns transactions without changing the monthly ledger")
checkChart(routedMonth.realisticSummary.totalExpenses == beforeSchedule.totalExpenses,
           "Adding blank weekly sections preserves monthly expenses")
checkChart(routedMonth.applyPaySchedule(PaySchedule(frequency: .monthly, days: [20])),
           "Monthly accepts one selected payday")
checkChart(routedMonth.periods.count == 1 && routedMonth.windows[0].title == "1–31"
           && routedMonth.realisticSummary.totalExpenses == beforeSchedule.totalExpenses
           && routedMonth.realisticSummary.totalIncome == beforeSchedule.totalIncome
           && routedMonth.realisticSummary.totalSavings == beforeSchedule.totalSavings,
           "Reducing to Monthly merges manual amounts without losing totals or transactions")

var blankScheduleMonth = MonthlyBudget(id: "2026-02", date: Date())
checkChart(blankScheduleMonth.applyPaySchedule(PaySchedule(frequency: .monthly, days: [15]))
           && chartPoints([blankScheduleMonth]).isEmpty,
           "Consolidating blank sections does not manufacture a green zero-spending point")
checkChart(!PaySchedule(frequency: .biWeekly, days: [15, 15]).isValid(for: "2026-02")
           && !PaySchedule(frequency: .weekly, days: [1, 8]).isValid(for: "2026-02"),
           "Duplicate dates and incomplete weekly selections are rejected")
checkChart(PaySchedule(frequency: .monthly, days: [29]).isValid(for: "2024-02")
           && !PaySchedule(frequency: .monthly, days: [29]).isValid(for: "2025-02"),
           "Payday validation respects leap-year and non-leap-year February")
checkChart(PaySchedule(frequency: .biWeekly, days: [5, 20]).windows(for: "2026-02").map(\.title)
           == ["1–19", "20–28"],
           "The first section includes early-month days before the first chosen payday")

var invalidMerge = chartFixture(id: "2026-01", budget: "100", actual: "20")
invalidMerge.periods[1].realistic.payroll = "invalid"
checkChart(!invalidMerge.applyPaySchedule(PaySchedule(frequency: .monthly, days: [1]))
           && invalidMerge.periods.count == 2
           && invalidMerge.periods[1].realistic.payroll == "invalid",
           "Invalid amounts prevent a destructive consolidation and remain intact")

// Decode the old monthly-only schema and ensure no previously entered total is lost.
do {
    let sample = chartFixture(id: "2026-01", budget: "500", actual: "250")
    let data = try JSONEncoder().encode(sample)
    var legacy = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    let oldPeriods = legacy.removeValue(forKey: "periods") as! [[String: Any]]
    legacy["realistic"] = oldPeriods[0]["realistic"]
    legacy["budgeted"] = oldPeriods[0]["budgeted"]
    legacy.removeValue(forKey: "paySchedule")
    let oldData = try JSONSerialization.data(withJSONObject: legacy)
    let migrated = try JSONDecoder().decode(MonthlyBudget.self, from: oldData)
    checkChart(migrated.periods.count == 2
               && migrated.realisticSummary.totalExpenses == expectedDecimal("250")
               && migrated.budgetedSummary.totalExpenses == expectedDecimal("500"),
               "Legacy monthly records migrate into the first section with unchanged totals")
    let roundTrip = try JSONDecoder().decode(MonthlyBudget.self, from: JSONEncoder().encode(routedMonth))
    checkChart(roundTrip.paySchedule == routedMonth.paySchedule
               && roundTrip.realisticSummary.totalExpenses == routedMonth.realisticSummary.totalExpenses
               && roundTrip.transactions.map(\.dayOfMonth) == [14, 15, 31],
               "Saved schedules, monthly totals, and stable transaction days survive Codable round trips")
} catch {
    fatalError("Persistence model check failed: \(error)")
}

// Summary optimization must retain exact cents, withdrawals, and invalid-input guards.
var firstPlan = BudgetPlan()
firstPlan.payroll = chartInput("2100.25")
firstPlan.extra = chartInput("100")
firstPlan.savings = chartInput("200")
firstPlan.savingsWithdrawn = chartInput("25.50")
firstPlan.expenses[0].amount = chartInput("100.10")
firstPlan.expenses[1].amount = chartInput("20.20")
var secondPlan = BudgetPlan()
secondPlan.payroll = chartInput("900.75")
secondPlan.extra = chartInput("50.50")
secondPlan.savings = chartInput("100.25")
secondPlan.savingsWithdrawn = chartInput("10")
secondPlan.expenses[0].amount = chartInput("35.35")
let centsTransactions = chartFixture(id: "2026-01", transactionAmounts: ["0.10", "0.20"]).transactions
let centsSummary = BudgetSummary(plans: [firstPlan, secondPlan], transactions: centsTransactions)
checkChart(centsSummary.totalIncome == expectedDecimal("3151.50")
           && centsSummary.totalExpenses == expectedDecimal("155.95")
           && centsSummary.totalSavings == expectedDecimal("300.25")
           && centsSummary.totalWithdrawn == expectedDecimal("35.50"),
           "Summary keeps exact multi-period income, expenses, transactions, and savings")
checkChart(centsSummary.remaining == expectedDecimal("2730.80") && !centsSummary.hasInvalidAmounts,
           "Remaining includes savings withdrawals and deducts deposits without rounding cents")
let emptySummary = BudgetSummary(plans: [])
checkChart(emptySummary.remaining == .zero && !emptySummary.hasInvalidAmounts,
           "Empty summaries remain valid zero totals")
for field in 0..<5 {
    var invalidPlan = firstPlan
    switch field {
    case 0: invalidPlan.payroll = "invalid"
    case 1: invalidPlan.extra = "invalid"
    case 2: invalidPlan.savings = "invalid"
    case 3: invalidPlan.savingsWithdrawn = "invalid"
    default: invalidPlan.expenses[0].amount = "invalid"
    }
    checkChart(BudgetSummary(plans: [secondPlan, invalidPlan]).hasInvalidAmounts,
               "Summary detects invalid field \(field) in a later pay period")
}

// Home lists only categories near their own selected-period expense limits.
func warningPlanFixture(_ amount: String?) -> BudgetPlan {
    var plan = BudgetPlan()
    if let amount = amount { plan.expenses[0].amount = chartInput(amount) }
    return plan
}

func warningFixture(budget: String?, actual: String?,
                    transactions: [ReportedExpense] = []) -> [PayPeriodBudgetWarning] {
    PayPeriodBudgetWarning.evaluate(budgeted: warningPlanFixture(budget),
                                    realistic: warningPlanFixture(actual),
                                    transactions: transactions)
}

checkChart(warningFixture(budget: "100", actual: "69.99").isEmpty,
           "A category with more than 30 percent of its budget left is omitted")
let warningAtSeventy = warningFixture(budget: "100", actual: "70")
checkChart(warningAtSeventy.count == 1 && warningAtSeventy.first?.category == "Home"
           && warningAtSeventy.first?.level == .approaching
           && warningAtSeventy.first?.remaining == expectedDecimal("30"),
           "A category appears exactly at 70 percent spent with its own amount left")
checkChart(warningFixture(budget: "100", actual: "99.99").first?.level == .approaching,
           "A category just below its limit remains an approaching-budget warning")
checkChart(warningFixture(budget: "100", actual: "100").first?.level == .reached,
           "A category exactly at its limit is distinguished from exceeding it")
let warningOverLimit = warningFixture(budget: "100", actual: "100.01")
checkChart(warningOverLimit.first?.level == .exceeded
           && warningOverLimit.first?.remaining == expectedDecimal("-0.01"),
           "An over-budget category retains its negative one-cent amount left")
checkChart(warningFixture(budget: "100.01", actual: "70.00").isEmpty
           && warningFixture(budget: "100.01", actual: "70.01").first?.level == .approaching,
           "Category thresholds use exact cents instead of a rounded percentage")
checkChart(warningFixture(budget: nil, actual: "25").isEmpty,
           "An untouched category budget is not an explicit zero-dollar limit")
checkChart(warningFixture(budget: "0", actual: "0").isEmpty
           && warningFixture(budget: "0", actual: nil).isEmpty,
           "A zero category limit does not warn when there is no spending")
checkChart(warningFixture(budget: "0", actual: "0.01").first?.level == .exceeded
           && warningFixture(budget: "0", actual: "0.01").first?.remaining == expectedDecimal("-0.01"),
           "Positive spending against an explicit zero category budget is over budget")

var categoryWarningBudget = warningPlanFixture("1000")
var categoryWarningActual = warningPlanFixture("100")
categoryWarningBudget.expenses[1].amount = chartInput("100") // Electric
categoryWarningActual.expenses[1].amount = chartInput("70")
categoryWarningBudget.expenses[4].amount = chartInput("50") // Misc.
categoryWarningActual.expenses[4].amount = chartInput("45")
let categoryWarnings = PayPeriodBudgetWarning.evaluate(budgeted: categoryWarningBudget,
                                                      realistic: categoryWarningActual)
checkChart(categoryWarnings.map(\.category) == ["Electric", "Misc."]
           && categoryWarnings.map(\.remaining) == [expectedDecimal("30"), expectedDecimal("5")],
           "Individual categories warn even when overall pay-period spending is far below 70 percent")
checkChart(categoryWarnings.allSatisfy { $0.category != "Home" },
           "A below-threshold category is omitted when other categories trigger the banner")
var unconfiguredWarningActual = warningPlanFixture("20")
unconfiguredWarningActual.expenses[1].amount = chartInput("100")
checkChart(PayPeriodBudgetWarning.evaluate(budgeted: warningPlanFixture("100"),
                                          realistic: unconfiguredWarningActual).isEmpty,
           "Overall spending cannot trigger rows for below-threshold or unconfigured categories")

categoryWarningBudget.payroll = "invalid"
categoryWarningBudget.savings = "invalid"
categoryWarningActual.extra = "invalid"
categoryWarningActual.savingsWithdrawn = "invalid"
checkChart(PayPeriodBudgetWarning.evaluate(budgeted: categoryWarningBudget,
                                          realistic: categoryWarningActual).map(\.category) == ["Electric", "Misc."],
           "Income and savings inputs do not change category expense warnings")
categoryWarningBudget.expenses[1].amount = "invalid"
checkChart(PayPeriodBudgetWarning.evaluate(budgeted: categoryWarningBudget,
                                          realistic: categoryWarningActual).map(\.category) == ["Misc."],
           "An invalid budgeted category is skipped without hiding another valid category")
categoryWarningBudget.expenses[1].amount = chartInput("100")
categoryWarningActual.expenses[1].amount = "invalid"
checkChart(PayPeriodBudgetWarning.evaluate(budgeted: categoryWarningBudget,
                                          realistic: categoryWarningActual).map(\.category) == ["Misc."],
           "An invalid Realistic category is skipped without hiding another valid category")

var duplicateCategoryBudget = warningPlanFixture("40")
duplicateCategoryBudget.expenses.append(ExpenseEntry(name: "Home", amount: chartInput("60")))
var duplicateCategoryActual = warningPlanFixture("30")
duplicateCategoryActual.expenses.append(ExpenseEntry(name: "Home", amount: chartInput("40")))
let groupedWarning = PayPeriodBudgetWarning.evaluate(budgeted: duplicateCategoryBudget,
                                                    realistic: duplicateCategoryActual)
checkChart(groupedWarning.count == 1 && groupedWarning.first?.budgetedExpenses == expectedDecimal("100")
           && groupedWarning.first?.realisticExpenses == expectedDecimal("70"),
           "Multiple entries with one category name produce one correctly summed warning row")
var orderedCategoryBudget = warningPlanFixture("100")
var orderedCategoryActual = warningPlanFixture("70")
for category in ["Z Other", "A Other"] {
    orderedCategoryBudget.expenses.append(ExpenseEntry(name: category, amount: chartInput("10")))
    orderedCategoryActual.expenses.append(ExpenseEntry(name: category, amount: chartInput("7")))
}
checkChart(PayPeriodBudgetWarning.evaluate(budgeted: orderedCategoryBudget,
                                          realistic: orderedCategoryActual).map(\.category)
           == ["Home", "A Other", "Z Other"],
           "Warnings use predefined category order followed by sorted extra categories")

var warningRoutedMonth = chartFixture(id: "2026-01", budget: "100", actual: "40")
warningRoutedMonth.periods[1].budgeted.expenses[0].amount = chartInput("100")
warningRoutedMonth.periods[1].realistic.expenses[0].amount = chartInput("5")
warningRoutedMonth.transactions = [
    datedExpense(monthID: warningRoutedMonth.id, day: 14, amount: "30"),
    datedExpense(monthID: warningRoutedMonth.id, day: 15, amount: "15")
]
let warningFirstWindow = warningRoutedMonth.windows.first { $0.contains(day: 14) }!
let warningSecondWindow = warningRoutedMonth.windows.first { $0.contains(day: 15) }!
let warningFirstPeriod = PayPeriodBudgetWarning.evaluate(
    budgeted: warningRoutedMonth.periods[warningFirstWindow.index].budgeted,
    realistic: warningRoutedMonth.periods[warningFirstWindow.index].realistic,
    transactions: warningRoutedMonth.transactions(in: warningFirstWindow))
let warningSecondPeriod = PayPeriodBudgetWarning.evaluate(
    budgeted: warningRoutedMonth.periods[warningSecondWindow.index].budgeted,
    realistic: warningRoutedMonth.periods[warningSecondWindow.index].realistic,
    transactions: warningRoutedMonth.transactions(in: warningSecondWindow))
checkChart(warningFirstPeriod.count == 1 && warningFirstPeriod.first?.category == "Home"
           && warningFirstPeriod.first?.realisticExpenses == expectedDecimal("70")
           && warningFirstPeriod.first?.remaining == expectedDecimal("30"),
           "A category counts its current-period manual spending and logged transaction once")
checkChart(warningSecondPeriod.isEmpty,
           "The 15th starts a new period without carrying the previous category warning")
var unrelatedTransaction = datedExpense(monthID: warningRoutedMonth.id, day: 14, amount: "500")
unrelatedTransaction.category = "Electric"
checkChart(warningFixture(budget: "100", actual: "40", transactions: [unrelatedTransaction]).isEmpty,
           "A transaction in another category cannot raise the Home category warning")
let groupedTransactions = [
    datedExpense(monthID: warningRoutedMonth.id, day: 14, amount: "20"),
    datedExpense(monthID: warningRoutedMonth.id, day: 14, amount: "10"),
    unrelatedTransaction
]
let groupedTransactionWarning = warningFixture(budget: "100", actual: "40", transactions: groupedTransactions)
checkChart(groupedTransactionWarning.count == 1
           && groupedTransactionWarning.first?.realisticExpenses == expectedDecimal("70")
           && groupedTransactionWarning.first?.remaining == expectedDecimal("30"),
           "Multiple matching transactions are summed once without including another category")
var invalidLoggedTransaction = datedExpense(monthID: warningRoutedMonth.id, day: 14, amount: "1")
invalidLoggedTransaction.category = "Electric"
invalidLoggedTransaction.amount = expectedDecimal("-1")
checkChart(warningFixture(budget: "100", actual: "70", transactions: [invalidLoggedTransaction])
           .first?.category == "Home",
           "An invalid transaction in another category does not suppress a valid warning")
let loggedZeroWarning = warningFixture(budget: "0", actual: nil,
    transactions: [datedExpense(monthID: warningRoutedMonth.id, day: 14, amount: "0.01")])
checkChart(loggedZeroWarning.first?.level == .exceeded
           && loggedZeroWarning.first?.remaining == expectedDecimal("-0.01"),
           "Logged spending alone can exceed an explicit zero category budget")

var warningWeeklyMonth = warningRoutedMonth
checkChart(warningWeeklyMonth.applyPaySchedule(PaySchedule(frequency: .weekly, days: [1, 15, 22, 29])),
           "Category warning fixture accepts a four-section weekly schedule")
let warningWeeklyWindow = warningWeeklyMonth.windows.first { $0.contains(day: 14) }!
let warningWeekly = PayPeriodBudgetWarning.evaluate(
    budgeted: warningWeeklyMonth.periods[warningWeeklyWindow.index].budgeted,
    realistic: warningWeeklyMonth.periods[warningWeeklyWindow.index].realistic,
    transactions: warningWeeklyMonth.transactions(in: warningWeeklyWindow))
checkChart(warningWeekly.first?.category == "Home" && warningWeekly.first?.remaining == expectedDecimal("30")
           && warningWeeklyMonth.periods.count == 4,
           "Empty future weekly sections do not dilute the selected category's warning")
let warningFutureWindow = warningWeeklyMonth.windows.first { $0.contains(day: 25) }!
checkChart(PayPeriodBudgetWarning.evaluate(
    budgeted: warningWeeklyMonth.periods[warningFutureWindow.index].budgeted,
    realistic: warningWeeklyMonth.periods[warningFutureWindow.index].realistic,
    transactions: warningWeeklyMonth.transactions(in: warningFutureWindow)).isEmpty,
           "An untouched future weekly section does not inherit earlier category warnings")

var warningMonthlyMonth = chartFixture(id: "2026-02", budget: "100", actual: "40")
warningMonthlyMonth.transactions = [datedExpense(monthID: warningMonthlyMonth.id, day: 28, amount: "30")]
checkChart(warningMonthlyMonth.applyPaySchedule(PaySchedule(frequency: .monthly, days: [1])),
           "Category warning fixture accepts a single monthly pay period")
let warningMonthlyWindow = warningMonthlyMonth.windows.first { $0.contains(day: 28) }!
let monthlyCategoryWarnings = PayPeriodBudgetWarning.evaluate(
    budgeted: warningMonthlyMonth.periods[warningMonthlyWindow.index].budgeted,
    realistic: warningMonthlyMonth.periods[warningMonthlyWindow.index].realistic,
    transactions: warningMonthlyMonth.transactions(in: warningMonthlyWindow))
checkChart(monthlyCategoryWarnings.first?.level == .approaching
           && monthlyCategoryWarnings.first?.remaining == expectedDecimal("30"),
           "A Monthly schedule includes late-month category spending in its current period")

print("Completed \(completedChartChecks) model checks. SwiftUI/Charts/calendar rendering still requires Xcode.")
