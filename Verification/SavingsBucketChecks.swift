// Command-line checks only. Appended to the actual Foundation models by check-chart.sh.
// Fixtures are synthetic; no device storage, private records, or credentials are read.

var completedBucketChecks = 0
func checkBucket(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else { fatalError("FAIL: \(message)") }
    completedBucketChecks += 1
    print("PASS: \(message)")
}

func bucketDecimal(_ text: String) -> Decimal {
    Decimal(string: text, locale: Locale(identifier: "en_US_POSIX"))!
}

func bucketInput(_ text: String) -> String {
    text.replacingOccurrences(of: ".", with: Locale.current.decimalSeparator ?? ".")
}

let bucketTrip = SavingsBucket(id: UUID(uuidString: "A0000000-0000-0000-0000-000000000001")!,
                              name: "Trip", target: bucketInput("1000"))
let bucketCar = SavingsBucket(id: UUID(uuidString: "A0000000-0000-0000-0000-000000000002")!,
                             name: "Car", target: bucketInput("5000"))
let bucketLaptop = SavingsBucket(id: UUID(uuidString: "A0000000-0000-0000-0000-000000000003")!,
                                name: "Laptop", target: bucketInput("1200"))
var bucketPlan = BudgetPlan()
bucketPlan.payroll = bucketInput("1000")
bucketPlan.savings = bucketInput("100")
bucketPlan.savingsWithdrawn = bucketInput("10")
bucketPlan.expenses[0].amount = bucketInput("25.30")
bucketPlan.bucketEntries = [
    BucketSavingsEntry(id: bucketTrip.id, name: bucketTrip.name,
                       contribution: bucketInput("100.25"), withdrawal: bucketInput("20.05")),
    BucketSavingsEntry(id: bucketCar.id, name: bucketCar.name, contribution: bucketInput("50.10"))
]
let bucketSummary = BudgetSummary(plan: bucketPlan)
checkBucket(bucketPlan.totalSavings == bucketDecimal("250.35")
            && bucketSummary.totalSavings == bucketDecimal("250.35"),
            "Bucket contributions are additional to general savings and included exactly once")
checkBucket(bucketPlan.totalWithdrawn == bucketDecimal("30.05")
            && bucketSummary.totalWithdrawn == bucketDecimal("30.05"),
            "General and bucket withdrawals are included exactly once")
checkBucket(bucketPlan.remaining == bucketDecimal("754.40")
            && bucketSummary.remaining == bucketDecimal("754.40")
            && !bucketSummary.hasInvalidAmounts,
            "Remaining accounts for income, expenses, general savings, and exact bucket cash flows")
checkBucket(bucketPlan.totalExpenses == bucketDecimal("25.30"),
            "Saving for a goal is not reclassified as an expense")

var bucketJanuary = MonthlyBudget(id: "2026-01", date: Date(timeIntervalSince1970: 0))
bucketJanuary.periods[0].realistic = bucketPlan
bucketJanuary.periods[0].budgeted.bucketEntries = [
    BucketSavingsEntry(id: bucketTrip.id, name: bucketTrip.name, contribution: bucketInput("900"))
]
bucketJanuary.periods[1].realistic.bucketEntries = [
    BucketSavingsEntry(id: bucketTrip.id, name: bucketTrip.name, contribution: bucketInput("0.10"))
]
var bucketFebruary = MonthlyBudget(id: "2026-02", date: Date(timeIntervalSince1970: 0))
bucketFebruary.periods[0].realistic.bucketEntries = [
    BucketSavingsEntry(id: bucketTrip.id, name: bucketTrip.name,
                       contribution: bucketInput("0.20"), withdrawal: bucketInput("0.10"))
]
let bucketMonths = [bucketJanuary, bucketFebruary]
checkBucket(SavingsBucketLedger.progress(for: bucketTrip, months: bucketMonths).saved == bucketDecimal("80.40"),
            "Progress accumulates Actual contributions minus bucket withdrawals across periods and months")
checkBucket(SavingsBucketLedger.progress(for: bucketCar, months: bucketMonths).saved == bucketDecimal("50.10"),
            "One bucket never receives another bucket's contributions")
checkBucket(SavingsBucketLedger.totalSavings(months: bucketMonths) == bucketDecimal("220.50"),
            "Total savings equals general plus bucket savings net of their own withdrawals")
checkBucket(SavingsBucketLedger.progress(for: bucketLaptop, months: bucketMonths).saved == .zero,
            "A new goal starts at zero without inventing an opening balance")
