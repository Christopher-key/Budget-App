// Command-line verification only. Do not add this file to the iOS app target.
// check-excel-export.sh appends this to the app's actual Foundation models/exporter.

var completedExcelChecks = 0

func checkExcel(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else { fatalError("FAIL: \(message)") }
    completedExcelChecks += 1
    print("PASS: \(message)")
}

func excelDecimal(_ value: String) -> Decimal {
    guard let result = Decimal(string: value, locale: Locale(identifier: "en_US_POSIX")) else {
        fatalError("Invalid synthetic fixture amount")
    }
    return result
}

func excelInput(_ value: String) -> String {
    value.replacingOccurrences(of: ".", with: Locale.current.decimalSeparator ?? ".")
}

func excelDate(_ year: Int, _ month: Int, _ day: Int) -> Date {
    guard let result = BudgetDates.calendar.date(from:
        DateComponents(year: year, month: month, day: day, hour: 12)) else {
        fatalError("Invalid synthetic fixture date")
    }
    return result
}

func containsExcelBytes(_ data: Data, _ text: String) -> Bool {
    data.range(of: Data(text.utf8)) != nil
}

func rejectsExcel(_ message: String, _ operation: () throws -> Data) {
    do {
        _ = try operation()
        fatalError("FAIL: \(message)")
    } catch {
        completedExcelChecks += 1
        print("PASS: \(message)")
    }
}

func syntheticExcelMonth() -> MonthlyBudget {
    var month = MonthlyBudget(id: "2026-01", date: excelDate(2026, 1, 1))
    month.periods[0].budgeted.payroll = excelInput("1200")
    month.periods[0].budgeted.expenses[0].amount = excelInput("125")
    month.periods[0].budgeted.expenses[1].amount = excelInput("25")
    month.periods[0].budgeted.savings = excelInput("200")
    month.periods[1].budgeted.payroll = excelInput("1000")
    month.periods[1].budgeted.expenses[2].amount = excelInput("0")
    month.periods[1].budgeted.expenses[9].amount = excelInput("50")
    month.periods[1].budgeted.savings = excelInput("100")

    month.periods[0].realistic.payroll = excelInput("1000.10")
    month.periods[0].realistic.extra = excelInput("25.50")
    month.periods[0].realistic.expenses[0].amount = excelInput("100.10")
    month.periods[0].realistic.expenses[1].amount = excelInput("20.20")
    month.periods[0].realistic.savings = excelInput("100")
    month.periods[0].realistic.savingsWithdrawn = excelInput("10")
    month.periods[1].realistic.payroll = excelInput("900.90")
    month.periods[1].realistic.expenses[9].amount = excelInput("30.30")
    month.periods[1].realistic.savings = excelInput("50.25")

    var first = ReportedExpense()
    first.id = UUID(uuidString: "12345678-1234-1234-1234-123456789ABC")!
    first.date = excelDate(2026, 1, 14)
    first.category = "Home"
    first.amount = excelDecimal("0.10")
    first.note = "=HYPERLINK(\"https://example.invalid\",\"PRIVATE-NOTE-TEST\")\n\t&<>\" 😀\u{0001}end"
    var second = ReportedExpense()
    second.id = UUID(uuidString: "87654321-4321-4321-4321-CBA987654321")!
    second.date = excelDate(2026, 1, 15)
    second.category = "Grocery"
    second.amount = excelDecimal("0.20")
    second.note = "PRIVATE-NOTE-SECOND"
    month.transactions = [first, second]
    return month
}

guard CommandLine.arguments.count == 2 else {
    fatalError("Provide the temporary verification output directory")
}
let excelOutputDirectory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let excelCreationDate = excelDate(2026, 11, 1)
let excelMonth = syntheticExcelMonth()
let excelEncoder = JSONEncoder()
excelEncoder.outputFormatting = [.sortedKeys]
let excelBefore = try excelEncoder.encode(excelMonth)
let withoutNotes = try ExcelBudgetExport.make(months: [excelMonth], includeNotes: false,
                                             createdAt: excelCreationDate)
let withNotes = try ExcelBudgetExport.make(months: [excelMonth], includeNotes: true,
                                          createdAt: excelCreationDate)
