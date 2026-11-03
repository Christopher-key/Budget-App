// Encrypted sync protocol. Passwords, decryption keys, and plaintext budgets
// never belong in server records, telemetry, or deployment configuration.
export const PASSWORD_ITERATIONS = 600_000 as const;
export const MAX_CIPHERTEXT_LENGTH = 1_500_000;
export interface CipherBlob { v: 1; iv: string; data: string }
export interface AuthParameters {
  accountId: string; salt: string; iterations: typeof PASSWORD_ITERATIONS;
}
export interface AuthResponse {
  token: string; expiresAt: string; accountId: string; salt: string;
  wrappedKey: CipherBlob;
}
export interface RegistrationRequest {
  username: string; proof: string; salt: string; wrappedKey: CipherBlob;
}
export interface LoginRequest { username: string; proof: string }
export interface EncryptedBudgetEnvelope {
  epoch: number; revision: number; payload: CipherBlob;
}
export interface EncryptedSetupRequest {
  pin: string; expectedEpoch: number; startEmpty: true; payload: CipherBlob;
}
export const keyContext = (accountId: string) => `budget-key:v1:${accountId}`;
export const ledgerContext = (accountId: string, epoch: number, revision: number) =>
  `budget-ledger:v1:${accountId}:${epoch}:${revision}`;
