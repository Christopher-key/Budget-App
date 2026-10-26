import SwiftUI
import Combine
import UIKit
import CryptoKit
import Charts

// MARK: - Offline, backup-excluded local storage

enum LocalFileError: LocalizedError {
    case invalidSettings, unavailableDirectory

    var errorDescription: String? {
        "Local app data could not be read or saved. Close and reopen the app. No online service is used to recover this data."
    }
}

enum AppLocalFiles {
    static func directoryURL() throws -> URL {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory,
                                                     in: .userDomainMask).first else {
            throw LocalFileError.unavailableDirectory
        }
        var directory = support.appendingPathComponent("MyBudget", isDirectory: true)
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory) {
            guard isDirectory.boolValue else { throw LocalFileError.unavailableDirectory }
        } else {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                   attributes: [.protectionKey: FileProtectionType.complete])
        }
        // Exclude the parent BEFORE writing, including atomic temporary files.
        if try directory.resourceValues(forKeys: [.isExcludedFromBackupKey])
            .isExcludedFromBackup != true {
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try directory.setResourceValues(values)
        }
        directory.removeCachedResourceValue(forKey: .isExcludedFromBackupKey)
        guard try directory.resourceValues(forKeys: [.isExcludedFromBackupKey])
            .isExcludedFromBackup == true else { throw LocalFileError.unavailableDirectory }
        return directory
    }

    static func url(for name: String) throws -> URL {
        try directoryURL().appendingPathComponent(name)
    }

    static func isMissingFile(_ error: Error) -> Bool {
        let error = error as NSError
        return error.domain == NSCocoaErrorDomain
            && (error.code == NSFileReadNoSuchFileError || error.code == NSFileNoSuchFileError)
    }

    static func read(_ name: String) throws -> Data? {
        let file = try url(for: name)
        do {
            // Reapply the flag to existing files as well as their parent folder.
            try? excludeFromBackup(file)
            return try Data(contentsOf: file)
        } catch {
            if isMissingFile(error) { return nil }
            throw error
        }
    }

    static func write(_ data: Data, name: String) throws {
        let file = try url(for: name)
        try data.write(to: file, options: [.atomic, .completeFileProtection])
        // Parent exclusion is authoritative and was verified before writing.
        // Add a redundant file flag, but do not report a committed write as failed
        // if only this extra flag cannot be applied.
        try? excludeFromBackup(file)
    }

    static func delete(_ name: String) throws {
        do {
            try FileManager.default.removeItem(at: url(for: name))
        } catch {
            if !isMissingFile(error) { throw error }
        }
    }

    private static func excludeFromBackup(_ file: URL) throws {
        var file = file
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try file.setResourceValues(values)
        guard try file.resourceValues(forKeys: [.isExcludedFromBackupKey])
            .isExcludedFromBackup == true else { throw LocalFileError.unavailableDirectory }
    }
}

// A small app-only preferences store. UserDefaults is read solely to migrate
// older versions, then those old app-owned keys are removed after a safe write.
final class LocalPreferences: ObservableObject {
    static let shared = LocalPreferences()
    @Published private(set) var errorMessage: String? = nil
    private var values: [String: Any] = [:]
    private var canWrite = true

    private init() {
        do {
            if let data = try AppLocalFiles.read("settings.plist") {
                guard let loaded = try PropertyListSerialization.propertyList(
                    from: data, options: [], format: nil) as? [String: Any] else {
                    throw LocalFileError.invalidSettings
                }
                values = loaded
            } else {
                values = UserDefaults.standard.dictionaryRepresentation()
                    .filter { $0.key.hasPrefix("MyBudget.") }
            }
            // Confirm a protected, backup-excluded copy before deleting legacy data.
            try persist(values)
            removeLegacySettings()
        } catch {
            canWrite = false
            errorMessage = "Local data could not be loaded safely. Existing saved files have been retained. Close and reopen the app before trying again."
        }
    }

    func data(forKey key: String) -> Data? { values[key] as? Data }
    func object(forKey key: String) -> Any? { values[key] }
    func integer(forKey key: String) -> Int { (values[key] as? NSNumber)?.intValue ?? 0 }
    func dictionaryRepresentation() -> [String: Any] { values }

    func set(_ value: Any?, forKey key: String) {
        if let value = value {
            update([key: value])
        } else {
            removeObject(forKey: key)
        }
    }

    func removeObject(forKey key: String) {
        update([:], removing: [key])
    }

    // Related lock metadata commits together. Unchanged values cause no disk write.
    func update(_ changes: [String: Any], removing keys: [String] = []) {
        guard canWrite else { return }
        var updated = values
        var hasChanges = false
        for (key, value) in changes {
            if let existing = values[key] as? NSObject, existing.isEqual(value) { continue }
            updated[key] = value
            hasChanges = true
        }
        for key in keys {
            if updated.removeValue(forKey: key) != nil { hasChanges = true }
        }
        if hasChanges { commit(updated) }
    }

    func reset() throws {
        do {
            try persist([:])
            values = [:]
            removeLegacySettings()
            canWrite = true
            errorMessage = nil
        } catch {
            canWrite = false
            errorMessage = "The reset did not complete. Close and reopen the app before trying again."
            throw error
        }
    }

    private func commit(_ updated: [String: Any]) {
        guard canWrite else { return }
        do {
            try persist(updated)
            values = updated
        } catch {
            canWrite = false
            errorMessage = "The latest changes could not be saved safely. Close and reopen the app. Do not assume those changes were saved."
        }
    }

    private func persist(_ updated: [String: Any]) throws {
        let data = try PropertyListSerialization.data(fromPropertyList: updated,
                                                     format: .binary, options: 0)
        try AppLocalFiles.write(data, name: "settings.plist")
    }

    private func removeLegacySettings() {
        let legacy = UserDefaults.standard
        for key in legacy.dictionaryRepresentation().keys where key.hasPrefix("MyBudget.") {
            legacy.removeObject(forKey: key)
        }
    }
}

// MARK: - Saved budget data

let expenseCategories = [
    "Home", "Electric", "Gas", "Credit Card", "Misc.",
    "Car", "Insurance", "Phone", "Going-out", "Grocery"
]

struct ExpenseEntry: Identifiable, Codable {
    var id = UUID()
    let name: String
    var amount = ""
}

enum BudgetDates {
    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar
    }

    static func day(of date: Date) -> Int { calendar.component(.day, from: date) }

    static func bounds(for monthID: String) -> (start: Date, end: Date)? {
        let parts = monthID.split(separator: "-")
        guard parts.count == 2, let year = Int(parts[0]), let month = Int(parts[1]),
              (1...12).contains(month),
              let start = calendar.date(from: DateComponents(year: year, month: month, day: 1)),
              let end = calendar.date(byAdding: .month, value: 1, to: start) else { return nil }
        return (start, end)
    }

    static func dayCount(in monthID: String) -> Int {
        guard let bounds = bounds(for: monthID) else { return 31 }
        return calendar.range(of: .day, in: .month, for: bounds.start)?.count ?? 31
    }
}

enum PayFrequency: String, Codable, CaseIterable, Identifiable {
    case monthly, biWeekly, weekly
    var id: String { rawValue }

    var title: String {
        switch self {
        case .monthly: return "Monthly"
        case .biWeekly: return "Bi-Weekly"
        case .weekly: return "Weekly"
        }
    }

    var requiredDateCount: Int {
        switch self {
        case .monthly: return 1
        case .biWeekly: return 2
        case .weekly: return 4
        }
    }
}

struct BudgetWindow: Identifiable {
    let index: Int
    let startDay: Int
    let endDay: Int
    let payDay: Int?
    var id: Int { index }
    var title: String { "\(startDay)–\(endDay)" }
    func contains(day: Int) -> Bool { (startDay...endDay).contains(day) }
}

struct PaySchedule: Codable, Equatable {
    var frequency: PayFrequency = .biWeekly
    var days: [Int] = []

    func isValid(for monthID: String) -> Bool {
        days.count == frequency.requiredDateCount && Set(days).count == days.count
            && days.allSatisfy { (1...BudgetDates.dayCount(in: monthID)).contains($0) }
    }

    func windows(for monthID: String) -> [BudgetWindow] {
        let selected = days.sorted()
        let configured = isValid(for: monthID)
        let starts: [Int]
        if configured {
            // The first section includes days before the first payday so all
            // spending still belongs to one and only one calendar-month section.
            starts = [1] + Array(selected.dropFirst())
        } else {
            switch frequency {
            case .monthly: starts = [1]
            case .biWeekly: starts = [1, 15]
            case .weekly: starts = [1, 8, 15, 22]
            }
        }
        return starts.enumerated().map { index, start in
            BudgetWindow(index: index, startDay: start,
                         endDay: index + 1 < starts.count ? starts[index + 1] - 1 : BudgetDates.dayCount(in: monthID),
                         payDay: configured ? selected[index] : nil)
        }
    }
}

