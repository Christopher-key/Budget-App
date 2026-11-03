import type { AccountStatus, BudgetEnvelope, Ledger, UnlockResponse } from '../../shared/contracts.js';
import type { EncryptedBudgetEnvelope } from '../../shared/cloud.js';
import { UNLOCK_HEADER } from '../../shared/contracts.js';
import { emptyLedger, validateLedger, monthId, newMonth } from '../../shared/model.js';
import type { AuthSession, PublicConfig } from './auth.js';
import { isServiceFailure, SecurityMonitor, ServiceSecurityError } from './security.js';
import { decryptLedger, encryptLedger } from './crypto.js';

export class ApiError extends Error {
  constructor(public code: string, public status: number, public epoch?: number) { super(code); }
}
const validCounter = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function validateGrant(value: UnlockResponse): UnlockResponse {
  if (!value || !validCounter(value.epoch) || typeof value.unlockToken !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.unlockToken) || typeof value.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now() ||
      Date.parse(value.expiresAt) > Date.now() + 610_000) throw new ApiError('UNAVAILABLE', 503);
  return value;
}
export class BudgetApi {
  private grant = '';
  private generation = 0;
  private emergencyGeneration = 0;
  private pending = new Map<AbortController, { write: boolean; retained: boolean }>();
  private auth: AuthSession | undefined;
  constructor(private config: PublicConfig, auth: AuthSession, private fetcher: typeof fetch = fetch.bind(globalThis), public readonly security?: SecurityMonitor) { this.auth = auth; }
  emergencyDiscard() { this.emergencyGeneration++; this.forgetAuthentication(); }
  setGrant(value: string) { this.grant = value; }
  isAuthenticated() { return !!this.auth?.accessToken && Date.now() < this.auth.expiresAt; }
  clear(preserveWrites = false) {
    this.grant = ''; this.generation++;
    for (const [controller, request] of this.pending) {
      if (preserveWrites && request.write) request.retained = true;
      else { controller.abort(); this.pending.delete(controller); }
    }
  }
  forgetAuthentication(preserveWrites = false) { this.clear(preserveWrites); this.auth = undefined; }
  private authenticated(): AuthSession {
    if (!this.auth || !this.isAuthenticated()) throw new ApiError('AUTH_REQUIRED', 401);
    return this.auth;
  }
  async request<T>(path: string, method = 'GET', body?: unknown, unlocked = false): Promise<T> {
    const accessToken = this.authenticated().accessToken;
    if (unlocked && !this.grant) throw new ApiError('LOCKED', 423);
    const operation = this.security?.operation(true);
    // Capture the lease while it is active. An encrypted write already being
    // prepared may finish after locking; later requests cannot reuse this lease.
    const grant = this.grant;
    const generation = this.generation;
    const controller = new AbortController();
    const request = { write: path === 'budget' && method === 'PUT', retained: false };
    this.pending.set(controller, request);
    const abort = () => controller.abort();
    operation?.signal.addEventListener('abort', abort, { once: true });
    try {
      operation?.assertOpen();
      const preparedBody = await body;
      operation?.assertOpen();
      if (generation !== this.generation && !request.retained) throw new ApiError('LOCKED', 423);
      if (controller.signal.aborted) throw new ApiError('UNAVAILABLE', 503);
      const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
      if (preparedBody !== undefined) headers['Content-Type'] = 'application/json';
      if (unlocked) headers[UNLOCK_HEADER] = grant;
      const response = await this.fetcher(this.config.apiBaseUrl + '/api/' + path, {
        method, headers, body: preparedBody === undefined ? undefined : JSON.stringify(preparedBody),
        credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
      });
      if (generation !== this.generation && !request.retained) throw new ApiError('LOCKED', 423);
      operation?.assertOpen();
      if (response.status === 204 && response.ok) return undefined as T;
      let value: any;
      try { value = await response.json(); } catch { throw new ApiError('UNAVAILABLE', response.status); }
      if (generation !== this.generation && !request.retained) throw new ApiError('LOCKED', 423);
      if (!response.ok) {
        this.security?.reportFailure(value?.code);
        throw new ApiError(typeof value?.code === 'string' ? value.code : 'UNAVAILABLE', response.status, validCounter(value?.epoch) ? value.epoch : undefined);
      }
      operation?.assertOpen();
      return value as T;
    } catch (error) {
      if (error instanceof ServiceSecurityError || error instanceof ApiError) throw error;
      operation?.assertOpen();
      throw new ApiError('UNAVAILABLE', 503);
    } finally { this.pending.delete(controller); operation?.signal.removeEventListener('abort', abort); operation?.release(); }
  }
  async status() {
    const accountId = this.authenticated().accountId;
    const value = await this.request<AccountStatus>('account/status');
    if (!value || value.accountId !== accountId) throw new ApiError('UNAVAILABLE', 503);
    return value;
  }
  async setup(pin: string, expectedEpoch: number) {
    const auth = this.authenticated(), generation = this.generation;
    const payload = await encryptLedger(auth.dataKey, auth.accountId, expectedEpoch + 1, 0, emptyLedger());
    if (generation !== this.generation) throw new ApiError('LOCKED', 423);
    return this.request<UnlockResponse>('account/setup', 'POST', { pin, expectedEpoch, startEmpty: true, payload });
  }
  unlock(pin: string) { return this.request<UnlockResponse>('account/unlock', 'POST', { pin, attemptId: crypto.randomUUID() }); }
  async budget(): Promise<BudgetEnvelope> {
    const auth = this.authenticated(), generation = this.generation;
    const value = await this.request<EncryptedBudgetEnvelope>('budget', 'GET', undefined, true);
    if (!value || !validCounter(value.epoch) || !validCounter(value.revision) || 'ledger' in value) throw new ApiError('UNAVAILABLE', 503);
    let ledger: Ledger;
    try { ledger = await decryptLedger(auth.dataKey, auth.accountId, value.epoch, value.revision, value.payload); }
    catch { throw new ApiError('INVALID_ENCRYPTION', 503); }
    if (generation !== this.generation) throw new ApiError('LOCKED', 423);
    return { epoch: value.epoch, revision: value.revision, ledger };
  }
  async save(epoch: number, revision: number, ledger: Ledger) {
    const auth = this.authenticated();
    const encrypted = encryptLedger(auth.dataKey, auth.accountId, epoch, revision + 1, ledger);
    // Register the write before Web Crypto resolves so locking can retain and
    // await this operation even when it has not reached fetch() yet.
    return this.request<{ epoch: number; revision: number }>('budget', 'PUT',
      encrypted.then(payload => ({ epoch, revision, payload })), true);
  }
  changePin(newPin: string) { return this.request<UnlockResponse>('account/pin', 'POST', { newPin }, true); }
  erase(epoch: number) { return this.request<{ epoch: number }>('account', 'DELETE', { epoch }, true); }
  async revoke() {
    if (!this.grant || !this.isAuthenticated() || !this.auth) return;
    try { this.security?.assertOpen(undefined, true); } catch { return; }
    // Captured credentials belong to this lease only; completion cannot affect a later session.
    const headers = { Authorization: `Bearer ${this.auth.accessToken}`, [UNLOCK_HEADER]: this.grant, 'Content-Type': 'application/json' };
    try { await this.fetcher(this.config.apiBaseUrl + '/api/account/lock', { method: 'POST', headers, body: '{}', credentials: 'omit', cache: 'no-store', redirect: 'error', keepalive: true }); } catch { /* the server enforces lease expiry */ }
  }
  /** Start encryption before clearing UI state. Only ciphertext is queued for this bounded flush. */
  finishBeforeLock(epoch: number, revision: number, queued: Ledger | undefined,
    active: Promise<{ epoch: number; revision: number }> | undefined): Promise<boolean> {
    if (!this.auth || !this.isAuthenticated() || !this.grant) return Promise.resolve(!queued && !active);
    const headers = { Authorization: `Bearer ${this.auth.accessToken}`, [UNLOCK_HEADER]: this.grant, 'Content-Type': 'application/json' };
    const emergencyGeneration = this.emergencyGeneration;
    const operation = this.security?.operation(true);
    const ensureSafe = () => {
      if (emergencyGeneration !== this.emergencyGeneration) throw new ApiError('SERVICE_LOCKED', 503);
      operation?.assertOpen();
    };
    const expectedRevision = revision + (active ? 1 : 0);
    const expectedEpoch = epoch;
    let encrypted: Promise<{ payload?: import('../../shared/cloud.js').CipherBlob; failed?: true }> | undefined;
    try { if (queued) encrypted = encryptLedger(this.auth.dataKey, this.auth.accountId, epoch, expectedRevision + 1, queued)
      .then(payload => ({ payload }), () => ({ failed: true as const })); }
    catch { return this.revoke().then(() => false); }
    const existingWrites = [...this.pending].filter(([, request]) => request.write).map(([controller]) => controller);
    const controller = new AbortController();
    this.pending.set(controller, { write: true, retained: false });
    const abort = () => controller.abort();
    operation?.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => { controller.abort(); for (const request of existingWrites) request.abort(); }, 8_000);
    // Promise.race is also necessary for adapters/browsers that do not honor abort.
    let expire!: () => void;
    const expired = new Promise<never>((_, reject) => { expire = () => reject(new ApiError('UNAVAILABLE', 503)); });
    controller.signal.addEventListener('abort', expire, { once: true });
    const prepared = encrypted; // No plaintext ledger is captured by the async continuation.
    queued = undefined;
    return (async () => {
      let saved = true;
      try {
        ensureSafe();
        if (active) {
          const acknowledged = await Promise.race([active, expired]);
          ensureSafe();
          if (acknowledged.epoch !== expectedEpoch || acknowledged.revision !== expectedRevision) throw new ApiError('REVISION_CONFLICT', 409);
        }
        if (prepared) {
          const result = await Promise.race([prepared, expired]);
          if (result.failed || !result.payload) throw new ApiError('INVALID_ENCRYPTION', 503);
          ensureSafe();
          const payload = result.payload;
          const response = await Promise.race([this.fetcher(this.config.apiBaseUrl + '/api/budget', {
            method: 'PUT', headers, body: JSON.stringify({ epoch: expectedEpoch, revision: expectedRevision, payload }),
            credentials: 'omit', cache: 'no-store', redirect: 'error', keepalive: true, signal: controller.signal,
          }), expired]);
          ensureSafe();
          if (!response.ok) {
            let code = response.status === 401 ? 'AUTH_REQUIRED' : response.status === 410 ? 'ACCOUNT_ERASED' : 'UNAVAILABLE';
            try {
              const failure = await Promise.race([response.json(), expired]);
              if (isServiceFailure(failure?.code)) { this.security?.reportFailure(failure.code); code = failure.code; }
              else if (['AUTH_REQUIRED', 'ACCOUNT_ERASED', 'STALE_EPOCH', 'REVISION_CONFLICT'].includes(failure?.code)) code = failure.code;
            } catch { /* HTTP authentication/deletion failures still clear account keys. */ }
            throw new ApiError(code, response.status);
          }
          const value = await Promise.race([response.json(), expired]);
          ensureSafe();
          if (value?.epoch !== expectedEpoch || value?.revision !== expectedRevision + 1) throw new ApiError('UNAVAILABLE', 503);
        }
      } catch (error) {
        saved = false;
        if (error instanceof ApiError && ['AUTH_REQUIRED', 'ACCOUNT_ERASED', 'STALE_EPOCH'].includes(error.code)) this.forgetAuthentication();
      }
      finally {
        clearTimeout(timeout); controller.signal.removeEventListener('abort', expire);
        this.pending.delete(controller); operation?.signal.removeEventListener('abort', abort); operation?.release();
        // Revoke only after the final save acknowledgement/failure. This captured
        // lease cannot revoke an unlock performed later on the same page.
        try { ensureSafe(); await this.fetcher(this.config.apiBaseUrl + '/api/account/lock', { method: 'POST', headers, body: '{}', credentials: 'omit', cache: 'no-store', redirect: 'error', keepalive: true, signal: AbortSignal.timeout(3_000) }); } catch { /* server lease expiry remains authoritative */ }
      }
      return saved;
    })();
  }
  async logout(after?: Promise<unknown>) {
    if (!this.auth || !this.isAuthenticated()) return;
    const headers = { Authorization: `Bearer ${this.auth.accessToken}`, 'Content-Type': 'application/json' };
    const emergencyGeneration = this.emergencyGeneration;
    try {
      await after;
      if (emergencyGeneration !== this.emergencyGeneration) return;
      this.security?.assertOpen(undefined, true);
      await this.fetcher(this.config.apiBaseUrl + '/api/auth/logout', { method: 'POST', headers, body: '{}', credentials: 'omit', cache: 'no-store', redirect: 'error', keepalive: true, signal: AbortSignal.timeout(3_000) });
    } catch { /* the server enforces account-session expiry */ }
  }
}