let excelAfter = try excelEncoder.encode(excelMonth)
checkExcel(withoutNotes.prefix(4) == Data([0x50, 0x4b, 0x03, 0x04]),
           "Export is an actual ZIP-based Excel workbook")
checkExcel(excelAfter == excelBefore,
           "Export leaves the financial ledger unchanged")
checkExcel(!containsExcelBytes(withoutNotes, "PRIVATE-NOTE-TEST")
           && !containsExcelBytes(withoutNotes, "PRIVATE-NOTE-SECOND"),
           "Notes are excluded by default")
checkExcel(containsExcelBytes(withNotes, "PRIVATE-NOTE-TEST")
           && containsExcelBytes(withNotes, "PRIVATE-NOTE-SECOND"),
           "Explicit note selection includes the chosen notes")
checkExcel(!containsExcelBytes(withNotes, excelMonth.transactions[0].id.uuidString)
           && !containsExcelBytes(withNotes, excelMonth.transactions[1].id.uuidString),
           "Exports omit internal transaction identifiers")
checkExcel(!containsExcelBytes(withoutNotes, "MyBudget.lock")
           && !containsExcelBytes(withoutNotes, "passcode.json")
           && !containsExcelBytes(withoutNotes, "settings.plist"),
           "Workbook has no preferences or passcode payload")

var unselected = MonthlyBudget(id: "2025-12", date: excelDate(2025, 12, 1))
unselected.periods[0].realistic.extra = excelInput("777777.77")
var privateTransaction = ReportedExpense()
privateTransaction.date = excelDate(2025, 12, 10)
privateTransaction.amount = excelDecimal("123.45")
privateTransaction.note = "UNSELECTED-PRIVATE-RECORD"
unselected.transactions = [privateTransaction]
let excelLedger = [unselected, excelMonth]
let selectedOnly = try ExcelBudgetExport.make(months: excelLedger.filter { $0.id == "2026-01" },
                                               includeNotes: true, createdAt: excelCreationDate)
checkExcel(!containsExcelBytes(selectedOnly, "2025-12")
           && !containsExcelBytes(selectedOnly, "777777.77")
           && !containsExcelBytes(selectedOnly, "UNSELECTED-PRIVATE-RECORD"),
           "Selected-month export has no unselected month or private payload")

rejectsExcel("An empty month selection is rejected") {
    try ExcelBudgetExport.make(months: [], includeNotes: false)
}
rejectsExcel("Duplicate months cannot silently double the exported ledger") {
    try ExcelBudgetExport.make(months: [excelMonth, excelMonth], includeNotes: false)
}
let invalidIdentifier = MonthlyBudget(id: "2026-13", date: excelDate(2026, 1, 1))
rejectsExcel("Invalid calendar-month identifiers cannot produce ambiguous dates") {
    try ExcelBudgetExport.make(months: [invalidIdentifier], includeNotes: false)
}
var invalidMonth = excelMonth
invalidMonth.periods[1].realistic.savings = "invalid"
rejectsExcel("Invalid savings block export instead of producing a misleading zero") {
    try ExcelBudgetExport.make(months: [invalidMonth], includeNotes: false)
}
invalidMonth = excelMonth
invalidMonth.periods[0].budgeted.expenses[0].amount = "invalid"
rejectsExcel("Invalid expense amounts block export") {
    try ExcelBudgetExport.make(months: [invalidMonth], includeNotes: false)
}
invalidMonth = excelMonth
invalidMonth.periods.removeLast()
rejectsExcel("Mismatched period counts block incomplete financial exports") {
    try ExcelBudgetExport.make(months: [invalidMonth], includeNotes: false)
}
invalidMonth = excelMonth
invalidMonth.transactions[0].dayOfMonth = 32
rejectsExcel("Transactions outside the calendar month block export") {
    try ExcelBudgetExport.make(months: [invalidMonth], includeNotes: false)
}
invalidMonth = excelMonth
invalidMonth.transactions[0].amount = excelDecimal("0.001")
rejectsExcel("Sub-cent transaction values are rejected instead of rounded") {
    try ExcelBudgetExport.make(months: [invalidMonth], includeNotes: false)
}
invalidMonth = excelMonth
invalidMonth.transactions[0].amount = .zero
rejectsExcel("Non-positive transactions cannot create misleading totals") {
    try ExcelBudgetExport.make(months: [invalidMonth], includeNotes: false)
}
invalidMonth = excelMonth
invalidMonth.transactions.append(invalidMonth.transactions[0])
rejectsExcel("Duplicate transaction identifiers cannot duplicate spending") {
    try ExcelBudgetExport.make(months: [invalidMonth], includeNotes: false)
}
invalidMonth = excelMonth
invalidMonth.periods[0].realistic.payroll = excelInput("10000000000000.00")
rejectsExcel("Amounts beyond Excel's exact-cent precision are rejected") {
    try ExcelBudgetExport.make(months: [invalidMonth], includeNotes: false)
}