checkBucket(SavingsBucketLedger.progress(buckets: [bucketTrip, bucketCar, bucketLaptop], months: bucketMonths)
    .map(\.saved) == [bucketDecimal("80.40"), bucketDecimal("50.10"), .zero],
            "The one-pass progress calculation preserves definition order and separate balances")

var archivedTrip = bucketTrip
archivedTrip.isActive = false
checkBucket(SavingsBucketLedger.progress(for: archivedTrip, months: bucketMonths).saved == bucketDecimal("80.40")
            && SavingsBucketLedger.totalSavings(months: bucketMonths) == bucketDecimal("220.50"),
            "Archiving a goal preserves its funded balance and historical deductions")
var renamedTrip = bucketTrip
renamedTrip.name = "Renamed trip"
renamedTrip.target = bucketInput("50")
checkBucket(SavingsBucketLedger.progress(for: renamedTrip, months: bucketMonths).saved == bucketDecimal("80.40"),
            "Renaming or lowering a target cannot erase or cap money already recorded under its ID")

var bucketReleasedMonth = bucketJanuary
bucketReleasedMonth.periods[0].realistic.bucketEntries[0].withdrawal = bucketInput("30.05")
checkBucket(bucketReleasedMonth.realisticSummary.remaining
                == bucketJanuary.realisticSummary.remaining + bucketDecimal("10")
            && SavingsBucketLedger.progress(for: bucketTrip, months: [bucketReleasedMonth]).saved
                == SavingsBucketLedger.progress(for: bucketTrip, months: [bucketJanuary]).saved! - bucketDecimal("10"),
            "Using a bucket releases money to the budget and reduces that bucket by the same amount")
var bucketGeneralWithdrawal = bucketJanuary
bucketGeneralWithdrawal.periods[0].realistic.savingsWithdrawn = bucketInput("20")
checkBucket(SavingsBucketLedger.progress(for: bucketTrip, months: [bucketGeneralWithdrawal]).saved
                == SavingsBucketLedger.progress(for: bucketTrip, months: [bucketJanuary]).saved,
            "Pulling from general savings does not silently debit an arbitrary bucket")

var bucketInvalidMonth = bucketJanuary
bucketInvalidMonth.periods[0].realistic.bucketEntries[0].contribution = "invalid"
checkBucket(SavingsBucketLedger.progress(for: bucketTrip, months: [bucketInvalidMonth]).saved == nil
            && SavingsBucketLedger.progress(for: bucketCar, months: [bucketInvalidMonth]).saved == bucketDecimal("50.10"),
            "An invalid bucket entry makes only that bucket's progress unavailable")
checkBucket(SavingsBucketLedger.totalSavings(months: [bucketInvalidMonth]) == nil
            && bucketInvalidMonth.realisticSummary.hasInvalidAmounts,
            "Invalid bucket amounts cannot silently become zero in savings or budget summaries")
bucketInvalidMonth = bucketJanuary
bucketInvalidMonth.periods[0].realistic.savings = "invalid"
checkBucket(SavingsBucketLedger.totalSavings(months: [bucketInvalidMonth]) == nil
            && SavingsBucketLedger.progress(for: bucketTrip, months: [bucketInvalidMonth]).saved == bucketDecimal("80.30"),
            "Invalid general savings does not rewrite a valid goal's own contribution history")
bucketInvalidMonth = bucketJanuary
bucketInvalidMonth.periods[0].realistic.bucketEntries.append(bucketPlan.bucketEntries[0])
checkBucket(bucketInvalidMonth.periods[0].realistic.hasInvalidSavingsAmounts
            && SavingsBucketLedger.progress(for: bucketTrip, months: [bucketInvalidMonth]).saved == nil,
            "Duplicate bucket IDs in one plan cannot double the reported savings balance")
var negativeBucketPlan = bucketPlan
negativeBucketPlan.bucketEntries[0].withdrawal = "-1"
checkBucket(negativeBucketPlan.hasInvalidAmounts && BudgetSummary(plan: negativeBucketPlan).hasInvalidAmounts,
            "Negative withdrawal inputs are invalid rather than becoming hidden extra deposits")

