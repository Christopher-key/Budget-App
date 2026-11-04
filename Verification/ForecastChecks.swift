// Synthetic Foundation-model checks, appended by check-chart.sh; no real records.
var completedForecastChecks = 0
func checkForecast(_ value: @autoclosure () -> Bool, _ message: String) {
    guard value() else { fatalError("FAIL: \(message)") }
    completedForecastChecks += 1
    print("PASS: \(message)")
}

let forecastNow = BudgetDates.calendar.date(from: DateComponents(year: 2026, month: 11, day: 3, hour: 12))!
checkForecast(BudgetForecast.identifiers(from: forecastNow) == ["2026-12", "2027-01", "2027-02", "2027-03"],
              "Forecasting covers four following calendar months across the year boundary")
var forecastSource = try BudgetForecast.blank(id: "2026-11", frequency: .biWeekly)
forecastSource.periods[0].budgeted.payroll = chartInput("1000.10")
forecastSource.periods[1].budgeted.payroll = chartInput("1000.20")
forecastSource.periods[0].budgeted.expenses[1].amount = chartInput("80.05")
forecastSource.periods[0].realistic.payroll = chartInput("900")
forecastSource.transactions = [datedExpense(monthID: "2026-11", day: 3, amount: "12.34")]
let forecastCopied = try BudgetForecast.copyPlan(from: forecastSource, to: nil, id: "2026-12", now: forecastNow)
checkForecast(forecastCopied.budgetedSummary.totalIncome == expectedDecimal("2000.30"), "Copied plans preserve exact income cents")
checkForecast(forecastCopied.budgetedSummary.totalExpenses == expectedDecimal("80.05"), "Copied plans preserve expense totals")
checkForecast(forecastCopied.realisticSummary.totalIncome == .zero && forecastCopied.transactions.isEmpty,
              "Forecast copies invent no realistic income or reported transactions")
checkForecast(forecastCopied.periods[0].budgeted.expenses[0].id != forecastSource.periods[0].budgeted.expenses[0].id,
              "Copied expense lines receive fresh identities")
checkForecast(forecastSource.realisticSummary.totalIncome == expectedDecimal("900") && forecastSource.transactions.count == 1,
              "Forecasting retains the current month's actual records")
do {
    _ = try BudgetForecast.copyPlan(from: forecastSource, to: forecastCopied, id: "2026-12", now: forecastNow)
    fatalError("An existing forecast must not be overwritten")
} catch BudgetForecastError.existingPlan {
    checkForecast(true, "Copying refuses to overwrite an entered forecast")
}
var zeroForecast = try BudgetForecast.blank(id: "2026-12", frequency: .biWeekly)
zeroForecast.periods[0].budgeted.payroll = chartInput("0")
do {
    _ = try BudgetForecast.copyPlan(from: forecastSource, to: zeroForecast, id: "2026-12", now: forecastNow)
    fatalError("An explicit zero plan must be retained")
} catch BudgetForecastError.existingPlan {
    checkForecast(true, "An explicitly entered zero is an existing plan")
}
var weeklyForecast = try BudgetForecast.blank(id: "2026-12", frequency: .weekly)
weeklyForecast.paySchedule.days = [1, 8, 15, 22]
weeklyForecast.periods[3].realistic.extra = chartInput("42.50")
let expandedForecast = try BudgetForecast.copyPlan(from: forecastSource, to: weeklyForecast, id: "2026-12", now: forecastNow)
checkForecast(expandedForecast.paySchedule == weeklyForecast.paySchedule
              && expandedForecast.periods[3].realistic.extra == chartInput("42.50"),
              "A target forecast retains its own schedule and any existing realistic records")
checkForecast(expandedForecast.budgetedSummary.totalIncome == expectedDecimal("2000.30"),
              "Expanding copied plan sections preserves monthly totals")
var fourPeriodSource = try BudgetForecast.blank(id: "2026-11", frequency: .weekly)
for index in fourPeriodSource.periods.indices { fourPeriodSource.periods[index].budgeted.payroll = chartInput("\(index + 1).01") }
let onePeriodTarget = try BudgetForecast.blank(id: "2026-12", frequency: .monthly)
let combinedForecast = try BudgetForecast.copyPlan(from: fourPeriodSource, to: onePeriodTarget, id: "2026-12", now: forecastNow)
checkForecast(combinedForecast.periods.count == 1 && combinedForecast.budgetedSummary.totalIncome == expectedDecimal("10.04"),
              "Reducing copied plan sections combines every cent exactly once")
let januaryNow = BudgetDates.calendar.date(from: DateComponents(year: 2027, month: 1, day: 10, hour: 12))!
var januarySource = try BudgetForecast.blank(id: "2027-01", frequency: .biWeekly)
januarySource.paySchedule.days = [1, 31]
januarySource.periods[0].budgeted.payroll = chartInput("150")
let februaryForecast = try BudgetForecast.copyPlan(from: januarySource, to: nil, id: "2027-02", now: januaryNow)
checkForecast(februaryForecast.paySchedule.days.isEmpty && februaryForecast.budgetedSummary.totalIncome == expectedDecimal("150"),
              "Shorter months clear invalid pay dates without losing planned amounts")
do {
    _ = try BudgetForecast.copyPlan(from: forecastSource, to: nil, id: "2027-04", now: forecastNow)
    fatalError("The fifth following month must be outside the creation window")
} catch BudgetForecastError.invalidMonth {
    checkForecast(true, "New forecast copies are limited to the next four months")
}
print("Completed \(completedForecastChecks) forecast model checks.")