let emptyMonth = MonthlyBudget(id: "2026-02", date: excelDate(2026, 2, 1))
let emptyWorkbook = try ExcelBudgetExport.make(months: [emptyMonth], includeNotes: false,
                                              createdAt: excelCreationDate)
var explicitZero = emptyMonth
explicitZero.periods[0].budgeted.payroll = excelInput("0")
explicitZero.periods[0].realistic.payroll = excelInput("0")
let explicitZeroWorkbook = try ExcelBudgetExport.make(months: [explicitZero], includeNotes: false,
                                                     createdAt: excelCreationDate)
var monthly = excelMonth
checkExcel(monthly.applyPaySchedule(PaySchedule(frequency: .monthly, days: [10])),
           "Synthetic monthly schedule is valid")
let monthlyWorkbook = try ExcelBudgetExport.make(months: [monthly], includeNotes: false,
                                                createdAt: excelCreationDate)
var weekly = excelMonth
checkExcel(weekly.applyPaySchedule(PaySchedule(frequency: .weekly, days: [1, 8, 15, 22])),
           "Synthetic weekly schedule is valid")
let weeklyWorkbook = try ExcelBudgetExport.make(months: [weekly], includeNotes: false,
                                               createdAt: excelCreationDate)

// Calendar-year layouts use only synthetic records, never the user's template data.
var distinctPeriod = excelMonth
distinctPeriod.periods[1].budgeted.payroll = excelInput("800")
let distinctPeriodWorkbook = try ExcelBudgetExport.make(months: [distinctPeriod], includeNotes: false,
                                                       createdAt: excelCreationDate)
var february = MonthlyBudget(id: "2026-02", date: excelDate(2026, 2, 1))
february.periods[0].realistic.payroll = excelInput("70")
february.periods[0].realistic.savingsWithdrawn = excelInput("3")
february.periods[0].realistic.expenses[0].amount = excelInput("5")
february.periods[1].realistic.payroll = excelInput("90")
february.periods[1].realistic.savings = excelInput("4")
let multipleMonthsWorkbook = try ExcelBudgetExport.make(months: [february, excelMonth], includeNotes: false,
                                                       createdAt: excelCreationDate)
var priorYear = MonthlyBudget(id: "2025-12", date: excelDate(2025, 12, 1))
priorYear.periods[0].budgeted.payroll = excelInput("42")
priorYear.periods[0].realistic.payroll = excelInput("40")
priorYear.periods[0].realistic.expenses[0].amount = excelInput("1.25")
let multipleYearsWorkbook = try ExcelBudgetExport.make(months: [excelMonth, priorYear], includeNotes: false,
                                                      createdAt: excelCreationDate)
var unknownCategory = excelMonth
unknownCategory.periods[0].budgeted.expenses.append(
    ExpenseEntry(name: "Parking", amount: excelInput("7.50")))
unknownCategory.periods[0].realistic.expenses.append(
    ExpenseEntry(name: "Parking", amount: excelInput("2.50")))
var parkingTransaction = ReportedExpense()
parkingTransaction.date = excelDate(2026, 1, 3)
parkingTransaction.category = "Parking"
parkingTransaction.amount = excelDecimal("0.25")
unknownCategory.transactions.append(parkingTransaction)
let unknownCategoryWorkbook = try ExcelBudgetExport.make(months: [unknownCategory], includeNotes: false,
                                                        createdAt: excelCreationDate)

