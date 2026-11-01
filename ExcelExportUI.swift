import SwiftUI
import Combine
import UIKit

// MARK: - Private, metadata-only export history

enum ExcelExportStatus: String, Codable {
    case preparing, ready, handedOff, cancelled, failed, interrupted

    var title: String {
        switch self {
        case .preparing: return "Preparing"
        case .ready: return "Ready to share"
        case .handedOff: return "Handoff reported by iOS"
        case .cancelled: return "Cancelled"
        case .failed: return "Failed"
        case .interrupted: return "Interrupted — destination unconfirmed"
        }
    }
}

struct ExcelExportHistoryEntry: Identifiable, Codable {
    let id: UUID
    let createdAt: Date
    let monthIDs: [String]
    let transactionCount: Int
    let includesNotes: Bool
    let format: String
    var status: ExcelExportStatus
}

struct ExcelShareFile: Identifiable {
    let id: UUID
    let url: URL
}

enum ExcelSharingError: LocalizedError {
    case passcodeRequired, inactiveSession, historyUnavailable

    var errorDescription: String? {
        switch self {
        case .passcodeRequired:
            return "Set an app passcode in Settings before exporting."
        case .inactiveSession:
            return "Unlock the app and enter your passcode again to export."
        case .historyUnavailable:
            return "Export history could not be saved safely. No new file can be shared. Close and reopen the app."
        }
    }
}

// Root ownership keeps an authorized share alive when the locked tab tree disappears.
@MainActor
final class ExcelExportCoordinator: ObservableObject {
    @Published private(set) var history: [ExcelExportHistoryEntry] = []
    @Published private(set) var isPreparing = false
    @Published private(set) var historyMessage: String?
    @Published var message: String?
    @Published var activeShare: ExcelShareFile?

    private let preferences = LocalPreferences.shared
    private let historyKey = "MyBudget.excelExportHistory.v1"
    private var isSceneActive = false
    private var preparationID: UUID?
    private var buildTask: Task<Data, Error>?
    private var shareInFlight: ExcelShareFile?
    private var shareWasPresented = false

    init() {
        do {
            if let data = preferences.data(forKey: historyKey) {
                history = try JSONDecoder().decode([ExcelExportHistoryEntry].self, from: data)
            }
            // A prior process may have ended after a handoff but before its callback.
            var recovered = history
            var changed = false
            for index in recovered.indices where recovered[index].status == .preparing
                || recovered[index].status == .ready {
                recovered[index].status = .interrupted
                changed = true
            }
            if changed { try persistHistory(recovered) }
            try AppLocalFiles.delete("ExcelExports")
        } catch {
            historyMessage = "Export history or temporary files could not be opened safely. Close and reopen the app before exporting."
        }
    }

    func sceneDidChange(isActive: Bool) {
        isSceneActive = isActive
        if !isActive {
            cancelPreparation()
            // Do not present a newly prepared file later, after a background trip.
            if let share = shareInFlight, !shareWasPresented {
                finishShare(id: share.id, completed: false, failed: false)
            }
        }
    }