struct BudgetPlan: Codable {
    var payroll = ""
    var extra = ""
    var savings = ""
    var savingsWithdrawn = ""
    var expenses = expenseCategories.map { ExpenseEntry(name: $0) }

    init() {}

    // Older saved budgets have no withdrawal field. Treat it as zero
    // so updating the app keeps all previously entered months.
    private enum CodingKeys: String, CodingKey {
        case payroll, extra, savings, savingsWithdrawn, expenses
    }

    init(from decoder: Decoder) throws {
        self.init()
        let values = try decoder.container(keyedBy: CodingKeys.self)
        payroll = try values.decode(String.self, forKey: .payroll)
        extra = try values.decode(String.self, forKey: .extra)
        savings = try values.decode(String.self, forKey: .savings)
        savingsWithdrawn = try values.decodeIfPresent(String.self, forKey: .savingsWithdrawn) ?? ""
        expenses = try values.decode([ExpenseEntry].self, forKey: .expenses)
    }

    var totalIncome: Decimal {
        moneyValue(payroll) + moneyValue(extra)
    }

    var totalExpenses: Decimal {
        expenses.reduce(Decimal.zero) { $0 + moneyValue($1.amount) }
    }

    var totalSavings: Decimal { moneyValue(savings) }
    var totalWithdrawn: Decimal { moneyValue(savingsWithdrawn) }
    var netSavings: Decimal { totalSavings - totalWithdrawn }

    var remaining: Decimal {
        totalIncome + totalWithdrawn - totalExpenses - totalSavings
    }

    var hasInvalidAmounts: Bool {
        ([payroll, extra, savings, savingsWithdrawn] + expenses.map(\.amount))
            .contains { parsedMoney($0) == nil }
    }

    func combined(with other: BudgetPlan) -> BudgetPlan? {
        guard !hasInvalidAmounts, !other.hasInvalidAmounts else { return nil }
        func add(_ lhs: String, _ rhs: String) -> String {
            if lhs.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && rhs.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "" }
            return editableMoney(moneyValue(lhs) + moneyValue(rhs))
        }
        var result = self
        result.payroll = add(payroll, other.payroll)
        result.extra = add(extra, other.extra)
        result.savings = add(savings, other.savings)
        result.savingsWithdrawn = add(savingsWithdrawn, other.savingsWithdrawn)
        for expense in other.expenses {
            if let index = result.expenses.firstIndex(where: { $0.name == expense.name }) {
                result.expenses[index].amount = add(result.expenses[index].amount, expense.amount)
            } else {
                result.expenses.append(expense)
            }
        }
        return result
    }
}

struct MonthlyBudget: Identifiable, Codable {
    let id: String
    let date: Date
    var periods = [PeriodBudget(), PeriodBudget()]
    var paySchedule = PaySchedule()
    var transactions: [ReportedExpense] = []

    init(id: String, date: Date) {
        self.id = id
        self.date = date
    }

    private enum CodingKeys: String, CodingKey {
        case id, date, periods, realistic, budgeted, secondRealistic, secondBudgeted, paySchedule, transactions
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        date = try values.decode(Date.self, forKey: .date)
        paySchedule = try values.decodeIfPresent(PaySchedule.self, forKey: .paySchedule) ?? PaySchedule()
        if let saved = try values.decodeIfPresent([PeriodBudget].self, forKey: .periods) {
            guard saved.count == paySchedule.frequency.requiredDateCount else {
                throw DecodingError.dataCorruptedError(forKey: .periods, in: values,
                    debugDescription: "Budget period count does not match its pay schedule.")
            }
            periods = saved
        } else {
            // Old monthly amounts become the first section. Additional sections
            // start blank, preserving the original monthly totals.
            let first = PeriodBudget(
                realistic: try values.decode(BudgetPlan.self, forKey: .realistic),
                budgeted: try values.decode(BudgetPlan.self, forKey: .budgeted))
            let second = PeriodBudget(
                realistic: try values.decodeIfPresent(BudgetPlan.self, forKey: .secondRealistic) ?? BudgetPlan(),
                budgeted: try values.decodeIfPresent(BudgetPlan.self, forKey: .secondBudgeted) ?? BudgetPlan())
            periods = [first, second]
            paySchedule.frequency = .biWeekly
        }
        transactions = try values.decodeIfPresent([ReportedExpense].self, forKey: .transactions) ?? []
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(date, forKey: .date)
        try values.encode(periods, forKey: .periods)
        try values.encode(paySchedule, forKey: .paySchedule)
        try values.encode(transactions, forKey: .transactions)
    }

    var realisticSummary: BudgetSummary {
        BudgetSummary(plans: realisticPlans, transactions: transactions)
    }

    var budgetedSummary: BudgetSummary {
        BudgetSummary(plans: budgetedPlans)
    }

    var realisticPlans: [BudgetPlan] { periods.map(\.realistic) }
    var budgetedPlans: [BudgetPlan] { periods.map(\.budgeted) }
    var windows: [BudgetWindow] { paySchedule.windows(for: id) }

    func transactions(in window: BudgetWindow) -> [ReportedExpense] {
        transactions.filter { window.contains(day: $0.dayOfMonth) }
    }

    func realisticSummary(for window: BudgetWindow) -> BudgetSummary {
        BudgetSummary(plan: periods[window.index].realistic,
                      transactions: transactions(in: window))
    }

    func budgetedSummary(for window: BudgetWindow) -> BudgetSummary {
        BudgetSummary(plan: periods[window.index].budgeted)
    }

    mutating func applyPaySchedule(_ schedule: PaySchedule) -> Bool {
        guard schedule.isValid(for: id) else { return false }
        let count = schedule.frequency.requiredDateCount
        var updated = periods
        if count < updated.count {
            // Keep monthly totals when reducing the number of sections. Merge
            // removed sections into the last retained one rather than dropping data.
            var last = updated[count - 1]
            for extra in updated.dropFirst(count) {
                guard let realistic = last.realistic.combined(with: extra.realistic),
                      let budgeted = last.budgeted.combined(with: extra.budgeted) else { return false }
                last = PeriodBudget(realistic: realistic, budgeted: budgeted)
            }
            updated = Array(updated.prefix(count))
            updated[count - 1] = last
        } else {
            while updated.count < count { updated.append(PeriodBudget()) }
        }
        periods = updated
        paySchedule = schedule
        paySchedule.days.sort()
        return true
    }

    var title: String {
        date.formatted(.dateTime.month(.wide).year())
    }
}

struct PeriodBudget: Codable {
    var realistic = BudgetPlan()
    var budgeted = BudgetPlan()
}

struct ReportedExpense: Identifiable, Codable {
    var id = UUID()
    var date = Date() {
        didSet { dayOfMonth = BudgetDates.day(of: date) }
    }
    // Persist the period chosen by the expense's local date so changing device
    // timezones later does not silently move it between budget periods.
    var dayOfMonth = BudgetDates.day(of: Date())
    var category = "Home"
    var amount = Decimal.zero
    var note = ""

    init() { dayOfMonth = BudgetDates.day(of: date) }

    private enum CodingKeys: String, CodingKey {
        case id, date, dayOfMonth, category, amount, note
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(UUID.self, forKey: .id)
        date = try values.decode(Date.self, forKey: .date)
        dayOfMonth = try values.decodeIfPresent(Int.self, forKey: .dayOfMonth)
            ?? BudgetDates.day(of: date)
        guard (1...31).contains(dayOfMonth) else {
            throw DecodingError.dataCorruptedError(forKey: .dayOfMonth, in: values,
                debugDescription: "Transaction day must be between 1 and 31.")
        }
        category = try values.decode(String.self, forKey: .category)
        amount = try values.decode(Decimal.self, forKey: .amount)
        note = try values.decode(String.self, forKey: .note)
    }
}

// Calculate with Decimal values directly. Logged expenses never overwrite
// the manually entered amounts or change the budgeted plan.
struct BudgetSummary {
    let totalIncome: Decimal
    let totalExpenses: Decimal
    let totalSavings: Decimal
    let totalWithdrawn: Decimal
    let hasInvalidAmounts: Bool

    init(plan: BudgetPlan, transactions: [ReportedExpense] = []) {
        self.init(plans: [plan], transactions: transactions)
    }

