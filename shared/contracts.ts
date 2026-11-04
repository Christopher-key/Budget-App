// Budget model used on devices. Encrypted cloud wire formats live in cloud.ts.
// Monetary inputs are decimal STRINGS. No credentials belong in this schema.
export type PayFrequency = 'monthly' | 'biWeekly' | 'weekly';
export interface ExpenseEntry { id: string; name: string; amount: string }
export interface BucketEntry { id: string; name: string; contribution: string; withdrawal: string }
export interface BudgetPlan {
  payroll: string; extra: string; savings: string; savingsWithdrawn: string;
  expenses: ExpenseEntry[]; bucketEntries: BucketEntry[];
}
export interface PeriodBudget { realistic: BudgetPlan; budgeted: BudgetPlan }
export interface ReportedExpense {
  id: string; date: string; dayOfMonth: number; category: string; amount: string; note: string;
}
export interface MonthlyBudget {
  id: string; date: string; periods: PeriodBudget[];
  paySchedule: { frequency: PayFrequency; days: number[] }; transactions: ReportedExpense[];
}
export interface SavingsBucket { id: string; name: string; target: string; isActive: boolean }
export interface ExportAudit {
  id: string; createdAt: string; monthIds: string[]; status: 'downloadRequested';
}
export interface Ledger {
  schemaVersion: 1; months: MonthlyBudget[]; savingsBuckets: SavingsBucket[];
  payFrequency: PayFrequency; exportHistory: ExportAudit[];
}
export interface AccountStatus { state: 'new' | 'locked' | 'erased'; epoch: number; accountId: string; revision?: number }
export interface UnlockResponse { epoch: number; unlockToken: string; expiresAt: string }
// Decrypted device state only; cloud requests use cloud.ts encrypted envelopes.
export interface BudgetEnvelope { epoch: number; revision: number; ledger: Ledger }
export const MAX_FAILED_PASSCODES = 3;
export const UNLOCK_HEADER = 'X-Budget-Unlock';
