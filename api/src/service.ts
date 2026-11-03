import { randomBytes } from 'node:crypto';
import { MAX_FAILED_PASSCODES, type AccountStatus, type UnlockResponse } from '../../shared/contracts.js';
import type { EncryptedBudgetEnvelope } from '../../shared/cloud.js';
import { ApiError, type AccessRecord, type Grant, type Identity, type Repository, type Snapshot } from './types.js';
import { base64url, cipher, constantEqual, counter, derive, digest, keyedHash, requireSession, serverSecret, verifier } from './security.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function pin(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}$/.test(value)) throw new ApiError(400, 'INVALID_DATA');
}

export class BudgetService {
  constructor(private readonly repository: Repository, private readonly now: () => number = Date.now,
    private readonly attemptKey: string = serverSecret(process.env.AUTH_PEPPER)) {}
  private pinSecret(value: string) { return keyedHash(this.attemptKey, 'pin', value); }
  private authenticated(snapshot: Snapshot, identity: Identity): AccessRecord {
    return requireSession(snapshot.access, identity, this.now());
  }
  private active(snapshot: Snapshot, identity: Identity): AccessRecord {
    const access = this.authenticated(snapshot, identity);
    if (access.state !== 'locked') throw new ApiError(409, 'SETUP_REQUIRED');
    if (!access.verifier) throw new ApiError(503, 'UNAVAILABLE');
    return access;
  }
  async status(identity: Identity): Promise<AccountStatus & { revision: number }> {
    const access = this.authenticated(await this.repository.read(identity.ownerId, false), identity);
    return { state: access.state, epoch: access.epoch, accountId: identity.ownerId, revision: access.revision };
  }
  private requireGrant(access: AccessRecord, identity: Identity, token: string | undefined, fresh = false): Grant {
    if (!base64url(token, 32)) throw new ApiError(423, 'LOCKED');
    const candidate = digest(token), now = this.now();
    const grant = access.grants?.find(item => constantEqual(item.hash, candidate)
      && constantEqual(item.sessionHash, identity.sessionHash) && item.expiresAt > now
      && item.issuedAt <= now + 30_000 && (!fresh || now - item.issuedAt <= 60_000));
    if (!grant) throw new ApiError(423, 'LOCKED');
    return grant;
  }
  private newGrant(access: AccessRecord, identity: Identity): { access: AccessRecord; response: UnlockResponse } {
    const token = randomBytes(32).toString('base64url'), issuedAt = this.now(), expiresAt = issuedAt + 600_000;
    const grants = (access.grants ?? []).filter(item => item.expiresAt > issuedAt).slice(-15);
    grants.push({ hash: digest(token), sessionHash: identity.sessionHash, issuedAt, expiresAt });
    return { access: { ...access, grants, version: access.version + 1 },
      response: { epoch: access.epoch, unlockToken: token, expiresAt: new Date(expiresAt).toISOString() } };
  }
  private async work(identity: Identity) {
    const now = this.now();
    if (!await this.repository.consumeRate(digest('pin-work:' + identity.ownerId), 20, 60_000, now) ||
        !await this.repository.consumeRate('global-pin-work', 120, 60_000, now)) throw new ApiError(429, 'RATE_LIMITED');
  }
  async setup(identity: Identity, input: { pin?: unknown; expectedEpoch?: unknown; startEmpty?: unknown; payload?: unknown }): Promise<UnlockResponse> {
    pin(input.pin); counter(input.expectedEpoch);
    if (input.startEmpty !== true) throw new ApiError(400, 'INVALID_DATA');
    const payload = cipher(input.payload);
    const first = await this.repository.read(identity.ownerId, false), initial = this.authenticated(first, identity);
    if (initial.state !== 'new') throw new ApiError(409, 'REVISION_CONFLICT');
    if (initial.epoch !== input.expectedEpoch) throw new ApiError(409, 'STALE_EPOCH');
    await this.work(identity);
    const saved = await verifier(this.pinSecret(input.pin));
    for (let retry = 0; retry < 32; retry++) {
      const snapshot = retry ? await this.repository.read(identity.ownerId, false) : first, previous = this.authenticated(snapshot, identity);
      if (previous.state !== 'new') throw new ApiError(409, 'REVISION_CONFLICT');
      if (previous.epoch !== input.expectedEpoch) throw new ApiError(409, 'STALE_EPOCH');
      const access: AccessRecord = { ...previous, state: 'locked', epoch: input.expectedEpoch + 1,
        version: previous.version + 1, revision: 0, verifier: saved, failures: 0, grants: [], badAttempts: [] };
      const issued = this.newGrant(access, identity);
      if (await this.repository.commit(identity.ownerId, snapshot.etag, issued.access,
        { id: 'ledger', ownerId: identity.ownerId, epoch: access.epoch, revision: 0, payload })) return issued.response;
    }
    throw new ApiError(503, 'UNAVAILABLE');
  }
  async unlock(identity: Identity, input: { pin?: unknown; attemptId?: unknown }): Promise<UnlockResponse> {
    pin(input.pin);
    if (typeof input.attemptId !== 'string' || !uuid.test(input.attemptId)) throw new ApiError(400, 'INVALID_DATA');
    const attemptId = input.attemptId.toLowerCase(), fingerprint = keyedHash(this.attemptKey, 'pin-attempt', attemptId + '\0' + input.pin);
    let permitted = false;
    let computed: { salt: string; hash: string } | undefined;
    for (let retry = 0; retry < 32; retry++) {
      const snapshot = await this.repository.read(identity.ownerId, false), access = this.active(snapshot, identity);
      const previous = access.badAttempts?.find(item => item.id === attemptId);
      if (previous) {
        if (!constantEqual(previous.fingerprint, fingerprint)) throw new ApiError(400, 'INVALID_DATA');
        throw new ApiError(401, 'INCORRECT_PASSCODE');
      }
      if (!permitted) { await this.work(identity); permitted = true; }
      const salt = access.verifier!.salt;
      if (!computed || computed.salt !== salt) computed = { salt, hash: await derive(this.pinSecret(input.pin), salt) };
      const candidate = computed.hash;
      if (constantEqual(candidate, access.verifier!.hash)) {
        const issued = this.newGrant({ ...access, failures: 0 }, identity);
        if (await this.repository.commit(identity.ownerId, snapshot.etag, issued.access, undefined)) return issued.response;
      } else {
        const failures = (access.failures ?? 0) + 1, erased = failures >= MAX_FAILED_PASSCODES;
        const updated: AccessRecord = erased ? this.tombstone(access)
          : { ...access, failures, version: access.version + 1,
            badAttempts: [...(access.badAttempts ?? []), { id: attemptId, fingerprint }].slice(-64) };
        // The access record and encrypted ledger are erased in the same CAS transaction.
        if (await this.repository.commit(identity.ownerId, snapshot.etag, updated, erased ? null : undefined)) {
          throw erased ? new ApiError(410, 'ACCOUNT_ERASED', updated.epoch) : new ApiError(401, 'INCORRECT_PASSCODE');
        }
      }
    }
    throw new ApiError(503, 'UNAVAILABLE');
  }
  private tombstone(access: AccessRecord): AccessRecord {
    // No username, proof/PIN verifier, wrapped key, session or ciphertext survives.
    return { id: 'access', ownerId: access.ownerId, state: 'erased', epoch: access.epoch + 1,
      version: access.version + 1, revision: 0 };
  }
  async budget(identity: Identity, token?: string): Promise<EncryptedBudgetEnvelope> {
    for (let retry = 0; retry < 8; retry++) {
      const first = await this.repository.read(identity.ownerId), access = this.active(first, identity);
      this.requireGrant(access, identity, token);
      if (!first.ledger || first.ledger.epoch !== access.epoch || first.ledger.revision !== access.revision) throw new ApiError(503, 'UNAVAILABLE');
      const after = await this.repository.read(identity.ownerId, false), current = this.active(after, identity);
      this.requireGrant(current, identity, token);
      if (first.etag !== after.etag) continue;
      return { epoch: access.epoch, revision: first.ledger.revision, payload: cipher(first.ledger.payload) };
    }
    throw new ApiError(503, 'UNAVAILABLE');
  }
  async save(identity: Identity, token: string | undefined,
    input: { epoch?: unknown; revision?: unknown; payload?: unknown }): Promise<{ epoch: number; revision: number }> {
    counter(input.epoch); counter(input.revision); const payload = cipher(input.payload);
    for (let retry = 0; retry < 32; retry++) {
      const snapshot = await this.repository.read(identity.ownerId), access = this.active(snapshot, identity);
      this.requireGrant(access, identity, token);
      if (input.epoch !== access.epoch) throw new ApiError(409, 'STALE_EPOCH');
      if (!snapshot.ledger || snapshot.ledger.epoch !== access.epoch || snapshot.ledger.revision !== access.revision) throw new ApiError(503, 'UNAVAILABLE');
      if (input.revision !== access.revision) throw new ApiError(409, 'REVISION_CONFLICT');
      const revision = access.revision + 1, updated = { ...access, revision, version: access.version + 1 };
      if (await this.repository.commit(identity.ownerId, snapshot.etag, updated,
        { id: 'ledger', ownerId: identity.ownerId, epoch: access.epoch, revision, payload })) return { epoch: access.epoch, revision };
    }
    throw new ApiError(503, 'UNAVAILABLE');
  }
  async lock(identity: Identity, token?: string): Promise<void> {
    if (!token) return;
    for (let retry = 0; retry < 32; retry++) {
      const snapshot = await this.repository.read(identity.ownerId, false), access = this.authenticated(snapshot, identity);
      const updated = { ...access, version: access.version + 1, grants: (access.grants ?? []).filter(item =>
        !(constantEqual(item.hash, digest(token)) && constantEqual(item.sessionHash, identity.sessionHash))) };
      if (await this.repository.commit(identity.ownerId, snapshot.etag, updated, undefined)) return;
    }
    throw new ApiError(503, 'UNAVAILABLE');
  }
  async changePin(identity: Identity, token: string | undefined, input: { newPin?: unknown }): Promise<UnlockResponse> {
    pin(input.newPin);
    const first = await this.repository.read(identity.ownerId, false), initial = this.active(first, identity);
    this.requireGrant(initial, identity, token, true);
    await this.work(identity);
    const saved = await verifier(this.pinSecret(input.newPin));
    for (let retry = 0; retry < 32; retry++) {
      const snapshot = retry ? await this.repository.read(identity.ownerId, false) : first, access = this.active(snapshot, identity);
      this.requireGrant(access, identity, token, true);
      const issued = this.newGrant({ ...access, verifier: saved, failures: 0, grants: [], badAttempts: [] }, identity);
      if (await this.repository.commit(identity.ownerId, snapshot.etag, issued.access, undefined)) return issued.response;
    }
    throw new ApiError(503, 'UNAVAILABLE');
  }
  async erase(identity: Identity, token: string | undefined, epoch: unknown): Promise<AccountStatus> {
    counter(epoch);
    for (let retry = 0; retry < 32; retry++) {
      const snapshot = await this.repository.read(identity.ownerId), access = this.active(snapshot, identity);
      this.requireGrant(access, identity, token);
      if (access.epoch !== epoch) throw new ApiError(409, 'STALE_EPOCH');
      const erased = this.tombstone(access);
      if (await this.repository.commit(identity.ownerId, snapshot.etag, erased, snapshot.ledger ? null : undefined)) {
        return { state: 'erased', epoch: erased.epoch, accountId: identity.ownerId };
      }
    }
    throw new ApiError(503, 'UNAVAILABLE');
  }
}
