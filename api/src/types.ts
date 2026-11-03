import type { ApiErrorCode, Ledger } from '../../shared/contracts.js';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: ApiErrorCode, readonly epoch?: number) {
    super(code);
  }
}
export interface Grant { hash: string; issuedAt: number; expiresAt: number }
export interface BadAttempt { id: string; fingerprint: string }
export interface Verifier { salt: string; hash: string }
export interface AccessRecord {
  id: 'access'; ownerId: string; state: 'locked' | 'erased'; epoch: number;
  version: number; revision: number;
  verifier?: Verifier; failures?: number; grants?: Grant[]; badAttempts?: BadAttempt[];
}
export interface LedgerRecord { id: 'ledger'; ownerId: string; epoch: number; revision: number; ledger: Ledger }
export interface Snapshot { access: AccessRecord | null; ledger: LedgerRecord | null; etag: string | null }
export interface Repository {
  read(ownerId: string): Promise<Snapshot>;
  commit(ownerId: string, expectedETag: string | null, access: AccessRecord,
    ledger: LedgerRecord | null | undefined): Promise<boolean>;
}
export interface Identity { ownerId: string }