    init(plans: [BudgetPlan], transactions: [ReportedExpense] = []) {
        var income = Decimal.zero
        var expenses = Decimal.zero
        var savings = Decimal.zero
        var withdrawn = Decimal.zero
        var invalid = false
        func amount(_ text: String) -> Decimal {
            guard let value = parsedMoney(text) else {
                invalid = true
                return .zero
            }
            return value
        }
        // Parse each field once for both its value and validation.
        for plan in plans {
            income += amount(plan.payroll) + amount(plan.extra)
            expenses += plan.expenses.reduce(Decimal.zero) { $0 + amount($1.amount) }
            savings += amount(plan.savings)
            withdrawn += amount(plan.savingsWithdrawn)
        }
        totalIncome = income
        totalExpenses = expenses + transactions.reduce(Decimal.zero) { $0 + $1.amount }
        totalSavings = savings
        totalWithdrawn = withdrawn
        hasInvalidAmounts = invalid
    }

    var remaining: Decimal {
        totalIncome + totalWithdrawn - totalExpenses - totalSavings
    }
}

// MARK: - Calendar-year spending comparison

struct AnnualBudgetPoint: Identifiable {
    let id: String
    let year: Int
    let month: Int
    let budgetedExpenses: Decimal
    let realisticExpenses: Decimal

    var variance: Decimal { budgetedExpenses - realisticExpenses }
    var metBudget: Bool { variance >= .zero }
    var plotValue: Double { NSDecimalNumber(decimal: variance).doubleValue }
    var monthName: String { AnnualBudgetComparison.monthNames[month - 1] }
}

struct AnnualBudgetSegment: Identifiable {
    let id: String
    let year: Int
    let points: [AnnualBudgetPoint]
}

enum AnnualBudgetComparison {
    static let monthNames = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
    ]

    static func components(of identifier: String) -> (year: Int, month: Int)? {
        let parts = identifier.split(separator: "-")
        guard parts.count == 2, let year = Int(parts[0]), let month = Int(parts[1]),
              (1...12).contains(month) else { return nil }
        return (year, month)
    }

    static func points(months: [MonthlyBudget], currentMonthID: String) -> [AnnualBudgetPoint] {
        guard let current = components(of: currentMonthID) else { return [] }
        return months.compactMap { record -> AnnualBudgetPoint? in
            guard let date = components(of: record.id),
                  date.year == current.year || date.year == current.year - 1,
                  date.year < current.year || date.month <= current.month else { return nil }

            // An untouched $0 is missing information. An explicitly entered $0
            // is a real budget/spending entry and is included.
            let budgetExpenses = record.budgetedPlans.flatMap(\.expenses)
            let actualExpenses = record.realisticPlans.flatMap(\.expenses)
            let hasBudget = budgetExpenses.contains {
                !$0.amount.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            let hasActual = !record.transactions.isEmpty || actualExpenses.contains {
                !$0.amount.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            let validBudget = budgetExpenses.allSatisfy { parsedMoney($0.amount) != nil }
            let validActual = actualExpenses.allSatisfy { parsedMoney($0.amount) != nil }
            guard hasBudget, hasActual, validBudget, validActual else { return nil }

            return AnnualBudgetPoint(
                id: record.id, year: date.year, month: date.month,
                budgetedExpenses: record.budgetedSummary.totalExpenses,
                realisticExpenses: record.realisticSummary.totalExpenses
            )
        }
        .sorted { $0.id < $1.id }
    }

    static func segments(points: [AnnualBudgetPoint]) -> [AnnualBudgetSegment] {
        var result: [AnnualBudgetSegment] = []
        let years = Set(points.map(\.year)).sorted()
        for year in years {
            let ordered = points.filter { $0.year == year }.sorted { $0.month < $1.month }
            var run: [AnnualBudgetPoint] = []
            for point in ordered {
                if let last = run.last, point.month != last.month + 1 {
                    result.append(AnnualBudgetSegment(id: run[0].id, year: year, points: run))
                    run = []
                }
                run.append(point)
            }
            if let first = run.first {
                result.append(AnnualBudgetSegment(id: first.id, year: year, points: run))
            }
        }
        return result
    }
}

// Accepts the user's decimal separator and grouping separator.
func moneyValue(_ text: String) -> Decimal {
    parsedMoney(text) ?? .zero
}

func parsedMoney(_ text: String) -> Decimal? {
    let locale = Locale.current
    var cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if cleaned.isEmpty { return .zero }
    if let separator = locale.groupingSeparator, !separator.isEmpty {
        cleaned = cleaned.replacingOccurrences(of: separator, with: "")
    }
    let decimalSeparator = locale.decimalSeparator ?? "."
    guard cleaned.allSatisfy({
        "0123456789".contains($0) || String($0) == decimalSeparator
    }) else { return nil }
    let parts = cleaned.components(separatedBy: decimalSeparator)
    guard parts.count <= 2, (parts.count == 1 || parts[1].count <= 2) else {
        return nil
    }
    return Decimal(string: cleaned, locale: locale)
}

func editableMoney(_ value: Decimal) -> String {
    let formatter = NumberFormatter()
    formatter.locale = .current
    formatter.numberStyle = .decimal
    formatter.usesGroupingSeparator = false
    formatter.maximumFractionDigits = 2
    return formatter.string(from: NSDecimalNumber(decimal: value)) ?? ""
}

final class BudgetStore: ObservableObject {
    @Published var months: [MonthlyBudget] {
        didSet { save() }
    }
    @Published private(set) var currentMonthID: String

    private let storageKey = "MyBudget.months.v1"
    private let defaults = LocalPreferences.shared

    init() {
        let savedDefaults = LocalPreferences.shared
        let key = "MyBudget.months.v1"
        currentMonthID = Self.monthID(for: Date())
        if let data = savedDefaults.data(forKey: key) {
            if let decoded = try? JSONDecoder().decode([MonthlyBudget].self, from: data) {
                months = decoded
            } else {
                // Preserve unreadable data rather than discarding it.
                let recoveryKey = key + ".recovery."
                    + UUID().uuidString
                savedDefaults.set(data, forKey: recoveryKey)
                months = []
            }
        } else {
            months = []
        }
        prepareCurrentMonth()
        // Persist migrated period records and transaction day metadata before a
        // later device timezone change could reinterpret old dates.
        save()
    }

    var currentMonthIndex: Int? {
        months.firstIndex { $0.id == currentMonthID }
    }

    var pastMonths: [MonthlyBudget] {
        months.filter { $0.id < currentMonthID }
            .sorted { $0.id > $1.id }
    }

    // Planned savings never count as money actually saved.
    var savingsBalance: Decimal? {
        var balance = Decimal.zero
        for month in months {
            for plan in month.realisticPlans {
                guard let added = parsedMoney(plan.savings),
                      let withdrawn = parsedMoney(plan.savingsWithdrawn) else {
                    return nil
                }
                balance += added - withdrawn
            }
        }
        return balance
    }

    func prepareCurrentMonth() {
        let now = Date()
        let identifier = Self.monthID(for: now)
        if !months.contains(where: { $0.id == identifier }) {
            let month = makeMonth(id: identifier, date: now)
            months.append(month)
        }
        if currentMonthID != identifier {
            currentMonthID = identifier
        }
    }

    @discardableResult
    func saveTransaction(_ transaction: ReportedExpense) -> Bool {
        guard transaction.amount > .zero,
              expenseCategories.contains(transaction.category),
              Calendar.current.startOfDay(for: transaction.date)
                <= Calendar.current.startOfDay(for: Date()) else { return false }

        var updated = months
        // On edit, remove the original contribution first, even if the
        // category or month changed. Manual expenses remain untouched.
        for index in updated.indices {
            updated[index].transactions.removeAll { $0.id == transaction.id }
        }
        let identifier = Self.monthID(for: transaction.date)
        if !updated.contains(where: { $0.id == identifier }) {
            updated.append(makeMonth(id: identifier, date: transaction.date))
        }
        guard let index = updated.firstIndex(where: { $0.id == identifier }) else {
            return false
        }
        updated[index].transactions.append(transaction)
        months = updated
        return true
    }

    func deleteTransactions(ids: Set<UUID>) {
        var updated = months
        for index in updated.indices {
            updated[index].transactions.removeAll { ids.contains($0.id) }
        }
        months = updated
    }

    @discardableResult
    func updatePaySchedule(monthID: String, schedule: PaySchedule) -> Bool {
        guard let index = months.firstIndex(where: { $0.id == monthID }) else { return false }
        var updated = months
        guard updated[index].applyPaySchedule(schedule) else { return false }
        months = updated
        if monthID == currentMonthID {
            defaults.set(schedule.frequency.rawValue, forKey: "MyBudget.payFrequency")
        }
        return defaults.errorMessage == nil
    }

    private func makeMonth(id: String, date: Date) -> MonthlyBudget {
        let saved = defaults.object(forKey: "MyBudget.payFrequency") as? String
        let frequency = saved.flatMap { PayFrequency(rawValue: $0) }
            ?? months.max(by: { $0.id < $1.id })?.paySchedule.frequency ?? .biWeekly
        var month = MonthlyBudget(id: id, date: date)
        month.paySchedule.frequency = frequency
        month.periods = (0..<frequency.requiredDateCount).map { _ in PeriodBudget() }
        return month
    }

    func eraseAllData() throws {
        // Include recovery copies, while leaving system and other apps' keys alone.
        try defaults.reset()
        let now = Date()
        let identifier = Self.monthID(for: now)
        months = [MonthlyBudget(id: identifier, date: now)]
        currentMonthID = identifier
    }

    static func monthID(for date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let parts = calendar.dateComponents([.year, .month], from: date)
        return String(format: "%04d-%02d", parts.year ?? 2000, parts.month ?? 1)
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(months) else { return }
        defaults.set(data, forKey: storageKey)
    }
}

// MARK: - Four-digit app lock

enum AppLockError: LocalizedError {
    case invalidCode, incorrectCode, waitBeforeRetrying, secureStorage, missingCode

    var errorDescription: String? {
        switch self {
        case .invalidCode: return "Enter exactly four digits, from 0 to 9."
        case .incorrectCode: return "Incorrect passcode. Please try again."
        case .waitBeforeRetrying: return "Too many attempts. Please wait before trying again."
        case .secureStorage: return "Your local passcode file could not be accessed or saved. Please try again."
        case .missingCode: return "The saved passcode is unavailable. Use Forgot passcode to erase app data and start again."
        }
    }
}

struct PasscodeRecord: Codable {
    let salt: Data
    let digest: Data

    static func isValid(_ code: String) -> Bool {
        code.utf8.count == 4 && code.utf8.allSatisfy { (48...57).contains($0) }
    }

    static func create(code: String) throws -> PasscodeRecord {
        guard isValid(code) else { throw AppLockError.invalidCode }
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<16).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        let salt = Data(bytes)
        return PasscodeRecord(salt: salt, digest: hash(code: code, salt: salt))
    }

    func matches(_ code: String) -> Bool {
        guard Self.isValid(code), salt.count == 16, digest.count == 32 else { return false }
        let candidate = Self.hash(code: code, salt: salt)
        // Compare all bytes instead of stopping at the first different byte.
        let difference = zip(candidate, digest).reduce(UInt8(0)) {
            $0 | ($1.0 ^ $1.1)
        }
        return difference == 0
    }

    private static func hash(code: String, salt: Data) -> Data {
        var input = salt
        input.append(contentsOf: code.utf8)
        return Data(SHA256.hash(data: input))
    }
}