do {
    let encoder = JSONEncoder()
    var legacy = try JSONSerialization.jsonObject(with: encoder.encode(bucketPlan)) as! [String: Any]
    legacy.removeValue(forKey: "bucketEntries")
    let old = try JSONDecoder().decode(BudgetPlan.self, from: JSONSerialization.data(withJSONObject: legacy))
    checkBucket(old.bucketEntries.isEmpty && old.totalSavings == bucketDecimal("100")
                && old.totalWithdrawn == bucketDecimal("10") && old.remaining == bucketDecimal("884.70"),
                "Older plans without bucket fields decode with empty buckets and unchanged arithmetic")
    let restored = try JSONDecoder().decode([MonthlyBudget].self, from: encoder.encode(bucketMonths))
    checkBucket(SavingsBucketLedger.progress(for: bucketTrip, months: restored).saved == bucketDecimal("80.40")
                && restored[0].periods[0].realistic.bucketEntries[0].name == "Trip",
                "Bucket IDs, snapshot names, and balances survive saved budget round trips")
    let restoredDefinitions = try JSONDecoder().decode([SavingsBucket].self, from: encoder.encode([archivedTrip, bucketCar]))
    checkBucket(!restoredDefinitions[0].isActive && restoredDefinitions[0].target == bucketTrip.target,
                "Archived state and goal targets survive definition round trips")
} catch {
    fatalError("Savings bucket persistence model check failed: \(error)")
}

var bucketMergedMonth = bucketJanuary
bucketMergedMonth.periods[1].realistic.bucketEntries.append(
    BucketSavingsEntry(id: bucketLaptop.id, name: bucketLaptop.name,
                       contribution: bucketInput("0.35"), withdrawal: bucketInput("0.05")))
let beforeBucketMerge = bucketMergedMonth.realisticSummary
let beforeBucketProgress = SavingsBucketLedger.progress(for: bucketTrip, months: [bucketMergedMonth]).saved
checkBucket(bucketMergedMonth.applyPaySchedule(PaySchedule(frequency: .monthly, days: [1])),
            "A valid bucket-funded budget can consolidate its pay periods")
checkBucket(bucketMergedMonth.periods.count == 1
            && bucketMergedMonth.realisticSummary.totalSavings == beforeBucketMerge.totalSavings
            && bucketMergedMonth.realisticSummary.totalWithdrawn == beforeBucketMerge.totalWithdrawn
            && bucketMergedMonth.realisticSummary.remaining == beforeBucketMerge.remaining
            && SavingsBucketLedger.progress(for: bucketTrip, months: [bucketMergedMonth]).saved == beforeBucketProgress,
            "Reducing pay sections merges bucket amounts by ID without changing money or progress")
checkBucket(Set(bucketMergedMonth.periods[0].realistic.bucketEntries.map(\.id)).count == 3,
            "Consolidation keeps each distinct bucket and avoids duplicate IDs")
let afterBucketMerge = bucketMergedMonth.realisticSummary
checkBucket(bucketMergedMonth.applyPaySchedule(PaySchedule(frequency: .weekly, days: [1, 8, 15, 22]))
            && bucketMergedMonth.realisticSummary.remaining == afterBucketMerge.remaining
            && bucketMergedMonth.periods[3].realistic.bucketEntries.isEmpty,
            "Adding pay sections starts their bucket entries empty without changing old funding")
var bucketBadMerge = bucketJanuary
bucketBadMerge.periods[1].realistic.bucketEntries[0].withdrawal = "invalid"
checkBucket(!bucketBadMerge.applyPaySchedule(PaySchedule(frequency: .monthly, days: [1]))
            && bucketBadMerge.periods.count == 2
            && bucketBadMerge.periods[1].realistic.bucketEntries[0].withdrawal == "invalid",
            "Invalid bucket data blocks destructive consolidation and remains available for correction")

var bucketExpenseOnly = bucketJanuary
bucketExpenseOnly.periods[0].budgeted.expenses[0].amount = bucketInput("30")
let withBucketsPoint = AnnualBudgetComparison.points(months: [bucketExpenseOnly], currentMonthID: "2026-01").first
bucketExpenseOnly.periods[0].realistic.bucketEntries = []
bucketExpenseOnly.periods[1].realistic.bucketEntries = []
bucketExpenseOnly.periods[0].budgeted.bucketEntries = []
let withoutBucketsPoint = AnnualBudgetComparison.points(months: [bucketExpenseOnly], currentMonthID: "2026-01").first
checkBucket(withBucketsPoint?.variance == withoutBucketsPoint?.variance
            && withBucketsPoint?.variance == bucketDecimal("4.70"),
            "Savings buckets never change the expense-only historical graph")
checkBucket(!SavingsBucket(name: "", target: "100").hasValidDetails
            && !SavingsBucket(name: "Goal", target: "0").hasValidDetails
            && !SavingsBucket(name: "Goal", target: "invalid").hasValidDetails,
            "Buckets require a real name and a positive valid target")

print("Completed \(completedBucketChecks) savings bucket checks using synthetic data.")
