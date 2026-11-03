import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { MAX_FAILED_PASSCODES, type AccountStatus, type BudgetEnvelope, type SaveBudgetRequest,
  type UnlockResponse } from '../../shared/contracts.js';
import { emptyLedger, validateLedger } from '../../shared/model.js';
import { ApiError, type AccessRecord, type Grant, type Repository, type Snapshot, type Verifier } from './types.js';

const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function equal(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function pin(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}$/.test(value)) throw new ApiError(400, 'INVALID_DATA');
}
async function derive(value: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => scrypt(value, Buffer.from(salt, 'base64url'), 32,
    { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) =>
      error ? reject(error) : resolve(result.toString('base64url'))));
}
async function verifier(value: string): Promise<Verifier> {
  const salt = randomBytes(16).toString('base64url');
  return { salt, hash: await derive(value, salt) };
}
function integer(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ApiError(400, 'INVALID_DATA');
}

export class BudgetService {
  constructor(private readonly repository: Repository, private readonly now: () => number = Date.now) {}

  async status(ownerId: string): Promise<AccountStatus> {
    const { access } = await this.repository.read(ownerId);
    return access ? { state: access.state, epoch: access.epoch, accountId: ownerId }
      : { state: 'new', epoch: 0, accountId: ownerId };
  }

  private requireActive(snapshot: Snapshot): AccessRecord {
    if (!snapshot.access) throw new ApiError(409, 'SETUP_REQUIRED');
    if (snapshot.access.state === 'erased') throw new ApiError(410, 'ACCOUNT_ERASED', snapshot.access.epoch);
    if (!snapshot.access.verifier) throw new ApiError(503, 'UNAVAILABLE');
    return snapshot.access;
  }

  private requireGrant(access: AccessRecord, token: string | undefined, fresh = false): Grant {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError(423, 'LOCKED');
    const candidate = hash(token), now = this.now();
    const grant = access.grants?.find(item => equal(item.hash, candidate) && item.expiresAt > now
      && item.issuedAt <= now + 30_000 && (!fresh || now - item.issuedAt <= 60_000));
    if (!grant) throw new ApiError(423, 'LOCKED');
    return grant;
  }

  private newGrant(access: AccessRecord): { access: AccessRecord; response: UnlockResponse } {
    const token = randomBytes(32).toString('base64url'), issuedAt = this.now(), expiresAt = issuedAt + 600_000;
    const grants = (access.grants ?? []).filter(item => item.expiresAt > issuedAt).slice(-7);
    grants.push({ hash: hash(token), issuedAt, expiresAt });
    return { access: { ...access, grants, version: access.version + 1 },
      response: { epoch: access.epoch, unlockToken: token, expiresAt: new Date(expiresAt).toISOString() } };
  }

  async setup(ownerId: string, input: { pin?: unknown; expectedEpoch?: unknown; startEmpty?: unknown }): Promise<UnlockResponse> {
    pin(input.pin); integer(input.expectedEpoch);
    if (input.startEmpty !== true) throw new ApiError(400, 'INVALID_DATA');
    const saved = await verifier(input.pin);
    for (let retry = 0; retry < 32; retry++) {
      const snapshot = await this.repository.read(ownerId);
      if (snapshot.access?.state === 'locked') throw new ApiError(409, 'REVISION_CONFLICT');
      if ((snapshot.access?.epoch ?? 0) !== input.expectedEpoch) throw new ApiError(409, 'STALE_EPOCH');
      const access: AccessRecord = { id: 'access', ownerId, state: 'locked', epoch: input.expectedEpoch + 1,
        version: (snapshot.access?.version ?? 0) + 1, revision: 0, verifier: saved, failures: 0, grants: [], badAttempts: [] };
      const issued = this.newGrant(access);
      if (await this.repository.commit(ownerId, snapshot.etag, issued.access,
        { id: 'ledger', ownerId, epoch: access.epoch, revision: 0, ledger: emptyLedger(new Date(this.now())) })) return issued.response;
    }
    throw new ApiError(503, 'UNAVAILABLE');
  }

  async unlock(ownerId: string, input: { pin?: unknown; attemptId?: unknown }): Promise<UnlockResponse> {
    pin(input.pin);
    if (typeof input.attemptId !== 'string' || !uuid.test(input.attemptId)) throw new ApiError(400, 'INVALID_DATA');
    const attemptId = input.attemptId.toLowerCase(), fingerprint = hash(attemptId + '\0' + input.pin);
    for (let retry = 0; retry < 32; retry++) {
      const snapshot = await this.repository.read(ownerId), access = this.requireActive(snapshot);
      const previous = access.badAttempts?.find(item => item.id === attemptId);
      if (previous) {
        if (!equal(previous.fingerprint, fingerprint)) throw new ApiError(400, 'INVALID_DATA');
        throw new ApiError(401, 'INCORRECT_PASSCODE');
      }
      const candidate = await derive(input.pin, access.verifier!.salt);
      if (equal(candidate, access.verifier!.hash)) {
        const issued = this.newGrant({ ...access, failures: 0 });
        if (await this.repository.commit(ownerId, snapshot.etag, issued.access, undefined)) return issued.response;
      } else {
        const failures = (access.failures ?? 0) + 1;
        const erased = failures >= MAX_FAILED_PASSCODES;
        const updated: AccessRecord = erased
          ? this.tombstone(access)
          : { ...access, failures, version: access.version + 1,
            badAttempts: [...(access.badAttempts ?? []), { id: attemptId, fingerprint }].slice(-64) };
        if (await this.repository.commit(ownerId, snapshot.etag, updated, erased && snapshot.ledger ? null : undefined)) {
          throw erased ? new ApiError(410, 'ACCOUNT_ERASED', updated.epoch) : new ApiError(401, 'INCORRECT_PASSCODE');
        }
      }
    }
    throw new ApiError(503, 'UNAVAILABLE');
  }