export type SessionPhase = 'checking' | 'new' | 'locked' | 'ready' | 'erased' | 'conflict' | 'unavailable' | 'signedOut';
export interface SessionState { accountId?: string; phase: SessionPhase; epoch: number; revision: number; ledger?: Ledger; saving: boolean; message: string }
const initial: SessionState = { phase: 'checking', epoch: 0, revision: 0, saving: false, message: '' };
export class BudgetSession {
  private state: SessionState = { ...initial };
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private lease?: ReturnType<typeof setTimeout>;
  private queue?: Ledger;
  private saving = false;
  private inFlight?: Promise<void>;
  private activeSave?: Promise<{ epoch: number; revision: number }>;
  private locking?: Promise<boolean>;
  private version = 0;
  private discarded = false;
  private stopSecurity?: () => void;
  constructor(public readonly api: BudgetApi) {
    if (api.security) {
      const version = api.security.snapshot().version;
      this.stopSecurity = api.security.subscribe(() => {
        if (api.security!.snapshot().version !== version) this.emergencyDiscard();
      });
    }
  }
  /** Incident path: discard immediately, with no save, logout, revoke or export. */
  emergencyDiscard = () => {
    if (this.discarded) return;
    this.discarded = true; this.stopSecurity?.(); this.stopSecurity = undefined;
    this.api.emergencyDiscard();
    this.clear('signedOut', 'Service access is paused. Sign in again when it is restored.');
    this.activeSave = undefined; this.inFlight = undefined; this.locking = undefined;
  };
  snapshot = () => this.state;
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  private publish(patch: Partial<SessionState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  private clear(phase: SessionPhase, message = '', epoch = this.state.epoch, preserveWrites = false) {
    this.version++; clearTimeout(this.timer); clearTimeout(this.lease); this.queue = undefined; this.saving = false;
    this.api.clear(preserveWrites); this.publish({ phase, epoch, ledger: undefined, saving: false, message });
  }
  private failure(error: unknown) {
    const code = error instanceof ApiError || error instanceof ServiceSecurityError ? error.code : 'UNAVAILABLE';
    if (isServiceFailure(code)) { this.api.security?.reportFailure(code); this.emergencyDiscard(); return; }
    if (code === 'ACCOUNT_ERASED' || code === 'STALE_EPOCH') {
      this.api.forgetAuthentication(); this.clear('erased', 'Your account and budget have been erased. Create an account to start again.', error instanceof ApiError ? error.epoch : undefined);
    } else if (code === 'AUTH_REQUIRED') {
      this.api.forgetAuthentication(); this.clear('signedOut', 'Please sign in again.');
    } else if (code === 'INCORRECT_PASSCODE') {
      this.publish({ message: 'Incorrect passcode.' });
    } else if (code === 'REVISION_CONFLICT') {
      this.clear('conflict', 'Another device saved a newer budget. Unlock to reload its latest version.');
    } else if (code === 'LOCKED') this.clear('locked', 'Unlock to continue.');
    else this.clear('unavailable', 'The secure connection is unavailable. Reconnect and unlock to continue.');
  }
  async checkStatus() {
    const version = this.version;
    try {
      const status = await this.api.status();
      if (version !== this.version) return;
      if (!status || typeof status.accountId !== 'string' || !status.accountId || !validCounter(status.epoch) || !['new', 'locked', 'erased'].includes(status.state)) throw new ApiError('UNAVAILABLE', 503);
      if (this.state.accountId && this.state.accountId !== status.accountId) { this.clear('locked', 'Sign in again to load this account.'); return; }
      this.publish({ accountId: status.accountId });
      if (status.state === 'erased') { this.api.forgetAuthentication(); this.clear('erased', 'Your account and budget have been erased.', status.epoch); return; }
      if (this.state.phase === 'ready' && (status.epoch !== this.state.epoch || status.state !== 'locked')) {
        this.clear('locked', 'This account changed. Unlock to load its current budget.', status.epoch); return;
      }
      if (this.state.phase === 'ready' && status.revision !== undefined && status.revision !== this.state.revision) {
        if (!validCounter(status.revision) || status.revision < this.state.revision) throw new ApiError('UNAVAILABLE', 503);
        if (this.queue || this.saving) return; // The save CAS resolves any concurrent edit without overwriting it.
        const currentRevision = this.state.revision;
        const budget = await this.api.budget();
        if (version !== this.version || this.state.phase !== 'ready' || this.queue || this.saving || this.state.revision !== currentRevision) return;
        if (budget.epoch !== this.state.epoch) throw new ApiError('STALE_EPOCH', 410);
        if (!validCounter(budget.revision) || budget.revision < currentRevision) throw new ApiError('UNAVAILABLE', 503);
        this.publish({ revision: budget.revision, ledger: validateLedger(budget.ledger) });
      }
      if (this.state.phase !== 'ready') this.publish({ phase: status.state === 'new' ? 'new' : 'locked', epoch: status.epoch, message: '' });
    } catch (error) { if (version === this.version) this.failure(error); }
  }
  async open(pin: string, create = false) {
    if (this.locking) await this.locking;
    const version = this.version;
    try {
      const grant = validateGrant(create ? await this.api.setup(pin, this.state.epoch) : await this.api.unlock(pin));
      if (version !== this.version) return;
      this.api.setGrant(grant.unlockToken);
      const budget = await this.api.budget();
      if (version !== this.version) return;
      if (!budget || budget.epoch !== grant.epoch) throw new ApiError('STALE_EPOCH', 410);
      if (!validCounter(budget.revision)) throw new ApiError('UNAVAILABLE', 503);
      const ledger = validateLedger(budget.ledger);
      this.publish({ phase: 'ready', epoch: budget.epoch, revision: budget.revision, ledger, saving: false, message: '' });
      clearTimeout(this.lease);
      this.lease = setTimeout(() => this.lock(), Math.max(0, Date.parse(grant.expiresAt) - Date.now()));
      if (!ledger.months.some(month => month.id === monthId())) this.edit({ ...ledger, months: [...ledger.months, newMonth(monthId(), ledger.payFrequency)] });
    } catch (error) { if (version === this.version) this.failure(error); }
  }
  edit(ledger: Ledger) {
    if (this.state.phase !== 'ready') return;
    try { validateLedger(ledger); } catch { this.publish({ message: 'Correct the invalid entry before saving.' }); return; }
    this.publish({ ledger, saving: true, message: '' }); this.queue = structuredClone(ledger);
    clearTimeout(this.timer); this.timer = setTimeout(() => { void this.flush(); }, 450);
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.inFlight) return this.inFlight.then(() => this.queue ? this.flush() : undefined);
    if (this.state.phase !== 'ready') return Promise.resolve();
    const task = this.drain();
    this.inFlight = task;
    return task.finally(() => { if (this.inFlight === task) this.inFlight = undefined; });
  }
  private async drain(): Promise<void> {
    this.saving = true;
    const version = this.version;
    try {
      while (this.queue && this.state.phase === 'ready' && version === this.version) {
        const ledger = this.queue; this.queue = undefined;
        const operation = this.api.save(this.state.epoch, this.state.revision, ledger);
        this.activeSave = operation;
        let result: { epoch: number; revision: number };
        try { result = await operation; }
        finally { if (this.activeSave === operation) this.activeSave = undefined; }
        if (version !== this.version) return;
        if (!result || result.epoch !== this.state.epoch) throw new ApiError('STALE_EPOCH', 410);
        if (!validCounter(result.revision) || result.revision !== this.state.revision + 1) throw new ApiError('UNAVAILABLE', 503);
        this.publish({ revision: result.revision });
      }
      if (version === this.version) this.publish({ saving: false });
    } catch (error) { if (version === this.version) this.failure(error); }
    finally { if (version === this.version) this.saving = false; }
  }
  async reauthenticate(pin: string): Promise<boolean> {
    const version = this.version;
    try {
      const grant = validateGrant(await this.api.unlock(pin));
      if (version !== this.version) return false;
      if (grant.epoch !== this.state.epoch) throw new ApiError('STALE_EPOCH', 410);
      this.api.setGrant(grant.unlockToken); clearTimeout(this.lease);
      this.lease = setTimeout(() => this.lock(), Math.max(0, Date.parse(grant.expiresAt) - Date.now()));
      return true;
    } catch (error) { if (version === this.version) this.failure(error); return false; }
  }
  async setPin(current: string, next: string): Promise<boolean> {
    if (!await this.reauthenticate(current)) return false;
    const version = this.version;
    try {
      const grant = validateGrant(await this.api.changePin(next));
      if (version !== this.version) return false;
      if (grant.epoch !== this.state.epoch) throw new ApiError('STALE_EPOCH', 410);
      this.api.setGrant(grant.unlockToken); clearTimeout(this.lease);
      this.lease = setTimeout(() => this.lock(), Math.max(0, Date.parse(grant.expiresAt) - Date.now()));
      return true;
    } catch (error) { if (version === this.version) this.failure(error); return false; }
  }
  async erase() {
    const version = this.version;
    try { const response = await this.api.erase(this.state.epoch); if (!response || !validCounter(response.epoch)) throw new ApiError('UNAVAILABLE', 503); if (version === this.version) { this.api.forgetAuthentication(); this.clear('erased', 'Your account and budget have been erased.', response.epoch); } }
    catch (error) { if (version === this.version) this.failure(error); }
  }
  lock = () => {
    if (this.discarded) return Promise.resolve(false);
    if (this.locking && this.state.phase !== 'ready') return this.locking;
    const saving = this.api.finishBeforeLock(this.state.epoch, this.state.revision, this.queue, this.activeSave);
    this.clear('locked', '', this.state.epoch, true);
    const version = this.version;
    this.locking = saving;
    void saving.then(saved => {
      if (this.locking === saving) this.locking = undefined;
      if (!saved && version === this.version) this.publish(this.api.isAuthenticated()
        ? { message: 'Your last edit could not be confirmed. Unlock to reload the saved budget.' }
        : { phase: 'signedOut', message: 'Your account session has ended. Sign in again.' });
    });
    return saving;
  };
  dispose() {
    this.stopSecurity?.(); this.stopSecurity = undefined;
    if (this.discarded) { this.listeners.clear(); return; }
    this.lock();
    const logout = this.api.logout(this.locking);
    this.clear('signedOut', '', this.state.epoch, true);
    this.api.forgetAuthentication(true); this.listeners.clear(); void logout;
  }
}