// Bucket fixtures contain synthetic names and amounts, never real goal records.
let excelBucketID = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
let excelBucketName = "=HYPERLINK(\"x\",\"BUCKET-LITERAL-NAME & <😀>\")"
var fundedBucket = excelMonth
fundedBucket.periods[0].budgeted.bucketEntries = [
    BucketSavingsEntry(id: excelBucketID, name: excelBucketName,
                       contribution: excelInput("40"), withdrawal: excelInput("3"))
]
fundedBucket.periods[0].realistic.bucketEntries = [
    BucketSavingsEntry(id: excelBucketID, name: excelBucketName,
                       contribution: excelInput("25"), withdrawal: excelInput("5"))
]
let fundedBucketBefore = try excelEncoder.encode(fundedBucket)
let fundedBucketWorkbook = try ExcelBudgetExport.make(months: [fundedBucket], includeNotes: false,
                                                      createdAt: excelCreationDate)
let fundedBucketAfter = try excelEncoder.encode(fundedBucket)
checkExcel(fundedBucketBefore == fundedBucketAfter,
           "Exporting bucket funding leaves the source ledger unchanged")
checkExcel(containsExcelBytes(fundedBucketWorkbook, "Savings Buckets")
           && containsExcelBytes(fundedBucketWorkbook, "BUCKET-LITERAL-NAME")
           && !containsExcelBytes(fundedBucketWorkbook, excelBucketID.uuidString),
           "Funded buckets export names and period entries without their internal identifiers")

var blankBucket = emptyMonth
blankBucket.periods[0].realistic.bucketEntries = [
    BucketSavingsEntry(id: excelBucketID, name: "EMPTY-BUCKET-NAME-SHOULD-NOT-EXPORT")
]
let blankBucketWorkbook = try ExcelBudgetExport.make(months: [blankBucket], includeNotes: false,
                                                    createdAt: excelCreationDate)
checkExcel(!containsExcelBytes(blankBucketWorkbook, "EMPTY-BUCKET-NAME-SHOULD-NOT-EXPORT"),
           "Blank bucket entries expose no unused bucket names")

var zeroBucket = emptyMonth
zeroBucket.periods[0].budgeted.bucketEntries = [
    BucketSavingsEntry(id: excelBucketID, name: "Synthetic zero bucket", contribution: excelInput("0"))
]
zeroBucket.periods[0].realistic.bucketEntries = zeroBucket.periods[0].budgeted.bucketEntries
let zeroBucketWorkbook = try ExcelBudgetExport.make(months: [zeroBucket], includeNotes: false,
                                                   createdAt: excelCreationDate)
checkExcel(containsExcelBytes(zeroBucketWorkbook, "Synthetic zero bucket"),
           "Explicit zero bucket funding counts as entered data")

var withdrawalOnlyBucket = emptyMonth
withdrawalOnlyBucket.periods[0].budgeted.bucketEntries = [
    BucketSavingsEntry(id: excelBucketID, name: "Synthetic withdrawal bucket", contribution: excelInput("0"))
]
withdrawalOnlyBucket.periods[0].realistic.bucketEntries = [
    BucketSavingsEntry(id: excelBucketID, name: "Synthetic withdrawal bucket", withdrawal: excelInput("5"))
]
let withdrawalOnlyWorkbook = try ExcelBudgetExport.make(months: [withdrawalOnlyBucket], includeNotes: false,
                                                       createdAt: excelCreationDate)

var outsideBucket = unselected
outsideBucket.periods[0].realistic.bucketEntries = [
    BucketSavingsEntry(id: UUID(uuidString: "ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB")!,
                       name: "OUTSIDE-BUCKET-DO-NOT-EXPORT", contribution: excelInput("444444.44"))
]
let selectedWithoutBuckets = try ExcelBudgetExport.make(months: [outsideBucket, excelMonth]
    .filter { $0.id == "2026-01" }, includeNotes: false, createdAt: excelCreationDate)
checkExcel(!containsExcelBytes(selectedWithoutBuckets, "OUTSIDE-BUCKET-DO-NOT-EXPORT")
           && !containsExcelBytes(selectedWithoutBuckets, "444444.44")
           && !containsExcelBytes(selectedWithoutBuckets, outsideBucket.periods[0].realistic.bucketEntries[0].id.uuidString),
           "Unselected bucket funding cannot leak through a selected-month export")

