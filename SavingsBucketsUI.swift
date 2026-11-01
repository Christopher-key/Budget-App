import SwiftUI
import Combine
import UIKit

// MARK: - Read-only Home preview

struct SavingsBucketsPreview: View {
    let progress: [SavingsBucketProgress]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if progress.isEmpty {
                Text("No active savings buckets").font(.subheadline)
                Text("Create a goal in Settings → Savings buckets.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(progress) { item in
                HStack(alignment: .firstTextBaseline) {
                    Text(item.bucket.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Spacer(minLength: 12)
                    Text(bucketProgressText(item))
                        .font(.subheadline)
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .layoutPriority(1)
                        .foregroundStyle(item.saved == nil || (item.saved ?? .zero) < .zero
                                         ? Color.red : Color.primary)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 16))
    }
}

private func bucketProgressText(_ item: SavingsBucketProgress) -> String {
    let saved = item.saved.map { $0.formatted(.currency(code: "USD")) } ?? "Check entries"
    let target = parsedMoney(item.bucket.target).map { $0.formatted(.currency(code: "USD")) } ?? "—"
    return "\(saved) / \(target)"
}

// MARK: - Goal creation, editing, and archiving

@MainActor
struct SavingsBucketsView: View {
    @ObservedObject var store: BudgetStore
    @State private var editingBucket: SavingsBucket?
    @State private var showSaveFailure = false

    var body: some View {
        let progress = store.bucketProgress
        List {
            Section {
                ForEach(progress.filter { $0.bucket.isActive }) { item in
                    bucketRow(item)
                        .swipeActions {
                            Button("Archive") { setActive(false, bucket: item.bucket) }
                                .tint(.orange)
                        }
                }
                if !progress.contains(where: { $0.bucket.isActive }) {
                    Text("Add a bucket for something you want to save for.")
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Active buckets")
            } footer: {
                Text("Buckets start at $0. Realistic contributions add to progress; withdrawals from that bucket reduce it. Budgeted amounts are plans. Contributions are additional to Set aside.")
            }
            if progress.contains(where: { !$0.bucket.isActive }) {
                Section {
                    ForEach(progress.filter { !$0.bucket.isActive }) { item in
                        bucketRow(item)
                            .swipeActions {
                                Button("Activate") { setActive(true, bucket: item.bucket) }
                                    .tint(.blue)
                            }
                    }
                } header: {
                    Text("Inactive buckets")
                } footer: {
                    Text("Archiving hides the contribution field and Home preview. Recorded money stays in your savings and history. You can still choose an inactive bucket when pulling from savings.")
                }
            }
        }
        .navigationTitle("Savings Buckets")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { editingBucket = SavingsBucket(name: "", target: "") } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Add savings bucket")
            }
        }
        .sheet(item: $editingBucket) { bucket in
            SavingsBucketEditor(bucket: bucket, onSave: store.saveSavingsBucket)
        }
        .alert("Couldn't save this bucket", isPresented: $showSaveFailure) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Use a unique name and a target greater than zero. If local storage is unavailable, close and reopen the app.")
        }
    }

    private func bucketRow(_ item: SavingsBucketProgress) -> some View {
        Button { editingBucket = item.bucket } label: {
            VStack(alignment: .leading, spacing: 5) {
                Text(item.bucket.name).font(.headline).foregroundStyle(.primary)
                Text(bucketProgressText(item))
                    .foregroundStyle(item.saved == nil || (item.saved ?? .zero) < .zero
                                     ? Color.red : Color.secondary)
                if let saved = item.saved, saved < .zero {
                    Text("Withdrawals exceed contributions recorded for this bucket.")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Edit this savings goal")
    }

    private func setActive(_ active: Bool, bucket: SavingsBucket) {
        var updated = bucket
        updated.isActive = active
        if !store.saveSavingsBucket(updated) { showSaveFailure = true }
    }
}

@MainActor
private struct SavingsBucketEditor: View {
    @State private var draft: SavingsBucket
    @State private var errorMessage = ""
    let onSave: (SavingsBucket) -> Bool
    @Environment(\.dismiss) private var dismiss

    init(bucket: SavingsBucket, onSave: @escaping (SavingsBucket) -> Bool) {
        _draft = State(initialValue: bucket)
        self.onSave = onSave
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Saving for") {
                    TextField("Name, such as New car", text: $draft.name)
                        .textInputAutocapitalization(.words)
                    MoneyInputRow(name: "Target amount", amount: $draft.target)
                    Toggle("Active", isOn: $draft.isActive)
                }
                Section {
                    Text("Enter contributions under Budget → Realistic to update the saved amount. Set aside remains separate. Reaching the target does not automatically stop or erase contributions.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if !errorMessage.isEmpty { Text(errorMessage).foregroundStyle(.red) }
            }
            .navigationTitle("Savings Bucket")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        if onSave(draft) { dismiss() }
                        else { errorMessage = "Choose a unique name and a valid target amount. Your changes have not been saved." }
                    }
                    .disabled(!draft.hasValidDetails)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done", action: dismissSavingsKeyboard)
                }
            }
        }
    }
}

// MARK: - Conditional contributions and withdrawal source selection

struct SavingsBucketInputs: View {
    @Binding var plan: BudgetPlan
    let buckets: [SavingsBucket]
    let isRealistic: Bool
    @State private var showWithdrawal = false

    private var active: [SavingsBucket] { buckets.filter(\.isActive) }
    private var inactiveEntries: [BucketSavingsEntry] {
        let activeIDs = Set(active.map(\.id))
        return plan.bucketEntries.filter {
            !activeIDs.contains($0.id) && (!$0.contribution.isEmpty || !$0.withdrawal.isEmpty)
        }
    }