enum PasscodeVault {
    // Entirely local to this app's sandbox. No Keychain, account, or network.
    static func read() throws -> PasscodeRecord? {
        do {
            guard let data = try AppLocalFiles.read("passcode.json") else { return nil }
            let record = try JSONDecoder().decode(PasscodeRecord.self, from: data)
            guard record.salt.count == 16, record.digest.count == 32 else {
                throw AppLockError.secureStorage
            }
            return record
        } catch {
            // Corrupt or unreadable storage must not turn the lock off.
            throw AppLockError.secureStorage
        }
    }

    static func write(_ record: PasscodeRecord) throws {
        do {
            let data = try JSONEncoder().encode(record)
            // Atomic replacement avoids partially written passcode records.
            // iOS file protection is local and does not use Keychain or a network.
            try AppLocalFiles.write(data, name: "passcode.json")
        } catch {
            throw AppLockError.secureStorage
        }
    }

    static func delete() throws {
        do {
            try AppLocalFiles.delete("passcode.json")
        } catch {
            throw AppLockError.secureStorage
        }
    }
}

final class AppLockStore: ObservableObject {
    @Published private(set) var isEnabled: Bool
    @Published private(set) var isUnlocked: Bool
    @Published private(set) var retryAfter: Date?
    @Published private(set) var storageMessage: String?

    private let defaults = LocalPreferences.shared
    private let failuresKey = "MyBudget.lock.failedAttempts"
    private let retryKey = "MyBudget.lock.retryAfter"
    private var failedAttempts: Int

    init() {
        let savedDefaults = LocalPreferences.shared
        failedAttempts = savedDefaults.integer(forKey: "MyBudget.lock.failedAttempts")
        retryAfter = savedDefaults.object(forKey: "MyBudget.lock.retryAfter") as? Date
        do {
            let enabled = try PasscodeVault.read() != nil
            isEnabled = enabled
            isUnlocked = !enabled
            storageMessage = nil
        } catch {
            // A storage error must never bypass an enabled lock.
            isEnabled = true
            isUnlocked = false
            storageMessage = error.localizedDescription
        }
    }

    func secondsUntilRetry(at date: Date) -> Int {
        max(0, Int(ceil((retryAfter ?? date).timeIntervalSince(date))))
    }

    var retryTimelineDates: [Date] {
        let now = Date()
        guard let deadline = retryAfter, deadline > now else { return [now] }
        // At most 31 entries, ending exactly at expiry. No recurring idle timer.
        return [now] + (0..<30).reversed()
            .map { deadline.addingTimeInterval(-Double($0)) }
            .filter { $0 > now }
    }

    func lock() {
        if isEnabled { isUnlocked = false }
    }

    func unlock(code: String) throws {
        try verify(code)
        isUnlocked = true
        storageMessage = nil
    }

    func enable(code: String) throws {
        guard !isEnabled else { throw AppLockError.secureStorage }
        let record = try PasscodeRecord.create(code: code)
        try PasscodeVault.write(record)
        clearFailures()
        isEnabled = true
        isUnlocked = true
        storageMessage = nil
    }

    func change(currentCode: String, newCode: String) throws {
        guard PasscodeRecord.isValid(newCode) else { throw AppLockError.invalidCode }
        try verify(currentCode)
        try PasscodeVault.write(PasscodeRecord.create(code: newCode))
    }

    func disable(currentCode: String) throws {
        try verify(currentCode)
        try erasePasscode()
    }

    func erasePasscode() throws {
        try PasscodeVault.delete()
        clearFailures()
        isEnabled = false
        isUnlocked = true
        storageMessage = nil
    }

    private func verify(_ code: String) throws {
        guard PasscodeRecord.isValid(code) else { throw AppLockError.invalidCode }
        guard secondsUntilRetry(at: Date()) == 0 else { throw AppLockError.waitBeforeRetrying }
        if retryAfter != nil { clearFailures() }
        guard let record = try PasscodeVault.read() else { throw AppLockError.missingCode }
        guard record.matches(code) else {
            failedAttempts += 1
            if failedAttempts >= 5 {
                let until = Date().addingTimeInterval(30)
                defaults.update([failuresKey: failedAttempts, retryKey: until])
                retryAfter = until
                throw AppLockError.waitBeforeRetrying
            }
            defaults.set(failedAttempts, forKey: failuresKey)
            throw AppLockError.incorrectCode
        }
        clearFailures()
    }

    private func clearFailures() {
        failedAttempts = 0
        retryAfter = nil
        defaults.update([:], removing: [failuresKey, retryKey])
    }
}

// MARK: - App entry and privacy gate

struct ContentView: View {
    @StateObject private var store = BudgetStore()
    @StateObject private var appLock = AppLockStore()
    @State private var sessionID = UUID()
    @State private var showResetFailure = false
    @State private var resetFailureMessage = ""
    @ObservedObject private var localPreferences = LocalPreferences.shared
    @Environment(\.scenePhase) private var scenePhase
    private let monthCheck = Timer.publish(every: 60, on: .main, in: .common)
        .autoconnect()

    var body: some View {
        ZStack {
            // With locking enabled, remove the entire tab presentation and its
            // sheets while inactive, rather than placing a cover beneath them.
            if let message = localPreferences.errorMessage {
                LocalStorageProblemView(message: message, onReset: eraseAndReset)
            } else if appLock.isEnabled && scenePhase != .active {
                Color(.systemBackground).ignoresSafeArea()
                VStack(spacing: 12) {
                    Image(systemName: "lock.fill").font(.largeTitle)
                    Text("My Budget").font(.title.bold())
                }
            } else if appLock.isEnabled && !appLock.isUnlocked {
                PasscodeLockView(appLock: appLock, onReset: eraseAndReset)
            } else {
                BudgetTabs(store: store, appLock: appLock, onReset: eraseAndReset)
                    .id(sessionID)
            }

        }
        .onChange(of: scenePhase) { phase in
            if phase == .active {
                store.prepareCurrentMonth()
            } else {
                // Removing the tab subtree also discards any presented edit forms.
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) { appLock.lock() }
            }
        }
        .onReceive(monthCheck) { _ in store.prepareCurrentMonth() }
        .alert("Reset incomplete", isPresented: $showResetFailure) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(resetFailureMessage + " Some data may already have been erased. Close and reopen the app before trying again.")
        }
    }

    private func eraseAndReset() {
        do {
            // Erase financial data BEFORE removing its lock. A failed data write
            // must never leave old budgets accessible without their passcode.
            try store.eraseAllData()
            sessionID = UUID()
            guard localPreferences.errorMessage == nil else {
                throw LocalFileError.invalidSettings
            }
            try appLock.erasePasscode()
        } catch {
            resetFailureMessage = error.localizedDescription
            showResetFailure = true
        }
    }
}