    func prepare(months: [MonthlyBudget], includeNotes: Bool,
                 code: String, appLock: AppLockStore) {
        guard !isPreparing, shareInFlight == nil else { return }
        do {
            guard historyMessage == nil, preferences.errorMessage == nil else {
                throw ExcelSharingError.historyUnavailable
            }
            guard isSceneActive else { throw ExcelSharingError.inactiveSession }
            try appLock.authorizeExport(code: code)
            guard preferences.errorMessage == nil else { throw ExcelSharingError.historyUnavailable }

            let id = UUID()
            let createdAt = Date()
            let entry = ExcelExportHistoryEntry(
                id: id, createdAt: createdAt, monthIDs: months.map(\.id).sorted(),
                transactionCount: months.reduce(0) { $0 + $1.transactions.count },
                includesNotes: includeNotes, format: "Excel (.xlsx)", status: .preparing)
            try persistHistory(history + [entry])
            preparationID = id
            isPreparing = true
            message = nil

            // The snapshot consists only of Sendable value models. No passcode,
            // preferences, file access, or UI objects enter the background task.
            let task = Task.detached(priority: .userInitiated) {
                try ExcelBudgetExport.make(months: months, includeNotes: includeNotes,
                                           createdAt: createdAt)
            }
            buildTask = task
            Task { [weak self] in
                do {
                    let data = try await task.value
                    guard let self = self, self.preparationID == id else { return }
                    guard self.isSceneActive, appLock.isEnabled, appLock.isUnlocked else {
                        self.cancelPreparation()
                        return
                    }
                    guard self.preferences.errorMessage == nil else {
                        throw ExcelSharingError.historyUnavailable
                    }
                    let directory = try AppLocalFiles.directoryURL()
                        .appendingPathComponent("ExcelExports", isDirectory: true)
                    try FileManager.default.createDirectory(
                        at: directory, withIntermediateDirectories: true,
                        attributes: [.protectionKey: FileProtectionType.complete])
                    let name = Self.fileName(id: id)
                    try AppLocalFiles.write(data, name: "ExcelExports/" + name)
                    try self.setStatus(id: id, status: .ready)
                    let share = ExcelShareFile(id: id, url: directory.appendingPathComponent(name))
                    self.preparationID = nil
                    self.buildTask = nil
                    self.isPreparing = false
                    self.shareWasPresented = false
                    self.shareInFlight = share
                    self.activeShare = share
                } catch {
                    guard let self = self, self.preparationID == id else { return }
                    self.preparationID = nil
                    self.buildTask = nil
                    self.isPreparing = false
                    try? self.setStatus(id: id, status: .failed)
                    self.removeStagedFile(id: id)
                    self.message = error.localizedDescription
                }
            }
        } catch {
            message = error.localizedDescription
        }
    }

    func cancelPreparation() {
        guard let id = preparationID else { return }
        preparationID = nil
        buildTask?.cancel()
        buildTask = nil
        isPreparing = false
        do { try setStatus(id: id, status: .cancelled) }
        catch { message = ExcelSharingError.historyUnavailable.localizedDescription }
        removeStagedFile(id: id)
    }

    func markSharePresented(id: UUID) {
        if shareInFlight?.id == id { shareWasPresented = true }
    }

    func finishShare(id: UUID, completed: Bool, failed: Bool) {
        // A reset clears this ID, so an old callback cannot restore erased history.
        guard shareInFlight?.id == id else { return }
        shareInFlight = nil
        shareWasPresented = false
        activeShare = nil
        do {
            try setStatus(id: id, status: failed ? .failed : (completed ? .handedOff : .cancelled))
        } catch {
            message = "The share ended, but its history could not be updated safely. Close and reopen the app."
        }
        removeStagedFile(id: id)
    }

    // Called BEFORE financial reset and passcode removal. Stop all old callbacks.
    func prepareForReset() throws {
        preparationID = nil
        buildTask?.cancel()
        buildTask = nil
        isPreparing = false
        shareInFlight = nil
        activeShare = nil
        shareWasPresented = false
        try AppLocalFiles.delete("ExcelExports")
    }

    func resetDidFinish() {
        history = []
        historyMessage = nil
        message = nil
    }

    private func persistHistory(_ updated: [ExcelExportHistoryEntry]) throws {
        guard preferences.errorMessage == nil else { throw ExcelSharingError.historyUnavailable }
        let data = try JSONEncoder().encode(updated)
        preferences.set(data, forKey: historyKey)
        guard preferences.errorMessage == nil else { throw ExcelSharingError.historyUnavailable }
        history = updated
    }

    private func setStatus(id: UUID, status: ExcelExportStatus) throws {
        var updated = history
        guard let index = updated.firstIndex(where: { $0.id == id }) else { return }
        updated[index].status = status
        try persistHistory(updated)
    }

    private static func fileName(id: UUID) -> String { "budget-export-\(id.uuidString).xlsx" }

    private func removeStagedFile(id: UUID) {
        do { try AppLocalFiles.delete("ExcelExports/" + Self.fileName(id: id)) }
        catch { message = "A temporary export could not be removed. Close and reopen the app to retry cleanup." }
    }
}

