import Foundation

// Local report generation only. No storage access, network calls, or credentials.
enum ExcelExportError: LocalizedError {
    case emptySelection
    case invalidData(String)
    case tooLarge

    var errorDescription: String? {
        switch self {
        case .emptySelection:
            return "Select at least one month to export."
        case .invalidData(let detail):
            return "The workbook could not be created. \(detail)"
        case .tooLarge:
            return "This export is too large. Select fewer months and try again."
        }
    }
}

enum ExcelBudgetExport {
    static let schemaVersion = 2
    private static let maximumBytes = 32 * 1_024 * 1_024
    // Excel numeric cells have 15 significant digits. Reject larger amounts
    // rather than silently losing financial cents in the exported workbook.
    private static let maximumMoney = Decimal(string: "9999999999999.99",
                                               locale: Locale(identifier: "en_US_POSIX"))!

    static func make(months: [MonthlyBudget], includeNotes: Bool,
                     createdAt: Date = Date()) throws -> Data {
        try Task.checkCancellation()
        guard !months.isEmpty else { throw ExcelExportError.emptySelection }
        guard months.count <= 1_200,
              months.reduce(0, { $0 + $1.transactions.count }) <= 100_000,
              months.reduce(0, { subtotal, month in
                  subtotal + month.periods.reduce(0, { $0 + $1.realistic.expenses.count + $1.budgeted.expenses.count })
              }) <= 100_000 else {
            throw ExcelExportError.tooLarge
        }
        try validate(months)
        let ordered = months.sorted { $0.id < $1.id }
        let currentParts = BudgetDates.calendar.dateComponents([.year, .month], from: createdAt)
        let currentID = String(format: "%04d-%02d", currentParts.year ?? 2000, currentParts.month ?? 1)
        let timestamp = ISO8601DateFormatter().string(from: createdAt)
        var summary = Sheet(name: "Monthly Summary", headers: [
            "Month", "Currency", "State", "Budgeted Income", "Budgeted Expenses",
            "Budgeted Savings Deposits", "Budgeted Savings Withdrawals", "Budgeted Remaining",
            "Realistic Income", "Unlogged Expenses", "Logged Expenses", "Realistic Expenses",
            "Savings Deposits", "Savings Withdrawals", "Savings Change", "Realistic Remaining",
            "Expense Budget Remaining"
        ])
        var periods = Sheet(name: "Pay Periods", headers: [
            "Month", "Period", "Start Day", "End Day", "Payday", "Plan", "Payroll", "Extra",
            "Income", "Unlogged Expenses", "Logged Expenses", "Total Expenses",
            "Savings Deposits", "Savings Withdrawals", "Savings Change", "Remaining"
        ])
        var categories = Sheet(name: "Categories", headers: [
            "Month", "Period", "Start Day", "End Day", "Plan", "Category",
            "Manual Amount", "Logged Amount", "Total Amount"
        ])
        var transactions = Sheet(name: "Transactions", headers:
            ["Date", "Month", "Period", "Category", "Amount"] + (includeNotes ? ["Notes"] : []))

        for month in ordered {
            try Task.checkCancellation()
            let budgeted = month.budgetedSummary
            let realistic = month.realisticSummary
            let logged = month.transactions.reduce(Decimal.zero) { $0 + $1.amount }
            let manual = month.realisticPlans.reduce(Decimal.zero) { $0 + $1.totalExpenses }
            summary.rows.append([
                .text(month.id), .text("USD"),
                .text(month.id == currentID ? "Current / in progress" : (month.id < currentID ? "Historical" : "Future / planned")),
                .money(budgeted.totalIncome), .money(budgeted.totalExpenses),
                .money(budgeted.totalSavings), .money(budgeted.totalWithdrawn), .money(budgeted.remaining),
                .money(realistic.totalIncome), .money(manual), .money(logged), .money(realistic.totalExpenses),
                .money(realistic.totalSavings), .money(realistic.totalWithdrawn),
                .money(realistic.totalSavings - realistic.totalWithdrawn), .money(realistic.remaining),
                .money(budgeted.totalExpenses - realistic.totalExpenses)
            ])
            for window in month.windows {
                let reported = month.transactions(in: window)
                let reportedByCategory = reported.reduce(into: [String: Decimal]()) {
                    $0[$1.category, default: .zero] += $1.amount
                }
                let plans: [(String, BudgetPlan, [ReportedExpense])] = [
                    ("Budgeted", month.periods[window.index].budgeted, []),
                    ("Realistic", month.periods[window.index].realistic, reported)
                ]
                for (name, plan, includedTransactions) in plans {
                    let value = BudgetSummary(plan: plan, transactions: includedTransactions)
                    let reportedTotal = includedTransactions.reduce(Decimal.zero) { $0 + $1.amount }
                    periods.rows.append([
                        .text(month.id), .number(Decimal(window.index + 1)),
                        .number(Decimal(window.startDay)), .number(Decimal(window.endDay)),
                        window.payDay.map { .number(Decimal($0)) } ?? .blank, .text(name),
                        rawMoney(plan.payroll), rawMoney(plan.extra), .money(value.totalIncome),
                        .money(plan.totalExpenses), .money(reportedTotal), .money(value.totalExpenses),
                        rawMoney(plan.savings), rawMoney(plan.savingsWithdrawn),
                        .money(value.totalSavings - value.totalWithdrawn), .money(value.remaining)
                    ])
                    let known = Set(plan.expenses.map(\.name))
                        .union(includedTransactions.map(\.category))
                    let names = expenseCategories.filter { known.contains($0) }
                        + known.subtracting(expenseCategories).sorted()
                    for category in names {
                        let entries = plan.expenses.filter { $0.name == category }
                        let manualAmount = entries.reduce(Decimal.zero) { $0 + moneyValue($1.amount) }
                        let hasManual = entries.contains { !$0.amount.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                        let loggedAmount = name == "Realistic" ? (reportedByCategory[category] ?? .zero) : .zero
                        categories.rows.append([
                            .text(month.id), .number(Decimal(window.index + 1)),
                            .number(Decimal(window.startDay)), .number(Decimal(window.endDay)),
                            .text(name), .text(category), hasManual ? .money(manualAmount) : .blank,
                            .money(loggedAmount), .money(manualAmount + loggedAmount)
                        ])
                    }
                }
            }
            for transaction in month.transactions.sorted(by: {
                if $0.dayOfMonth != $1.dayOfMonth { return $0.dayOfMonth < $1.dayOfMonth }
                if $0.date != $1.date { return $0.date < $1.date }
                return $0.id.uuidString < $1.id.uuidString
            }) {
                guard let window = month.windows.first(where: { $0.contains(day: transaction.dayOfMonth) }) else {
                    throw ExcelExportError.invalidData("A transaction has no matching pay period in \(month.id).")
                }
                var row: [Cell] = [
                    .text(String(format: "%@-%02d", month.id, transaction.dayOfMonth)),
                    .text(month.id), .number(Decimal(window.index + 1)),
                    .text(transaction.category), .money(transaction.amount)
                ]
                if includeNotes { row.append(.text(transaction.note)) }
                transactions.rows.append(row)
            }
        }

        var readMe = Sheet(name: "Read Me", headers: ["Item", "Explanation"])
        readMe.rows = [
            [.text("Report"), .text("Budget App Excel export; schema \(schemaVersion)")],
            [.text("Created (UTC)"), .text(timestamp)],
            [.text("Selected months"), .text(ordered.map(\.id).joined(separator: ", "))],
            [.text("Calendar-year overview"), .text("CY sheets show the selected pay periods chronologically, with Projected (Budgeted), Actual (Realistic), and Line Item columns. Only selected records appear; no missing periods are fabricated.")],
            [.text("CY outflows"), .text("Expenses and savings deposits are negative only in the CY overview. Total Due is the negative sum of expenses and savings deposits; Left Over matches the app's Remaining exactly. The detail sheets retain positive expense/deposit amounts.")],
            [.text("CY income and withdrawals"), .text("Income is Payroll; Additional income is Extra. Row 5 is Savings withdrawals, not carryover or opening cash. No carryover amount is inferred.")],
            [.text("CY comparison"), .text("Actual Left Over is compared with its own period's Projected Left Over: red below projection, green at or above it. Both sides need an explicit input; untouched plans have no comparison coloring. Entered zero counts as an input.")],
            [.text("Static values"), .text("All financial totals are app-computed snapshots, not spreadsheet cell formulas. Conditional formatting only compares cells inside this workbook. Editing this copy never updates the app.")],
            [.text("Currency"), .text("USD; monetary cells show two decimal places.")],
            [.text("Snapshot"), .text("This workbook is a read-only report at export time. Editing it does not update the iPhone app.")],
            [.text("Realistic spending"), .text("Unlogged manual expenses plus reported transactions, counted once. Do not add the Categories or Transactions sheets to summary totals again.")],
            [.text("Budgeted spending"), .text("Planned expenses. Reported transactions do not change the budgeted amounts.")],
            [.text("Remaining"), .text("Income + savings withdrawals - expenses - savings deposits.")],
            [.text("Expense Budget Remaining"), .text("Budgeted expenses minus Realistic expenses. Negative means spending exceeded the expense budget.")],
            [.text("Blank versus zero"), .text("Blank manual-input cells preserve missing entries; an entered zero is numeric 0. Calculated totals treat blank inputs as zero, matching the app.")],
            [.text("Savings Change"), .text("Recorded deposits minus withdrawals for that row's selected period only. This is not an all-time savings balance or a verified bank balance.")],
            [.text("Current month"), .text("Current-month figures are in progress, not a completed-month result.")],
            [.text("Dates"), .text("Transaction dates use the saved budget month and recorded local day, preserving pay-period allocation across timezone changes.")],
            [.text("Upcoming expenses"), .text("Budgeted categories are plans, not bill due dates or payment-status records. No due dates or recurring bills are inferred.")],
            [.text("Notes"), .text(includeNotes ? "Transaction notes were explicitly included. Text is stored as text, never executable formulas." : "Transaction notes were excluded.")],
            [.text("Privacy"), .text("No passcodes, verifier, credentials, device identifiers, or internal paths are exported. No network request is made by the report generator.")],
            [.text("External copies"), .text("This workbook is not password-encrypted. After saving or sharing it, its destination controls the copy. App reset cannot erase copies outside the app.")],
            [.text("Scope"), .text("Only the selected months are included. This report is not a backup/restore file.")]
        ]
        return try workbook(yearlySheets(ordered) + [readMe, summary, periods, categories, transactions])
    }

    // The presentation is based on the supplied workbook's layout, never its
    // financial records, fixed dates, formulas, or personal comparison thresholds.
    private static func yearlySheets(_ ordered: [MonthlyBudget]) throws -> [Sheet] {
        let monthNames = ["January", "February", "March", "April", "May", "June",
                          "July", "August", "September", "October", "November", "December"]
        let years = Dictionary(grouping: ordered) { String($0.id.prefix(4)) }
        return try years.keys.sorted().map { identifier in
            try Task.checkCancellation()
            let year = Int(identifier)!
            let name = (2000...2099).contains(year)
                ? String(format: "CY%02d Data", year % 100)
                : String(format: "CY%04d Data", year)
            let months = years[identifier]!.sorted { $0.id < $1.id }
            let known = Set(expenseCategories)
            let allNames = Set(months.flatMap { month in
                (month.budgetedPlans + month.realisticPlans).flatMap { $0.expenses.map(\.name) }
                    + month.transactions.map(\.category)
            })
            let additionalNames = allNames.subtracting(known).sorted()
            // Nil denotes a dedicated savings-deposit line, not a category.
            let expenseLines: [(label: String, category: String?)] = [
                ("Home / Rent", "Home"), ("Car", "Car"), ("Insurance", "Insurance"),
                ("Phone", "Phone"), ("Grocery / Food", "Grocery"), ("Gas", "Gas"),
                ("Electric", "Electric"), ("Savings deposits", nil),
                ("Credit Card", "Credit Card"), ("Misc.", "Misc."), ("Going-out", "Going-out")
            ] + additionalNames.map { ($0, Optional($0)) }
            let totalDueRow = 6 + expenseLines.count // Zero-based: row 18 in the standard layout.
            let leftOverRow = totalDueRow + 1
            let blockCount = months.reduce(0) { $0 + $1.windows.count }
            let width = blockCount * 4
            guard width <= 16_384, leftOverRow + 1 <= 1_048_576,
                  width * (leftOverRow + 1) <= 200_000 else {
                throw ExcelExportError.tooLarge
            }
            var sheet = Sheet(name: name, headers: [])
            sheet.isYearlyOverview = true
            sheet.rows = Array(repeating: Array(repeating: .blank, count: width), count: leftOverRow + 1)
            sheet.headerRows = [0, 1, 5, totalDueRow, leftOverRow]
            sheet.freezeRows = 2
            sheet.columnWidths = (0..<width).map { index in
                switch index % 4 {
                case 0, 1: return 11
                case 2: return 22
                default: return 1.5
                }
            }
            var block = 0
            for month in months {
                try Task.checkCancellation()
                let monthNumber = Int(month.id.suffix(2))!
                let monthName = monthNames[monthNumber - 1]
                for window in month.windows {
                    let column = block * 4
                    let dateLabel = "\(monthName) \(year) · Days \(window.startDay)–\(window.endDay)"
                    let paydayLabel = window.payDay.map { "Payday \(monthName) \($0)" } ?? "Payday not set"
                    sheet.rows[0][column] = .text(dateLabel + " · " + paydayLabel)
                    sheet.mergedRanges.append("\(columnName(column))1:\(columnName(column + 2))1")
                    for row in [1, 5] {
                        sheet.rows[row][column] = .text("Projected")
                        sheet.rows[row][column + 1] = .text("Actual")
                        sheet.rows[row][column + 2] = .text("Line Item")
                    }
                    sheet.rows[2][column + 2] = .text("Income")
                    sheet.rows[3][column + 2] = .text("Additional income")
                    sheet.rows[4][column + 2] = .text("Savings withdrawals")
                    sheet.rows[totalDueRow][column + 2] = .text("Total Due")
                    sheet.rows[leftOverRow][column + 2] = .text("Left Over")
                    let transactions = month.transactions(in: window)
                    let projected = month.periods[window.index].budgeted
                    let actual = month.periods[window.index].realistic
                    let pairs: [(BudgetPlan, [ReportedExpense])] = [(projected, []), (actual, transactions)]
                    for (offset, pair) in pairs.enumerated() {
                        let (plan, reported) = pair
                        let currentColumn = column + offset
                        let summary = BudgetSummary(plan: plan, transactions: reported)
                        sheet.rows[2][currentColumn] = rawMoney(plan.payroll)
                        sheet.rows[3][currentColumn] = rawMoney(plan.extra)
                        sheet.rows[4][currentColumn] = rawMoney(plan.savingsWithdrawn)
                        let logged = reported.reduce(into: [String: Decimal]()) {
                            $0[$1.category, default: .zero] += $1.amount
                        }
                        var manualByCategory: [String: Decimal] = [:]
                        var enteredCategories = Set<String>()
                        for entry in plan.expenses {
                            manualByCategory[entry.name, default: .zero] += moneyValue(entry.amount)
                            if !entry.amount.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                enteredCategories.insert(entry.name)
                            }
                        }
                        for (lineIndex, line) in expenseLines.enumerated() {
                            let row = lineIndex + 6
                            sheet.rows[row][column + 2] = .text(line.label)
                            if let category = line.category {
                                let hasManual = enteredCategories.contains(category)
                                let hasReported = logged[category] != nil
                                if hasManual || hasReported {
                                    let manual = manualByCategory[category] ?? .zero
                                    sheet.rows[row][currentColumn] = .money(-(manual + (logged[category] ?? .zero)))
                                }
                            } else if !plan.savings.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                sheet.rows[row][currentColumn] = .money(-moneyValue(plan.savings))
                            }
                        }
                        sheet.rows[totalDueRow][currentColumn] = .money(-(summary.totalExpenses + summary.totalSavings))
                        sheet.rows[leftOverRow][currentColumn] = .money(summary.remaining)
                    }
                    let hasActual = !transactions.isEmpty
                        || ([actual.payroll, actual.extra, actual.savings, actual.savingsWithdrawn]
                            + actual.expenses.map(\.amount)).contains {
                            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        }
                    let hasProjected = ([projected.payroll, projected.extra, projected.savings, projected.savingsWithdrawn]
                        + projected.expenses.map(\.amount)).contains {
                        !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    }
                    if hasActual && hasProjected {
                        sheet.comparisons.append(Comparison(
                            actualCell: columnName(column + 1) + String(leftOverRow + 1),
                            projectedCell: columnName(column) + String(leftOverRow + 1)))
                    }
                    block += 1
                }
            }
            return sheet
        }
    }

    private static func validate(_ months: [MonthlyBudget]) throws {
        guard Set(months.map(\.id)).count == months.count else {
            throw ExcelExportError.invalidData("The selection contains a duplicate month.")
        }
        var transactionIDs = Set<UUID>()
        for month in months {
            try Task.checkCancellation()
            let parts = month.id.split(separator: "-", omittingEmptySubsequences: false)
            guard parts.count == 2, parts[0].count == 4, parts[1].count == 2,
                  let year = Int(parts[0]), (1...9999).contains(year),
                  let number = Int(parts[1]), (1...12).contains(number),
                  String(format: "%04d-%02d", year, number) == month.id,
                  BudgetDates.bounds(for: month.id) != nil else {
                throw ExcelExportError.invalidData("A selected month has an invalid calendar identifier.")
            }
            guard month.periods.count == month.paySchedule.frequency.requiredDateCount,
                  month.paySchedule.days.isEmpty || month.paySchedule.isValid(for: month.id) else {
                throw ExcelExportError.invalidData("Correct the pay schedule for \(month.id).")
            }
            for plan in month.realisticPlans + month.budgetedPlans {
                guard !plan.hasInvalidAmounts else {
                    throw ExcelExportError.invalidData("Correct invalid amounts in \(month.id) before exporting.")
                }
                guard plan.expenses.count <= 1_000 else { throw ExcelExportError.tooLarge }
                for text in [plan.payroll, plan.extra, plan.savings, plan.savingsWithdrawn] + plan.expenses.map(\.amount) {
                    try validateMoney(moneyValue(text))
                }
            }
            for transaction in month.transactions {
                guard transactionIDs.insert(transaction.id).inserted,
                      (1...BudgetDates.dayCount(in: month.id)).contains(transaction.dayOfMonth),
                      transaction.amount > .zero,
                      !transaction.category.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw ExcelExportError.invalidData("Correct an invalid or duplicate transaction in \(month.id).")
                }
                try validateMoney(transaction.amount)
            }
        }
    }

    private static func validateMoney(_ amount: Decimal) throws {
        guard !amount.isNaN, amount >= -maximumMoney, amount <= maximumMoney else {
            throw ExcelExportError.invalidData("An amount is outside Excel's supported precision. Reduce its size to preserve cents.")
        }
        var original = amount
        var rounded = Decimal.zero
        NSDecimalRound(&rounded, &original, 2, .plain)
        guard rounded == amount else {
            throw ExcelExportError.invalidData("An amount has more than two decimal places.")
        }
    }

    private static func rawMoney(_ input: String) -> Cell {
        input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .blank : .money(moneyValue(input))
    }

    private enum Cell {
        case text(String), money(Decimal), number(Decimal), blank
    }

    private struct Comparison {
        let actualCell: String
        let projectedCell: String
    }

    private struct Sheet {
        let name: String
        var rows: [[Cell]]
        var isYearlyOverview = false
        var headerRows: Set<Int> = [0]
        var columnWidths: [Double]? = nil
        var mergedRanges: [String] = []
        var comparisons: [Comparison] = []
        var freezeRows = 1

        init(name: String, headers: [String]) {
            self.name = name
            rows = [headers.map { .text($0) }]
        }
    }

    private static func workbook(_ sheets: [Sheet]) throws -> Data {
        let xmlHeader = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
        let spreadsheetNS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        let relationshipNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        let packageNS = "http://schemas.openxmlformats.org/package/2006/relationships"
        var archive = StoredZIP(maximumBytes: maximumBytes)
        let overrides = sheets.indices.map {
            "<Override PartName=\"/xl/worksheets/sheet\($0 + 1).xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
        }.joined()
        try archive.add("[Content_Types].xml", text: xmlHeader + "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>" + overrides + "</Types>")
        try archive.add("_rels/.rels", text: xmlHeader + "<Relationships xmlns=\"\(packageNS)\"><Relationship Id=\"rId1\" Type=\"\(relationshipNS)/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>")
        let sheetDefinitions = try sheets.enumerated().map { index, sheet in
            "<sheet name=\"\(try xml(sheet.name))\" sheetId=\"\(index + 1)\" r:id=\"rId\(index + 1)\"/>"
        }.joined()
        try archive.add("xl/workbook.xml", text: xmlHeader + "<workbook xmlns=\"\(spreadsheetNS)\" xmlns:r=\"\(relationshipNS)\"><sheets>" + sheetDefinitions + "</sheets></workbook>")
        let sheetRelationships = sheets.indices.map {
            "<Relationship Id=\"rId\($0 + 1)\" Type=\"\(relationshipNS)/worksheet\" Target=\"worksheets/sheet\($0 + 1).xml\"/>"
        }.joined()
        try archive.add("xl/_rels/workbook.xml.rels", text: xmlHeader + "<Relationships xmlns=\"\(packageNS)\">" + sheetRelationships + "<Relationship Id=\"rId\(sheets.count + 1)\" Type=\"\(relationshipNS)/styles\" Target=\"styles.xml\"/></Relationships>")
        try archive.add("xl/styles.xml", text: xmlHeader + stylesXML(namespace: spreadsheetNS))
        for (sheetIndex, sheet) in sheets.enumerated() {
            try Task.checkCancellation()
            guard sheet.rows.count <= 1_048_576 else { throw ExcelExportError.tooLarge }
            let columnCount = sheet.rows.first?.count ?? 1
            guard (1...16_384).contains(columnCount) else { throw ExcelExportError.tooLarge }
            let lastCell = columnName(columnCount - 1) + String(sheet.rows.count)
            var document = xmlHeader + "<worksheet xmlns=\"\(spreadsheetNS)\"><dimension ref=\"A1:\(lastCell)\"/><sheetViews><sheetView workbookViewId=\"0\">"
            if sheet.freezeRows > 0 {
                document += "<pane ySplit=\"\(sheet.freezeRows)\" topLeftCell=\"A\(sheet.freezeRows + 1)\" activePane=\"bottomLeft\" state=\"frozen\"/>"
            }
            document += "</sheetView></sheetViews><sheetFormatPr defaultRowHeight=\"\(sheet.isYearlyOverview ? 18 : 15)\"/><cols>"
            if let widths = sheet.columnWidths {
                for (index, width) in widths.enumerated() {
                    document += "<col min=\"\(index + 1)\" max=\"\(index + 1)\" width=\"\(width)\" customWidth=\"1\"/>"
                }
            } else {
                document += "<col min=\"1\" max=\"\(columnCount)\" width=\"22\" customWidth=\"1\"/>"
            }
            document += "</cols><sheetData>"
            for (rowIndex, row) in sheet.rows.enumerated() {
                if rowIndex % 256 == 0 { try Task.checkCancellation() }
                let header = sheet.headerRows.contains(rowIndex)
                let height = sheet.isYearlyOverview && header
                    ? " ht=\"\(rowIndex == 0 ? 42 : 22)\" customHeight=\"1\"" : ""
                document += "<row r=\"\(rowIndex + 1)\"\(height)>"
                for (column, cell) in row.enumerated() {
                    let reference = columnName(column) + String(rowIndex + 1)
                    switch cell {
                    case .blank:
                        if sheet.isYearlyOverview && header && column % 4 != 3 {
                            document += "<c r=\"\(reference)\" s=\"5\"/>"
                        }
                    case .text(let value):
                        let style = sheet.isYearlyOverview ? (header ? 5 : 3) : (header ? 1 : 0)
                        document += "<c r=\"\(reference)\" t=\"inlineStr\" s=\"\(style)\"><is><t xml:space=\"preserve\">\(try xml(value))</t></is></c>"
                    case .money(let value), .number(let value):
                        try validateMoney(value)
                        let style: Int
                        if sheet.isYearlyOverview {
                            if case .money = cell { style = header ? 6 : 4 } else { style = header ? 5 : 3 }
                        } else {
                            if case .money = cell { style = 2 } else { style = 0 }
                        }
                        document += "<c r=\"\(reference)\" s=\"\(style)\"><v>\(NSDecimalNumber(decimal: value).stringValue)</v></c>"
                    }
                }
                document += "</row>"
                if document.utf8.count > maximumBytes { throw ExcelExportError.tooLarge }
            }
            document += "</sheetData>"
            if !sheet.isYearlyOverview && sheet.rows.count > 1 && sheet.name != "Read Me" {
                document += "<autoFilter ref=\"A1:\(lastCell)\"/>"
            }
            if !sheet.mergedRanges.isEmpty {
                document += "<mergeCells count=\"\(sheet.mergedRanges.count)\">"
                for range in sheet.mergedRanges { document += "<mergeCell ref=\"\(range)\"/>" }
                document += "</mergeCells>"
            }
            for (index, comparison) in sheet.comparisons.enumerated() {
                document += "<conditionalFormatting sqref=\"\(comparison.actualCell)\"><cfRule type=\"cellIs\" dxfId=\"0\" priority=\"\(index * 2 + 1)\" operator=\"lessThan\"><formula>\(comparison.projectedCell)</formula></cfRule><cfRule type=\"cellIs\" dxfId=\"1\" priority=\"\(index * 2 + 2)\" operator=\"greaterThanOrEqual\"><formula>\(comparison.projectedCell)</formula></cfRule></conditionalFormatting>"
            }
            document += "</worksheet>"
            try archive.add("xl/worksheets/sheet\(sheetIndex + 1).xml", text: document)
        }
        return try archive.finish()
    }

    private static func stylesXML(namespace: String) -> String {
        // Styles 0–2 retain the original detail-table definitions. Styles 3–6
        // apply only to the calendar-year layout and use Calibri 12, centered.
        """
        <styleSheet xmlns="\(namespace)">
        <numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;[Red]-#,##0.00"/></numFmts>
        <fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><sz val="12"/><name val="Calibri"/></font><font><b/><sz val="12"/><name val="Calibri"/></font></fonts>
        <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill></fills>
        <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
        <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
        <cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="2" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1" applyNumberFormat="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="3" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="2" fontId="3" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1" applyNumberFormat="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs>
        <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
        <dxfs count="2"><dxf><fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill></dxf><dxf><fill><patternFill patternType="solid"><fgColor rgb="FFC5E0B4"/><bgColor indexed="64"/></patternFill></fill></dxf></dxfs>
        </styleSheet>
        """
    }

    private static func columnName(_ index: Int) -> String {
        var value = index + 1
        var name = ""
        while value > 0 {
            value -= 1
            name = String(UnicodeScalar(65 + value % 26)!) + name
            value /= 26
        }
        return name
    }

    private static func xml(_ text: String) throws -> String {
        guard text.utf16.count <= 32_767 else {
            throw ExcelExportError.invalidData("A text field exceeds Excel's cell limit. Shorten it or exclude transaction notes.")
        }
        var scalars = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 0x9, 0xA, 0xD, 0x20...0xD7FF, 0xE000...0xFFFD, 0x10000...0x10FFFF:
                scalars.append(scalar)
            default: break // XML 1.0 cannot represent these control characters.
            }
        }
        return String(scalars).replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }

    // ZIP method 0 (stored) requires no compression framework or dependency.
    // Only fixed package paths are used. CRC32 covers every XML part.
    private struct StoredZIP {
        let maximumBytes: Int
        private var data = Data()
        private var directory = Data()
        private var count: UInt16 = 0
        private static let crcTable: [UInt32] = (0..<256).map { index in
            var value = UInt32(index)
            for _ in 0..<8 {
                value = (value >> 1) ^ ((value & 1) == 1 ? 0xEDB88320 : 0)
            }
            return value
        }

        init(maximumBytes: Int) { self.maximumBytes = maximumBytes }

        mutating func add(_ path: String, text: String) throws {
            try Task.checkCancellation()
            let name = Data(path.utf8)
            let content = Data(text.utf8)
            guard name.count <= Int(UInt16.max), content.count <= Int(UInt32.max),
                  data.count <= Int(UInt32.max), count < UInt16.max,
                  data.count + directory.count + content.count + name.count * 2 + 98 <= maximumBytes else {
                throw ExcelExportError.tooLarge
            }
            let offset = UInt32(data.count)
            let size = UInt32(content.count)
            let crc = try crc32(content)
            data.le32(0x04034B50)
            data.le16(20); data.le16(0); data.le16(0)
            data.le16(0); data.le16(0x0021) // 1980-01-01; report timestamp is in Read Me.
            data.le32(crc); data.le32(size); data.le32(size)
            data.le16(UInt16(name.count)); data.le16(0)
            data.append(name); data.append(content)
            directory.le32(0x02014B50)
            directory.le16(20); directory.le16(20)
            directory.le16(0); directory.le16(0)
            directory.le16(0); directory.le16(0x0021)
            directory.le32(crc); directory.le32(size); directory.le32(size)
            directory.le16(UInt16(name.count)); directory.le16(0); directory.le16(0)
            directory.le16(0); directory.le16(0); directory.le32(0); directory.le32(offset)
            directory.append(name)
            count += 1
        }

        mutating func finish() throws -> Data {
            try Task.checkCancellation()
            guard data.count + directory.count + 22 <= maximumBytes,
                  directory.count <= Int(UInt32.max), data.count <= Int(UInt32.max) else {
                throw ExcelExportError.tooLarge
            }
            let offset = UInt32(data.count)
            let size = UInt32(directory.count)
            data.append(directory)
            data.le32(0x06054B50)
            data.le16(0); data.le16(0); data.le16(count); data.le16(count)
            data.le32(size); data.le32(offset); data.le16(0)
            return data
        }

        private func crc32(_ content: Data) throws -> UInt32 {
            var crc: UInt32 = 0xFFFFFFFF
            var processed = 0
            for byte in content {
                crc = (crc >> 8) ^ Self.crcTable[Int((crc ^ UInt32(byte)) & 0xFF)]
                processed += 1
                if processed % 65_536 == 0 { try Task.checkCancellation() }
            }
            return crc ^ 0xFFFFFFFF
        }
    }
}

private extension Data {
    mutating func le16(_ value: UInt16) {
        append(UInt8(truncatingIfNeeded: value))
        append(UInt8(truncatingIfNeeded: value >> 8))
    }

    mutating func le32(_ value: UInt32) {
        append(UInt8(truncatingIfNeeded: value))
        append(UInt8(truncatingIfNeeded: value >> 8))
        append(UInt8(truncatingIfNeeded: value >> 16))
        append(UInt8(truncatingIfNeeded: value >> 24))
    }
}