struct BudgetTabs: View {
    @ObservedObject var store: BudgetStore
    @ObservedObject var appLock: AppLockStore
    let onReset: () -> Void

    var body: some View {
        TabView {
            NavigationStack {
                if let index = store.currentMonthIndex {
                    HomeView(month: store.months[index], savingsBalance: store.savingsBalance)
                }
            }
            .tabItem { Label("Home", systemImage: "house.fill") }

            NavigationStack {
                if let index = store.currentMonthIndex {
                    BudgetEditorView(month: $store.months[index])
                }
            }
            .tabItem { Label("Budget", systemImage: "pencil.and.list.clipboard") }

            NavigationStack {
                TransactionsView(store: store)
            }
            .tabItem { Label("Transactions", systemImage: "list.bullet.rectangle") }

            NavigationStack {
                TrendsView(months: store.months, currentMonthID: store.currentMonthID)
            }
            .tabItem { Label("Trends", systemImage: "chart.xyaxis.line") }

            NavigationStack {
                SettingsView(store: store, appLock: appLock, onReset: onReset)
            }
            .tabItem { Label("Settings", systemImage: "gearshape.fill") }
        }
    }
}

// No bindings or text fields: Home can only display your totals.
struct HomeView: View {
    let month: MonthlyBudget
    let savingsBalance: Decimal?

    var body: some View {
        // Refresh the whole summary at minute boundaries so the active section
        // updates at midnight, not only the time-of-day greeting.
        TimelineView(.everyMinute) { context in
            let day = BudgetDates.day(of: context.date)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(greeting(at: context.date))
                        .font(.largeTitle.bold())
                        .accessibilityAddTraits(.isHeader)
                    Text(month.title)
                        .font(.title3)
                        .foregroundStyle(.secondary)

                    MonthlyRemainingCard(month: month)
                    TotalSavingsCard(balance: savingsBalance)

                    if let window = month.windows.first(where: { $0.contains(day: day) }),
                       month.periods.indices.contains(window.index) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Current Pay Period").font(.title2.bold())
                            Text("\(month.paySchedule.frequency.title) • Days \(window.title)")
                                .foregroundStyle(.secondary)
                        }
                        SummaryCard(title: "Realistic", summary: month.realisticSummary(for: window), color: .blue)
                        SummaryCard(title: "Budgeted", summary: month.budgetedSummary(for: window), color: .green)
                    }
                }
                .padding()
            }
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Home")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func greeting(at date: Date) -> String {
        switch Calendar.current.component(.hour, from: date) {
        case 0..<12: return "Good Morning"
        case 12..<17: return "Good Afternoon"
        default: return "Good Evening"
        }
    }
}

struct MonthlyRemainingCard: View {
    let month: MonthlyBudget

    var body: some View {
        let budgeted = month.budgetedSummary
        let realistic = month.realisticSummary
        VStack(alignment: .leading, spacing: 10) {
            Text("Monthly Remaining").font(.headline)
            if budgeted.hasInvalidAmounts {
                Text("Budgeted: correct invalid amounts in Budget.")
                    .foregroundStyle(.red)
            } else {
                TotalRow(title: "Budgeted remaining", amount: budgeted.remaining)
            }
            if realistic.hasInvalidAmounts {
                Text("Realistic: correct invalid amounts in Budget.")
                    .foregroundStyle(.red)
            } else {
                TotalRow(title: "Realistic remaining", amount: realistic.remaining)
            }
        }
        .font(.subheadline)
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 16))
    }
}

struct TotalSavingsCard: View {
    let balance: Decimal?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Total Savings").font(.headline)
            if let balance = balance {
                Text(balance, format: .currency(code: "USD"))
                    .font(.largeTitle.bold())
                    .foregroundStyle(balance < .zero ? Color.red : Color.primary)
                if balance < .zero {
                    Text("Withdrawals exceed the savings recorded in this app.")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            } else {
                Text("Correct invalid savings amounts to see your balance.")
                    .foregroundStyle(.red)
            }
            Text("Realistic savings added minus withdrawals, across all recorded months.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(Color(.secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 20))
    }
}

struct AnnualBudgetChart: View {
    let months: [MonthlyBudget]
    let currentMonthID: String

    private var currentYear: Int {
        AnnualBudgetComparison.components(of: currentMonthID)?.year ?? 2000
    }

    var body: some View {
        let points = AnnualBudgetComparison.points(months: months, currentMonthID: currentMonthID)
        let segments = AnnualBudgetComparison.segments(points: points)
        let extent = max(100, (points.map { abs($0.plotValue) }.max() ?? 0) * 1.2)
        VStack(alignment: .leading, spacing: 14) {
            Text("Calendar-Year Spending")
                .font(.title2.bold())
            Text("Budget minus actual expenses (USD)")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            HStack(spacing: 18) {
                yearLegend(year: currentYear, color: .orange, dashed: false)
                yearLegend(year: currentYear - 1, color: .purple, dashed: true)
            }

            Chart {
                RuleMark(y: .value("On budget", 0.0))
                    .foregroundStyle(Color.secondary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))

                ForEach(segments) { segment in
                    ForEach(segment.points) { point in
                        LineMark(
                            x: .value("Month", point.month),
                            y: .value("Budget minus actual", point.plotValue),
                            series: .value("Year segment", segment.id)
                        )
                        .foregroundStyle(segment.year == currentYear ? Color.orange : Color.purple)
                        .lineStyle(StrokeStyle(lineWidth: 2,
                            dash: segment.year == currentYear ? [] : [5, 4]))
                        .interpolationMethod(.linear)
                        .accessibilityHidden(true)
                    }
                }

                ForEach(points) { point in
                    PointMark(
                        x: .value("Month", point.month),
                        y: .value("Budget minus actual", point.plotValue)
                    )
                    .symbolSize(65)
                    .foregroundStyle(point.metBudget ? Color.green : Color.red)
                    .accessibilityLabel(Text("\(point.monthName) \(String(point.year))"))
                    .accessibilityValue(Text(
                        "\(statusDescription(for: point)). Budget \(point.budgetedExpenses.formatted(.currency(code: "USD"))), actual \(point.realisticExpenses.formatted(.currency(code: "USD"))). Difference \(point.variance.formatted(.currency(code: "USD")))."
                    ))
                }
            }
            .chartXScale(domain: 0...13)
            .chartYScale(domain: -extent...extent)
            .chartXAxis {
                AxisMarks(values: Array(1...12)) { value in
                    AxisGridLine().foregroundStyle(Color.secondary.opacity(0.15))
                    AxisValueLabel {
                        if let month = value.as(Int.self), (1...12).contains(month) {
                            Text(AnnualBudgetComparison.monthNames[month - 1])
                                .font(.system(size: 9))
                        }
                    }
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let amount = value.as(Double.self) {
                            Text(amount, format: .currency(code: "USD").precision(.fractionLength(0)))
                                .font(.caption2)
                        }
                    }
                }
            }
            .chartLegend(.hidden)
            .frame(height: 240)
            .accessibilityLabel("Monthly spending compared with budget for \(String(currentYear)) and \(String(currentYear - 1))")

            HStack(spacing: 16) {
                Label("Met / under", systemImage: "circle.fill")
                    .foregroundStyle(.green)
                Label("Over budget", systemImage: "circle.fill")
                    .foregroundStyle(.red)
            }
            .font(.caption)

            Text("Above $0: under budget. At $0: on budget. Below $0: over budget. Current month is so far.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Text(points.isEmpty
                 ? "Enter budgeted expenses and realistic spending to see monthly points. Enter 0 explicitly for a zero-spending month."
                 : "Blank months have missing or invalid expense entries. Lines break across those gaps. Savings and income are excluded from this expense comparison.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(20)
        .background(Color(.secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 20))
    }

    private func statusDescription(for point: AnnualBudgetPoint) -> String {
        if point.id == currentMonthID {
            return point.metBudget ? "Within budget so far" : "Over budget so far"
        }
        return point.metBudget ? "Met budget" : "Over budget"
    }