// MARK: - Settings destinations

@MainActor
struct ExcelExportView: View {
    @ObservedObject var store: BudgetStore
    @ObservedObject var appLock: AppLockStore
    @ObservedObject var exports: ExcelExportCoordinator
    @State private var selectedMonths: Set<String> = []
    @State private var includeNotes = false
    @State private var code = ""

    private var chosenMonths: [MonthlyBudget] {
        store.months.filter { selectedMonths.contains($0.id) }
    }

    var body: some View {
        Form {
            Section {
                Text("Create an Excel workbook with monthly summaries, pay periods, expense categories, and transactions. Exporting does not change your budget.")
                Text("Choose On My iPhone in Files to keep the saved copy on this device. Cloud-backed folders and sharing apps may upload their copy. Exported workbooks have no passcode encryption.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section("Months to include") {
                if store.months.count > 1 {
                    Button("Select all months") { selectedMonths = Set(store.months.map(\.id)) }
                    Button("Clear selection") { selectedMonths = [] }
                }
                ForEach(store.months.sorted { $0.id > $1.id }) { month in
                    Toggle(month.title, isOn: Binding(
                        get: { selectedMonths.contains(month.id) },
                        set: { selected in
                            if selected { selectedMonths.insert(month.id) }
                            else { selectedMonths.remove(month.id) }
                        }))
                }
            }
            .disabled(exports.isPreparing)
            Section {
                Toggle("Include transaction notes", isOn: $includeNotes)
            } footer: {
                Text("Notes may contain personal details. They are excluded unless you turn this on.")
            }
            .disabled(exports.isPreparing)
            Section {
                if !appLock.isEnabled {
                    Text("Set a 4-digit app passcode in Settings before exporting.")
                } else {
                    PasscodeInput(title: "Enter app passcode", code: $code)
                    TimelineView(.explicit(appLock.retryTimelineDates)) { context in
                        let seconds = appLock.secondsUntilRetry(at: context.date)
                        if seconds > 0 {
                            Text("Try again in \(seconds) seconds.").foregroundStyle(.secondary)
                        }
                        Button("Create Excel export") {
                            let submittedCode = code
                            code = ""
                            exports.prepare(months: chosenMonths, includeNotes: includeNotes,
                                            code: submittedCode, appLock: appLock)
                        }
                        .disabled(selectedMonths.isEmpty || !PasscodeRecord.isValid(code)
                                  || seconds > 0 || exports.isPreparing || exports.historyMessage != nil)
                    }
                }
                if exports.isPreparing {
                    HStack { ProgressView(); Text("Preparing workbook…") }
                    Button("Cancel export", role: .cancel) { exports.cancelPreparation() }
                }
                if let message = exports.historyMessage {
                    Text(message).foregroundStyle(.red)
                }
            } header: {
                Text("Confirm with passcode")
            } footer: {
                Text("Your passcode is required for every export. It is never included in the workbook.")
            }
        }
        .navigationTitle("Export to Excel")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { selectedMonths = [store.currentMonthID] }
        .onDisappear {
            code = ""
            exports.cancelPreparation()
        }
    }
}

@MainActor
struct ExcelExportHistoryView: View {
    @ObservedObject var exports: ExcelExportCoordinator

    var body: some View {
        List {
            Section {
                Text("This history records local export attempts and iOS handoffs. It cannot confirm that Excel opened a file or track copies saved elsewhere.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let message = exports.historyMessage {
                    Text(message).foregroundStyle(.red)
                }
                if exports.history.isEmpty {
                    Text("No exports yet.").foregroundStyle(.secondary)
                }
                ForEach(exports.history.sorted { $0.createdAt > $1.createdAt }) { entry in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(entry.createdAt, format: .dateTime.month().day().year().hour().minute())
                            .font(.headline)
                        Text(entry.status.title)
                        Text(entry.monthIDs.joined(separator: ", "))
                            .font(.caption)
                        Text("\(entry.monthIDs.count) month(s) • \(entry.transactionCount) transaction(s)")
                            .font(.caption)
                        Text(entry.includesNotes ? "Transaction notes included" : "Transaction notes excluded")
                            .font(.caption)
                        Text(entry.format).font(.caption)
                    }
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 4)
                }
            } footer: {
                Text("History stores no amounts, notes, or security codes. Erase all app data clears this history and temporary exports; it cannot delete external copies.")
            }
        }
        .navigationTitle("Export History")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - System sharing and app-switcher privacy

struct ExcelShareSheet: UIViewControllerRepresentable {
    let file: ExcelShareFile
    let onPresented: @MainActor () -> Void
    let onComplete: @MainActor (Bool, Bool) -> Void

