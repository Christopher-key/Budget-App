// Public wire format shared by the browser, Azure API, and native sync bridge.
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
export interface AccountStatus { state: 'new' | 'locked' | 'erased'; epoch: number; accountId: string }
export interface UnlockResponse { epoch: number; unlockToken: string; expiresAt: string }
export interface BudgetEnvelope { epoch: number; revision: number; ledger: Ledger }
export interface SaveBudgetRequest { epoch: number; revision: number; ledger: Ledger }
export type ApiErrorCode = 'AUTH_REQUIRED' | 'SETUP_REQUIRED' | 'LOCKED' |
  'INCORRECT_PASSCODE' | 'ACCOUNT_ERASED' | 'STALE_EPOCH' | 'REVISION_CONFLICT' |
  'INVALID_DATA' | 'UNAVAILABLE';
export const MAX_FAILED_PASSCODES = 3;
export const UNLOCK_HEADER = 'X-Budget-Unlock';