    private func yearLegend(year: Int, color: Color, dashed: Bool) -> some View {
        HStack(spacing: 6) {
            Rectangle()
                .fill(color)
                .frame(width: 22, height: 3)
                .overlay {
                    if dashed {
                        HStack(spacing: 4) {
                            Color(.secondarySystemGroupedBackground).frame(width: 3)
                            Color(.secondarySystemGroupedBackground).frame(width: 3)
                        }
                    }
                }
            Text(String(year)).font(.caption)
        }
    }
}

struct BudgetEditorView: View {
    @Binding var month: MonthlyBudget
    @State private var selectedPeriod = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(month.title)
                    .font(.title2.bold())

                Text("Choose a budget section. Changes save automatically on this device.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                Picker("Budget section", selection: $selectedPeriod) {
                    ForEach(month.windows) { window in
                        Text(window.title).tag(window.index)
                    }
                }
                .pickerStyle(.segmented)

                if let window = month.windows.first(where: { $0.index == selectedPeriod }),
                   month.periods.indices.contains(selectedPeriod) {
                    Text("\(month.paySchedule.frequency.title) • Days \(window.title)")
                        .font(.headline)
                    if let payday = window.payDay {
                        Text("Payday: \(payday) \(month.date.formatted(.dateTime.month(.wide)))")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Choose this month's pay dates in Settings → Pay schedule.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    BudgetInputCard(title: "Realistic", plan: $month.periods[selectedPeriod].realistic,
                                    color: .blue, reportedTransactions: month.transactions(in: window))
                    BudgetInputCard(title: "Budgeted", plan: $month.periods[selectedPeriod].budgeted, color: .green)
                }

                Text("Enter income, savings, and spending for the selected section only. Home, History, and the graph combine every section into one month. Under Realistic expenses, enter only unlogged spending; transactions are added by their dates. Amounts are in USD with up to two decimal places.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding()
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Budget Details")
        .onAppear(perform: selectCurrentPeriod)
        .onChange(of: month.id) { _ in selectCurrentPeriod() }
        .onChange(of: month.paySchedule) { _ in selectCurrentPeriod() }
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") {
                    UIApplication.shared.sendAction(
                        #selector(UIResponder.resignFirstResponder),
                        to: nil, from: nil, for: nil
                    )
                }
            }
        }
    }

    private func selectCurrentPeriod() {
        let day = BudgetDates.day(of: Date())
        selectedPeriod = month.windows.first { $0.contains(day: day) }?.index ?? 0
    }
}

struct TransactionsView: View {
    @ObservedObject var store: BudgetStore
    @State private var selectedMonthID = BudgetStore.monthID(for: Date())
    @State private var editingTransaction: ReportedExpense?

    private var displayedTransactions: [ReportedExpense] {
        let transactions = store.months.first { $0.id == selectedMonthID }?.transactions ?? []
        return transactions.sorted {
            if $0.date != $1.date { return $0.date > $1.date }
            return $0.id.uuidString < $1.id.uuidString
        }
    }

    var body: some View {
        let transactions = displayedTransactions
        List {
            Section {
                Picker("Month", selection: $selectedMonthID) {
                    ForEach(store.months.sorted { $0.id > $1.id }) { month in
                        Text(month.title).tag(month.id)
                    }
                }
                TotalRow(title: "Logged this month", amount:
                    transactions.reduce(Decimal.zero) { $0 + $1.amount })
            }

            Section {
                if transactions.isEmpty {
                    Text("No transactions for this month. Tap + to report an expense.")
                        .foregroundStyle(.secondary)
                }
                ForEach(transactions) { transaction in
                    Button {
                        editingTransaction = transaction
                    } label: {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(transaction.category)
                                    .font(.headline)
                                if !transaction.note.isEmpty {
                                    Text(transaction.note)
                                        .font(.subheadline)
                                }
                                Text(transaction.date, format: .dateTime.month().day().year())
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(transaction.amount, format: .currency(code: "USD"))
                        }
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Edit this transaction")
                }
                .onDelete { offsets in
                    let identifiers = Set(offsets.map { transactions[$0].id })
                    store.deleteTransactions(ids: identifiers)
                }
            } header: {
                Text("Reported expenses")
            } footer: {
                Text("Tap an entry to edit it, or swipe left to delete it. Its date determines the month and budget section whose Realistic expenses change. Budgeted expenses stay as entered.")
            }
        }
        .navigationTitle("Transactions")
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                EditButton()
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    var transaction = ReportedExpense()
                    if selectedMonthID != store.currentMonthID,
                       let month = store.months.first(where: { $0.id == selectedMonthID }) {
                        transaction.date = month.date
                    }
                    editingTransaction = transaction
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Add transaction")
            }
        }
        .sheet(item: $editingTransaction) { transaction in
            TransactionForm(transaction: transaction) { savedTransaction in
                guard store.saveTransaction(savedTransaction) else { return false }
                selectedMonthID = BudgetStore.monthID(for: savedTransaction.date)
                return true
            }
        }
    }

}

struct TransactionForm: View {
    let transaction: ReportedExpense
    let onSave: (ReportedExpense) -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var date: Date
    @State private var category: String
    @State private var amount: String
    @State private var note: String
    @State private var showSaveError = false

    init(transaction: ReportedExpense, onSave: @escaping (ReportedExpense) -> Bool) {
        self.transaction = transaction
        self.onSave = onSave
        _date = State(initialValue: transaction.date)
        _category = State(initialValue: transaction.category)
        _amount = State(initialValue:
            transaction.amount > .zero ? editableMoney(transaction.amount) : "")
        _note = State(initialValue: transaction.note)
    }

    private var validAmount: Decimal? {
        guard let value = parsedMoney(amount), value > .zero else { return nil }
        return value
    }

    private var canSave: Bool {
        validAmount != nil && expenseCategories.contains(category)
            && Calendar.current.startOfDay(for: date)
                <= Calendar.current.startOfDay(for: Date())
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Expense details") {
                    DatePicker("Date", selection: $date, in: ...Date(), displayedComponents: .date)
                    Picker("Category", selection: $category) {
                        ForEach(expenseCategories, id: \.self) { name in
                            Text(name).tag(name)
                        }
                    }
                    MoneyInputRow(name: "Amount", amount: $amount)
                }
                Section("Note (optional)") {
                    TextField("For example: Weekly groceries", text: $note)
                }
                Section {
                    Text("This expense will be added to Realistic spending for its selected month and matching pay-period section. Only log spending that is not already included in an unlogged amount on Budget.")
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle(transaction.amount > .zero ? "Edit Transaction" : "Add Transaction")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save)
                        .disabled(!canSave)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") {
                        UIApplication.shared.sendAction(
                            #selector(UIResponder.resignFirstResponder),
                            to: nil, from: nil, for: nil
                        )
                    }
                }
            }
            .alert("Couldn't save transaction", isPresented: $showSaveError) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("Choose a predefined category, a date no later than today, and an amount greater than zero with up to two decimal places.")
            }
        }
    }

    private func save() {
        guard let value = validAmount else { return }
        var updated = transaction
        updated.date = date
        updated.category = category
        updated.amount = value
        updated.note = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if onSave(updated) {
            dismiss()
        } else {
            showSaveError = true
        }
    }
}

// MARK: - Settings, unlock, and confirmed data reset

struct LocalStorageProblemView: View {
    let message: String
    let onReset: () -> Void
    @State private var showEraseConfirmation = false

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "externaldrive.badge.exclamationmark")
                .font(.largeTitle)
            Text("Local Storage Unavailable").font(.title2.bold())
            Text(message).multilineTextAlignment(.center)
            Text("Try closing and reopening the app first. Resetting is optional and erases your app data.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Erase local data and reset", role: .destructive) {
                showEraseConfirmation = true
            }
        }
        .padding()
        .modifier(EraseDataConfirmation(isPresented: $showEraseConfirmation, onReset: onReset))
    }
}

enum PasscodeAction: String, Identifiable {
    case enable, change, disable
    var id: String { rawValue }

    var title: String {
        switch self {
        case .enable: return "Set Passcode"
        case .change: return "Change Passcode"
        case .disable: return "Turn Off Passcode"
        }
    }
}

struct SettingsView: View {
    @ObservedObject var store: BudgetStore
    @ObservedObject var appLock: AppLockStore
    let onReset: () -> Void
    @State private var passcodeAction: PasscodeAction?
    @State private var showEraseConfirmation = false