    func makeUIViewController(context: Context) -> ShareHostController {
        ShareHostController(file: file, onPresented: onPresented, onComplete: onComplete)
    }

    func updateUIViewController(_ controller: ShareHostController, context: Context) {}

    // Wait for an attached, visible host before presenting the system activity UI.
    // Only UIKit's completion marks an OS handoff; SwiftUI dismissal is not proof.
    final class ShareHostController: UIViewController {
        private let file: ExcelShareFile
        private let onPresented: @MainActor () -> Void
        private let onComplete: @MainActor (Bool, Bool) -> Void
        private var started = false

        init(file: ExcelShareFile, onPresented: @escaping @MainActor () -> Void,
             onComplete: @escaping @MainActor (Bool, Bool) -> Void) {
            self.file = file
            self.onPresented = onPresented
            self.onComplete = onComplete
            super.init(nibName: nil, bundle: nil)
        }

        required init?(coder: NSCoder) { fatalError("Use the local export initializer") }

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .systemBackground
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            guard !started else { return }
            started = true
            guard UIApplication.shared.applicationState == .active else {
                onComplete(false, false)
                return
            }
            let controller = UIActivityViewController(activityItems: [file.url], applicationActivities: nil)
            controller.excludedActivityTypes = [.postToFacebook, .postToTwitter, .postToWeibo,
                                                .postToTencentWeibo, .assignToContact, .addToReadingList]
            controller.completionWithItemsHandler = { [onComplete] _, completed, _, error in
                let failed = error != nil
                Task { @MainActor in onComplete(completed, failed) }
            }
            if let popover = controller.popoverPresentationController {
                popover.sourceView = view
                popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            }
            present(controller, animated: true) { [onPresented] in onPresented() }
        }
    }
}

// Covers even presented share previews when iOS captures an inactive-app snapshot.
struct ExportPrivacyCurtain: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> CurtainController { CurtainController() }
    func updateUIViewController(_ controller: CurtainController, context: Context) {}

    final class CurtainController: UIViewController {
        private var curtain: UIWindow?

        override func viewDidLoad() {
            super.viewDidLoad()
            view.isUserInteractionEnabled = false
            NotificationCenter.default.addObserver(self, selector: #selector(conceal),
                                                  name: UIApplication.willResignActiveNotification, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(reveal),
                                                  name: UIApplication.didBecomeActiveNotification, object: nil)
        }

        @objc private func conceal() {
            guard curtain == nil, let scene = view.window?.windowScene else { return }
            let controller = UIViewController()
            controller.view.backgroundColor = .systemBackground
            let label = UILabel()
            label.text = "My Budget\nLocked"
            label.numberOfLines = 2
            label.textAlignment = .center
            label.font = .preferredFont(forTextStyle: .title1)
            label.translatesAutoresizingMaskIntoConstraints = false
            controller.view.addSubview(label)
            NSLayoutConstraint.activate([
                label.centerXAnchor.constraint(equalTo: controller.view.centerXAnchor),
                label.centerYAnchor.constraint(equalTo: controller.view.centerYAnchor)
            ])
            let window = UIWindow(windowScene: scene)
            window.windowLevel = .alert + 1
            window.rootViewController = controller
            window.isHidden = false
            curtain = window
        }

        @objc private func reveal() {
            curtain?.isHidden = true
            curtain = nil
        }

        deinit { NotificationCenter.default.removeObserver(self) }
    }
}
