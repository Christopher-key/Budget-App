import type { CipherBlob } from '../../shared/cloud.js';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly epoch?: number) { super(code); }
}
export interface Grant { hash: string; sessionHash: string; issuedAt: number; expiresAt: number }
export interface BadAttempt { id: string; fingerprint: string }
export interface Verifier { salt: string; hash: string }
export interface AccountCredentials {
  salt: string; wrappedKey: CipherBlob; verifier: Verifier;
}
export interface AccountSession { hash: string; issuedAt: number; expiresAt: number }
export interface AccessRecord {
  id: 'access'; ownerId: string; state: 'new' | 'locked' | 'erased'; epoch: number;
  version: number; revision: number; credentials?: AccountCredentials; sessions?: AccountSession[];
  verifier?: Verifier; failures?: number; grants?: Grant[]; badAttempts?: BadAttempt[];
}
export interface LedgerRecord { id: 'ledger'; ownerId: string; epoch: number; revision: number; payload: CipherBlob }
export interface Snapshot { access: AccessRecord | null; ledger: LedgerRecord | null; etag: string | null }
export interface Repository {
  read(ownerId: string, includeLedger?: boolean): Promise<Snapshot>;
  commit(ownerId: string, expectedETag: string | null, access: AccessRecord,
    ledger: LedgerRecord | null | undefined): Promise<boolean>;
  consumeRate(bucket: string, limit: number, windowMs: number, now: number): Promise<boolean>;
}
export interface Identity { ownerId: string; sessionHash: string }