    var body: some View {
        List {
            Section {
                if let index = store.currentMonthIndex {
                    let month = store.months[index]
                    NavigationLink {
                        PayScheduleView(month: month) { schedule in
                            store.updatePaySchedule(monthID: month.id, schedule: schedule)
                        }
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Pay schedule")
                            Text("\(month.title) • \(month.paySchedule.frequency.title)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } header: {
                Text("Budget periods")
            } footer: {
                Text("Choose one, two, or four pay dates for this month. Your budget sections follow that schedule; Home and the graph always show combined monthly totals.")
            }

            Section {
                HStack {
                    Text("Passcode lock")
                    Spacer()
                    Text(appLock.isEnabled ? "On" : "Off")
                        .foregroundStyle(.secondary)
                }
                if appLock.isEnabled {
                    Button("Change passcode") { passcodeAction = .change }
                    Button("Turn off passcode") { passcodeAction = .disable }
                    Button("Lock now") { appLock.lock() }
                } else {
                    Button("Set a 4-digit passcode") { passcodeAction = .enable }
                }
            } header: {
                Text("App lock")
            } footer: {
                Text("When enabled, your passcode is required when you reopen the app or return after leaving it.")
            }

            Section {
                Button("Erase all app data", role: .destructive) {
                    showEraseConfirmation = true
                }
            } header: {
                Text("Your data")
            } footer: {
                Text("App records are saved locally and marked to be excluded from device backups. There is no online recovery if you lose this device or erase the app. If you forget your passcode, you can erase all local data and start again.")
            }

            Section("Privacy") {
                NavigationLink("Privacy policy") { LocalPrivacyView() }
            }
        }
        .navigationTitle("Settings")
        .sheet(item: $passcodeAction) { action in
            PasscodeSettingsForm(appLock: appLock, action: action, onReset: onReset)
        }
        .modifier(EraseDataConfirmation(isPresented: $showEraseConfirmation, onReset: onReset))
    }
}

struct PayScheduleView: View {
    let month: MonthlyBudget
    let onSave: (PaySchedule) -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var frequency: PayFrequency
    @State private var selectedDates: Set<DateComponents>
    @State private var showSaveError = false

    init(month: MonthlyBudget, onSave: @escaping (PaySchedule) -> Bool) {
        self.month = month
        self.onSave = onSave
        _frequency = State(initialValue: month.paySchedule.frequency)
        let parts = AnnualBudgetComparison.components(of: month.id)
        let dates = month.paySchedule.days.map {
            DateComponents(year: parts?.year, month: parts?.month, day: $0)
        }
        _selectedDates = State(initialValue: Set(dates))
    }

    private var chosenDays: [Int] {
        guard let parts = AnnualBudgetComparison.components(of: month.id) else { return [] }
        return Set(selectedDates.compactMap { value -> Int? in
            guard value.year == parts.year, value.month == parts.month else { return nil }
            return value.day
        }).sorted()
    }

    private var draft: PaySchedule { PaySchedule(frequency: frequency, days: chosenDays) }
    private var canSave: Bool {
        selectedDates.count == chosenDays.count && draft.isValid(for: month.id)
    }

    var body: some View {
        Form {
            Section(month.title) {
                Picker("Pay period", selection: $frequency) {
                    ForEach(PayFrequency.allCases) { type in
                        Text(type.title).tag(type)
                    }
                }
                .onChange(of: frequency) { _ in selectedDates = [] }
            }
            Section {
                if let bounds = BudgetDates.bounds(for: month.id) {
                    MultiDatePicker("Choose pay dates", selection: $selectedDates,
                                    in: bounds.start..<bounds.end)
                        .environment(\.calendar, BudgetDates.calendar)
                        .environment(\.timeZone, TimeZone.current)
                }
                Text("\(chosenDays.count) of \(frequency.requiredDateCount) pay dates selected")
                    .foregroundStyle(canSave ? Color.green : Color.secondary)
                Button("Clear selected dates") { selectedDates = [] }
            } header: {
                Text("Select \(frequency.requiredDateCount) different dates")
            } footer: {
                Text("Select dates for this calendar month and tap Save. The pay-period type is reused for new months, but dates must be chosen each month. This is not an automatic repeating schedule: Bi-Weekly records two dates and Weekly records four.")
            }

            if canSave {
                Section("Budget sections after saving") {
                    ForEach(draft.windows(for: month.id)) { window in
                        HStack {
                            Text("Days \(window.title)")
                            Spacer()
                            if let day = window.payDay {
                                Text("Payday: \(day)").foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            Section {
                Text("The first section starts on the 1st; each later payday starts the next section. The final section ends on the last day of the month. Transactions follow these date ranges.")
                Text("Changing dates retains manual amounts in their section order. Adding sections starts them empty. Removing sections combines their manual amounts into the last remaining section, preserving monthly totals. You can redistribute those amounts in Budget afterward.")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        .navigationTitle("Pay Schedule")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    if onSave(draft) { dismiss() } else { showSaveError = true }
                }
                .disabled(!canSave)
            }
        }
        .alert("Couldn't update pay schedule", isPresented: $showSaveError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Choose the required number of different dates in this month. Correct any invalid budget amounts before reducing the number of sections. If local storage is unavailable, close and reopen the app.")
        }
    }
}

// Static text: opening the privacy policy makes no network request.
struct LocalPrivacyView: View {
    var body: some View {
        List {
            Section("Your information") {
                Text("Income, pay schedules and dates, budgets, reported transactions, notes, savings, and monthly history are processed and stored locally by this app. No account or internet connection is required for budgeting.")
            }
            Section("No collection or tracking") {
                Text("This app does not send your records to the developer or to an online service. It contains no analytics or advertising SDK, tracking, remote push service, or automatic sharing feature. It makes no app-initiated network requests.")
            }
            Section("Passcode") {
                Text("An optional four-digit passcode controls access to the screens. A salted passcode verifier is stored locally, without Keychain. This screen lock does not separately encrypt the budget database. App files use iOS file protection.")
            }
            Section("Storage and backups") {
                Text("App-owned records, recovery copies, and lock metadata are marked to be excluded from device backups. There is no cloud sync or online recovery. The app cannot remove copies in backups that already existed. Losing the device or deleting the app can mean losing these records.")
            }
            Section("Deleting your data") {
                Text("Settings → Erase all app data and Forgot passcode both offer a reset after a destructive confirmation. Reset removes the app's local financial records, passcode verifier, and recovery copies. It cannot remove copies created outside the app or in existing backups.")
            }
            Section("Apple and device services") {
                Text("Apple manages App Store distribution, device backups, and system diagnostics under its own policies and your device settings. The app does not deliberately attach financial records to diagnostics. This policy describes the app's behavior, not every operating-system or user action.")
            }
            Section("Contact") {
                Text("For privacy questions, use the developer contact details on this app's App Store page. Information you choose to send for support is separate from the offline records stored in the app.")
            }
        }
        .navigationTitle("Privacy Policy")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct PasscodeLockView: View {
    @ObservedObject var appLock: AppLockStore
    let onReset: () -> Void
    @State private var code = ""
    @State private var errorMessage = ""
    @State private var showEraseConfirmation = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 44))
                    Text("Unlock My Budget")
                        .font(.title.bold())
                    Text("Enter your 4-digit passcode.")
                        .foregroundStyle(.secondary)
                    PasscodeInput(title: "Passcode", code: $code)

                    TimelineView(.explicit(appLock.retryTimelineDates)) { context in
                        let seconds = appLock.secondsUntilRetry(at: context.date)
                        VStack(spacing: 12) {
                            if seconds > 0 {
                                Text("Try again in \(seconds) seconds.")
                                    .foregroundStyle(.secondary)
                            }
                            Button("Unlock", action: unlock)
                                .buttonStyle(.borderedProminent)
                                .disabled(!PasscodeRecord.isValid(code) || seconds > 0)
                        }
                    }

                    if !errorMessage.isEmpty {
                        Text(errorMessage).foregroundStyle(.red)
                    }
                    if let message = appLock.storageMessage {
                        Text(message).foregroundStyle(.red)
                    }
                    Button("Forgot passcode?") { showEraseConfirmation = true }
                        .padding(.top, 12)
                }
                .frame(maxWidth: 360)
                .padding()
                .padding(.top, 40)
                .frame(maxWidth: .infinity)
            }
        }
        .modifier(EraseDataConfirmation(isPresented: $showEraseConfirmation, onReset: onReset))
    }

    private func unlock() {
        do {
            try appLock.unlock(code: code)
            code = ""
        } catch {
            errorMessage = error.localizedDescription
            code = ""
        }
    }
}

struct PasscodeSettingsForm: View {
    @ObservedObject var appLock: AppLockStore
    let action: PasscodeAction
    let onReset: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var currentCode = ""
    @State private var newCode = ""
    @State private var confirmation = ""
    @State private var errorMessage = ""
    @State private var showEraseConfirmation = false

    private var canSave: Bool {
        let currentIsValid = action == .enable || PasscodeRecord.isValid(currentCode)
        let newIsValid = action == .disable
            || (PasscodeRecord.isValid(newCode) && newCode == confirmation)
        return currentIsValid && newIsValid
    }

    var body: some View {
        TimelineView(.explicit(appLock.retryTimelineDates)) { context in
            let seconds = appLock.secondsUntilRetry(at: context.date)
            NavigationStack {
                Form {
                    if action != .enable {
                        Section("Current passcode") {
                            PasscodeInput(title: "Current passcode", code: $currentCode)
                        }
                    }
                    if action != .disable {
                        Section("New passcode") {
                            PasscodeInput(title: "New 4-digit passcode", code: $newCode)
                            PasscodeInput(title: "Enter it again", code: $confirmation)
                            if confirmation.count == 4 && newCode != confirmation {
                                Text("The new passcodes do not match.")
                                    .foregroundStyle(.red)
                            }
                        }
                    }
                    if seconds > 0 {
                        Text("Try again in \(seconds) seconds.")
                            .foregroundStyle(.secondary)
                    }
                    if !errorMessage.isEmpty {
                        Text(errorMessage).foregroundStyle(.red)
                    }
                    if action != .enable {
                        Section {
                            Button("Forgot passcode?") { showEraseConfirmation = true }
                        }
                    }
                }
                .navigationTitle(action.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(action == .disable ? "Turn Off" : "Save", action: save)
                            .disabled(!canSave || seconds > 0)
                    }
                    ToolbarItemGroup(placement: .keyboard) {
                        Spacer()
                        Button("Done") {
                            UIApplication.shared.sendAction(
                                #selector(UIResponder.resignFirstResponder),
                                to: nil, from: nil, for: nil
                            )
                        }
                    }
                }
            }
        }
        .modifier(EraseDataConfirmation(isPresented: $showEraseConfirmation, onReset: onReset))
    }

    private func save() {
        guard canSave else { return }
        do {
            switch action {
            case .enable: try appLock.enable(code: newCode)
            case .change: try appLock.change(currentCode: currentCode, newCode: newCode)
            case .disable: try appLock.disable(currentCode: currentCode)
            }
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
            currentCode = ""
        }
    }
}

struct PasscodeInput: View {
    let title: String
    @Binding var code: String

    var body: some View {
        SecureField(title, text: $code)
            .keyboardType(.numberPad)
            .textFieldStyle(.roundedBorder)
            .accessibilityLabel(title)
            .onChange(of: code) { value in
                let filtered = String(value.filter { "0123456789".contains($0) }.prefix(4))
                if filtered != value { code = filtered }
            }
    }
}

// The same warning and destructive confirmation are used everywhere.
struct EraseDataConfirmation: ViewModifier {
    @Binding var isPresented: Bool
    let onReset: () -> Void

    func body(content: Content) -> some View {
        content
            .confirmationDialog("Erase all app data?", isPresented: $isPresented,
                                titleVisibility: .visible) {
                Button("Erase all data and reset", role: .destructive, action: onReset)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This permanently erases all budgets, transactions, savings records, monthly history, recovery copies, and the passcode stored by this app on this device. You will start again with an empty budget. This cannot be undone within the app.")
            }
    }
}

struct TrendsView: View {
    let months: [MonthlyBudget]
    let currentMonthID: String

    var body: some View {
        List {
            Section {
                AnnualBudgetChart(months: months, currentMonthID: currentMonthID)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            Section {
                if months.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Your history starts here")
                            .font(.headline)
                        Text("Saved monthly summaries and spending comparisons will appear here.")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical)
                } else {
                    ForEach(months.sorted { $0.id > $1.id }) { month in
                        let realistic = month.realisticSummary
                        NavigationLink {
                            ScrollView {
                                VStack(spacing: 20) {
                                    SummaryCard(title: "Realistic", summary: realistic, color: .blue)
                                    SummaryCard(title: "Budgeted", summary: month.budgetedSummary, color: .green)
                                }
                                .padding()
                            }
                            .background(Color(.systemGroupedBackground))
                            .navigationTitle(month.title)
                            .navigationBarTitleDisplayMode(.inline)
                        } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(month.title).font(.headline)
                                if month.id == currentMonthID {
                                    Text("Current month • In progress")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                if realistic.hasInvalidAmounts {
                                    Text("Contains an invalid amount")
                                        .foregroundStyle(.red)
                                } else {
                                    Text("Savings change: \((realistic.totalSavings - realistic.totalWithdrawn).formatted(.currency(code: "USD")))")
                                        .foregroundStyle(.secondary)
                                    Text("Remaining: \(realistic.remaining.formatted(.currency(code: "USD")))")
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }
            } header: {
                Text("Monthly history")
            } footer: {
                Text("Tap a month to view its combined totals across all pay periods. The current month is still in progress.")
            }
        }
        .navigationTitle("History & Trends")
    }
}

// MARK: - Reusable cards and rows

struct SummaryCard: View {
    let title: String
    let summary: BudgetSummary
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title).font(.title2.bold()).foregroundStyle(color)
            if summary.hasInvalidAmounts {
                Text("Correct the highlighted amounts on the Budget screen to see your totals.")
                    .foregroundStyle(.red)
            } else {
                TotalRow(title: "Income", amount: summary.totalIncome)
                TotalRow(title: "Expenses", amount: summary.totalExpenses)
                TotalRow(title: "Savings added", amount: summary.totalSavings)
                TotalRow(title: "Pulled from savings", amount: summary.totalWithdrawn)
                Divider()
                TotalRow(title: "Remaining", amount: summary.remaining, bold: true)
            }
        }
        .padding(20)
        .background(Color(.secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 20))
    }
}

struct BudgetInputCard: View {
    let title: String
    @Binding var plan: BudgetPlan
    let color: Color
    var reportedTransactions: [ReportedExpense]? = nil