  private tombstone(access: AccessRecord): AccessRecord {
    // No PIN, grants, attempt history, names, targets, or financial payload survive.
    return { id: 'access', ownerId: access.ownerId, state: 'erased', epoch: access.epoch + 1,
      version: access.version + 1, revision: 0 };
  }

  async budget(ownerId: string, token?: string): Promise<BudgetEnvelope> {
    for (let retry = 0; retry < 8; retry++) {
      const first = await this.repository.read(ownerId), access = this.requireActive(first);
      this.requireGrant(access, token);
      if (!first.ledger || first.ledger.epoch !== access.epoch || first.ledger.revision !== access.revision) {
        throw new ApiError(503, 'UNAVAILABLE');
      }
      const after = await this.repository.read(ownerId), current = this.requireActive(after);
      this.requireGrant(current, token);
      if (first.etag !== after.etag) continue;
      return { epoch: access.epoch, revision: first.ledger.revision, ledger: validateLedger(first.ledger.ledger) };
    }
    throw new ApiError(503, 'UNAVAILABLE');
  }

  async save(ownerId: string, token: string | undefined, input: SaveBudgetRequest): Promise<{ epoch: number; revision: number }> {
    integer(input.epoch); integer(input.revision);
    let ledger;
    try { ledger = validateLedger(input.ledger); }
    catch { throw new ApiError(400, 'INVALID_DATA'); }
    for (let retry = 0; retry < 32; retry++) {
      const snapshot = await this.repository.read(ownerId), access = this.requireActive(snapshot);
      this.requireGrant(access, token);
      if (input.epoch !== access.epoch) throw new ApiError(409, 'STALE_EPOCH');
      if (!snapshot.ledger || snapshot.ledger.epoch !== access.epoch || snapshot.ledger.revision !== access.revision) {
        throw new ApiError(503, 'UNAVAILABLE');
      }
      if (input.revision !== access.revision) throw new ApiError(409, 'REVISION_CONFLICT');
      const revision = access.revision + 1;
      const updated = { ...access, revision, version: access.version + 1 };
      if (await this.repository.commit(ownerId, snapshot.etag, updated,
        { id: 'ledger', ownerId, epoch: access.epoch, revision, ledger })) return { epoch: access.epoch, revision };
    }
    throw new ApiError(503, 'UNAVAILABLE');
  }

  async lock(ownerId: string, token?: string): Promise<void> {
    if (!token) return;
    for (let retry = 0; retry < 32; retry++) {
      const snapshot = await this.repository.read(ownerId);
      if (!snapshot.access || snapshot.access.state === 'erased') return;
      const access = { ...snapshot.access, version: snapshot.access.version + 1,
        grants: (snapshot.access.grants ?? []).filter(item => !equal(item.hash, hash(token))) };
      if (await this.repository.commit(ownerId, snapshot.etag, access, undefined)) return;
    }
    throw new ApiError(503, 'UNAVAILABLE');
  }

  async changePin(ownerId: string, token: string | undefined, input: { newPin?: unknown }): Promise<UnlockResponse> {
    pin(input.newPin);
    const saved = await verifier(input.newPin);
    for (let retry = 0; retry < 32; retry++) {
      const snapshot = await this.repository.read(ownerId), access = this.requireActive(snapshot);
      this.requireGrant(access, token, true);
      const issued = this.newGrant({ ...access, verifier: saved, failures: 0, grants: [], badAttempts: [] });
      if (await this.repository.commit(ownerId, snapshot.etag, issued.access, undefined)) return issued.response;
    }
    throw new ApiError(503, 'UNAVAILABLE');
  }

  async erase(ownerId: string, epoch: unknown): Promise<AccountStatus> {
    integer(epoch);
    for (let retry = 0; retry < 32; retry++) {
      const snapshot = await this.repository.read(ownerId);
      if ((snapshot.access?.epoch ?? 0) !== epoch) throw new ApiError(409, 'STALE_EPOCH');
      if (snapshot.access?.state === 'erased') return { state: 'erased', epoch, accountId: ownerId };
      const previous = snapshot.access ?? { id: 'access', ownerId, state: 'locked', epoch: 0, version: 0, revision: 0 } as AccessRecord;
      const access = this.tombstone(previous);
      if (await this.repository.commit(ownerId, snapshot.etag, access, snapshot.ledger ? null : undefined)) {
        return { state: 'erased', epoch: access.epoch, accountId: ownerId };
      }
    }
    throw new ApiError(503, 'UNAVAILABLE');
  }
}