var invalidBucket = fundedBucket
invalidBucket.periods[0].realistic.bucketEntries[0].contribution = "invalid"
rejectsExcel("Invalid bucket contributions block export instead of becoming zero") {
    try ExcelBudgetExport.make(months: [invalidBucket], includeNotes: false)
}
invalidBucket = fundedBucket
invalidBucket.periods[0].realistic.bucketEntries[0].withdrawal = "invalid"
rejectsExcel("Invalid bucket withdrawals block export") {
    try ExcelBudgetExport.make(months: [invalidBucket], includeNotes: false)
}
invalidBucket = fundedBucket
invalidBucket.periods[0].realistic.bucketEntries.append(invalidBucket.periods[0].realistic.bucketEntries[0])
rejectsExcel("Duplicate bucket entries cannot duplicate a period's funding") {
    try ExcelBudgetExport.make(months: [invalidBucket], includeNotes: false)
}
invalidBucket = fundedBucket
invalidBucket.periods[0].realistic.bucketEntries[0].name = ""
rejectsExcel("Unnamed funded buckets block export") {
    try ExcelBudgetExport.make(months: [invalidBucket], includeNotes: false)
}
let layoutSourcesBefore = try excelEncoder.encode([excelMonth, february, priorYear, unknownCategory])
_ = try ExcelBudgetExport.make(months: [excelMonth, february, priorYear, unknownCategory]
    .filter { $0.id == "2026-02" }, includeNotes: false, createdAt: excelCreationDate)
let layoutSourcesAfter = try excelEncoder.encode([excelMonth, february, priorYear, unknownCategory])
checkExcel(layoutSourcesAfter == layoutSourcesBefore,
           "Calendar-year layout generation leaves all source budgets untouched")
checkExcel(containsExcelBytes(multipleYearsWorkbook, "CY25 Data")
           && containsExcelBytes(multipleYearsWorkbook, "CY26 Data"),
           "Every selected calendar year gets its own overview sheet")
checkExcel(containsExcelBytes(multipleMonthsWorkbook, "February 2026")
           && !containsExcelBytes(withoutNotes, "February 2026"),
           "Overview date blocks include selected months only")
checkExcel(containsExcelBytes(unknownCategoryWorkbook, "Parking"),
           "Unknown expense categories remain visible in calendar-year layouts")
try withoutNotes.write(to: excelOutputDirectory.appendingPathComponent("without-notes.xlsx"))
try withNotes.write(to: excelOutputDirectory.appendingPathComponent("with-notes.xlsx"))
try emptyWorkbook.write(to: excelOutputDirectory.appendingPathComponent("empty-month.xlsx"))
try explicitZeroWorkbook.write(to: excelOutputDirectory.appendingPathComponent("explicit-zero.xlsx"))
try monthlyWorkbook.write(to: excelOutputDirectory.appendingPathComponent("monthly.xlsx"))
try weeklyWorkbook.write(to: excelOutputDirectory.appendingPathComponent("weekly.xlsx"))
try distinctPeriodWorkbook.write(to: excelOutputDirectory.appendingPathComponent("distinct-period.xlsx"))
try multipleMonthsWorkbook.write(to: excelOutputDirectory.appendingPathComponent("multiple-months.xlsx"))
try multipleYearsWorkbook.write(to: excelOutputDirectory.appendingPathComponent("multiple-years.xlsx"))
try unknownCategoryWorkbook.write(to: excelOutputDirectory.appendingPathComponent("unknown-category.xlsx"))
try fundedBucketWorkbook.write(to: excelOutputDirectory.appendingPathComponent("funded-bucket.xlsx"))
try blankBucketWorkbook.write(to: excelOutputDirectory.appendingPathComponent("blank-bucket.xlsx"))
try zeroBucketWorkbook.write(to: excelOutputDirectory.appendingPathComponent("zero-bucket.xlsx"))
try withdrawalOnlyWorkbook.write(to: excelOutputDirectory.appendingPathComponent("withdrawal-only-bucket.xlsx"))
try selectedWithoutBuckets.write(to: excelOutputDirectory.appendingPathComponent("selected-no-buckets.xlsx"))
print("Completed \(completedExcelChecks) export checks. Synthetic workbooks are temporary test artifacts.")