    var body: some View {
        let transactions = reportedTransactions ?? []
        let summary = BudgetSummary(plan: plan, transactions: transactions)
        let categoryTotals = transactions.reduce(into: [String: Decimal]()) {
            $0[$1.category, default: .zero] += $1.amount
        }
        VStack(alignment: .leading, spacing: 16) {
            Text(title).font(.title2.bold()).foregroundStyle(color)
            Text("Income").font(.headline)
            MoneyInputRow(name: "Payroll", amount: $plan.payroll)
            MoneyInputRow(name: "Extra", amount: $plan.extra)
            Divider()
            Text("Expenses").font(.headline)
            if reportedTransactions != nil {
                Text("Category totals include logged transactions plus unlogged amounts. Keep any spending entered previously as unlogged, and only log expenses you have not already included.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            ForEach($plan.expenses) { $entry in
                if reportedTransactions != nil {
                    RealisticExpenseRow(entry: $entry, reportedAmount:
                        categoryTotals[entry.name, default: .zero])
                } else {
                    MoneyInputRow(name: entry.name, amount: $entry.amount)
                }
            }
            Divider()
            Text("Savings").font(.headline)
            MoneyInputRow(name: "Set aside", amount: $plan.savings)
            MoneyInputRow(name: "Pull from savings", amount: $plan.savingsWithdrawn)
            Divider()
            if !summary.hasInvalidAmounts {
                TotalRow(title: "Remaining", amount: summary.remaining, bold: true)
            }
        }
        .padding(20)
        .background(Color(.secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 20))
    }
}

struct RealisticExpenseRow: View {
    @Binding var entry: ExpenseEntry
    let reportedAmount: Decimal

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let unloggedAmount = parsedMoney(entry.amount) {
                TotalRow(title: entry.name, amount: unloggedAmount + reportedAmount, bold: true)
            } else {
                Text(entry.name).fontWeight(.bold)
            }
            Text("Logged transactions: \(reportedAmount.formatted(.currency(code: "USD")))")
                .font(.caption)
                .foregroundStyle(.secondary)
            MoneyInputRow(name: "Unlogged amount", amount: $entry.amount)
                .accessibilityElement(children: .contain)
                .accessibilityLabel(entry.name)
        }
        .padding(.vertical, 4)
    }
}

struct MoneyInputRow: View {
    let name: String
    @Binding var amount: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(name)
                Spacer()
                Text("$").foregroundStyle(.secondary)
                TextField("0.00", text: $amount)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .frame(width: 110)
                    .padding(8)
                    .background(Color(.tertiarySystemFill),
                                in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityLabel("\(name) amount")
            }
            if parsedMoney(amount) == nil {
                Text("Enter a positive amount with up to two decimal places.")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }
}

struct TotalRow: View {
    let title: String
    let amount: Decimal
    var bold = false

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            Text(amount, format: .currency(code: "USD"))
                .foregroundStyle(amount < .zero ? Color.red : Color.primary)
        }
        .fontWeight(bold ? .bold : .regular)
    }
}

#Preview {
    ContentView()
}