    var body: some View {
        Group {
            if !active.isEmpty {
                Text("Bucket contributions").font(.headline)
                ForEach(active) { bucket in
                    MoneyInputRow(name: bucket.name, amount: Binding(
                        get: { plan.bucketEntries.first { $0.id == bucket.id }?.contribution ?? "" },
                        set: { value in
                            plan = replacingBucketAmount(in: plan, id: bucket.id, name: bucket.name,
                                                         field: .contribution, value: value)
                        }))
                }
                Text("Bucket contributions are additional to Set aside.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            ForEach(inactiveEntries) { entry in
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(entry.name) (inactive)").font(.subheadline)
                    if !entry.hasInvalidAmounts {
                        TotalRow(title: "Contribution this period", amount: moneyValue(entry.contribution))
                    } else {
                        Text("Activate this bucket to edit contributions, or use Pull from savings to correct withdrawals.")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }
            Button { showWithdrawal = true } label: {
                HStack {
                    Text("Pull from savings")
                    Spacer()
                    if !plan.hasInvalidSavingsAmounts {
                        Text(plan.totalWithdrawn, format: .currency(code: "USD"))
                    }
                    Image(systemName: "chevron.right").font(.caption)
                }
                .foregroundStyle(.primary)
            }
            .sheet(isPresented: $showWithdrawal) {
                SavingsWithdrawalEditor(plan: $plan, buckets: buckets, isRealistic: isRealistic)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
        }
    }
}

private enum BucketAmountField { case contribution, withdrawal }

private func replacingBucketAmount(in plan: BudgetPlan, id: UUID, name: String,
                                   field: BucketAmountField, value: String) -> BudgetPlan {
    var updated = plan
    guard updated.bucketEntries.filter({ $0.id == id }).count <= 1 else { return plan }
    var entry = updated.bucketEntries.first { $0.id == id } ?? BucketSavingsEntry(id: id, name: name)
    entry.name = name
    switch field {
    case .contribution: entry.contribution = value
    case .withdrawal: entry.withdrawal = value
    }
    updated.bucketEntries.removeAll { $0.id == id }
    if !entry.contribution.isEmpty || !entry.withdrawal.isEmpty { updated.bucketEntries.append(entry) }
    return updated
}

private enum SavingsWithdrawalSource: Hashable {
    case general
    case bucket(UUID)
}

private struct SavingsWithdrawalEditor: View {
    @Binding var plan: BudgetPlan
    let buckets: [SavingsBucket]
    let isRealistic: Bool
    @State private var source: SavingsWithdrawalSource = .general
    @State private var amount = ""
    @Environment(\.dismiss) private var dismiss

    private var bucketOptions: [SavingsBucket] {
        var result = buckets
        var known = Set(result.map(\.id))
        // Retain access to a historical source if its definition is unavailable.
        for entry in plan.bucketEntries where known.insert(entry.id).inserted {
            result.append(SavingsBucket(id: entry.id, name: entry.name, target: "0", isActive: false))
        }
        return result
    }

    private var canSave: Bool {
        guard let value = parsedMoney(amount), !value.isNaN, value >= .zero else { return false }
        return true
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Pull from savings location") {
                    Picker("Location", selection: $source) {
                        Text("Set aside (general)").tag(SavingsWithdrawalSource.general)
                        ForEach(bucketOptions) { bucket in
                            Text(bucket.name + (bucket.isActive ? "" : " (inactive)"))
                                .tag(SavingsWithdrawalSource.bucket(bucket.id))
                        }
                    }
                    .onChange(of: source) { _ in loadAmount() }
                    MoneyInputRow(name: "Total pulled this pay period", amount: $amount)
                }
                Section {
                    Text("Each location keeps its own total for this pay period. Update the selected location's total to correct or increase a withdrawal. To change an earlier withdrawal's location, clear its old location and enter it under the correct one.")
                    Text(isRealistic
                         ? "Bucket withdrawals reduce that bucket's saved amount and increase money available in this period's budget. Set aside withdrawals use general savings only. Record any purchase separately as an expense."
                         : "These are planned withdrawals. Saved balances change only when you enter withdrawals under Realistic.")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            .navigationTitle("Pull from Savings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save(); dismiss() }
                        .disabled(!canSave)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done", action: dismissSavingsKeyboard)
                }
            }
        }
        .onAppear(perform: selectInitialSource)
    }

    private func selectInitialSource() {
        func hasWithdrawal(_ text: String) -> Bool {
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
            return parsedMoney(text).map { $0 != .zero } ?? true
        }
        if !hasWithdrawal(plan.savingsWithdrawn),
           let entry = plan.bucketEntries.first(where: { hasWithdrawal($0.withdrawal) }) {
            source = .bucket(entry.id)
        } else {
            source = .general
        }
        loadAmount()
    }

    private func loadAmount() {
        switch source {
        case .general: amount = plan.savingsWithdrawn
        case .bucket(let id): amount = plan.bucketEntries.first { $0.id == id }?.withdrawal ?? ""
        }
    }

    private func save() {
        guard canSave else { return }
        switch source {
        case .general:
            plan.savingsWithdrawn = amount
        case .bucket(let id):
            guard let bucket = bucketOptions.first(where: { $0.id == id }) else { return }
            plan = replacingBucketAmount(in: plan, id: id, name: bucket.name,
                                         field: .withdrawal, value: amount)
        }
    }
}

@MainActor
private func dismissSavingsKeyboard() {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder),
                                    to: nil, from: nil, for: nil)
}
