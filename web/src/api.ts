import type { AccountStatus, BudgetEnvelope, Ledger, UnlockResponse } from '../../shared/contracts.js';
import { UNLOCK_HEADER } from '../../shared/contracts.js';
import { validateLedger, monthId, newMonth } from '../../shared/model.js';
import type { AuthSession, PublicConfig } from './auth.js';

export class ApiError extends Error {
  constructor(public code: string, public status: number, public epoch?: number) { super(code); }
}
const validCounter = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function validateGrant(value: UnlockResponse): UnlockResponse {
  if (!value || !validCounter(value.epoch) || typeof value.unlockToken !== 'string' ||
      !value.unlockToken || value.unlockToken.length > 2048 || typeof value.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) {
    throw new ApiError('UNAVAILABLE', 503);
  }
  return value;
}
export class BudgetApi {
  private grant = '';
  private generation = 0;
  private pending = new Set<AbortController>();
  constructor(private config: PublicConfig, private auth: AuthSession, private fetcher: typeof fetch = fetch.bind(globalThis)) {}
  setGrant(value: string) { this.grant = value; }
  isAuthenticated() { return !!this.auth.accessToken && Date.now() < this.auth.expiresAt; }
  clear() {
    this.grant = ''; this.generation++;
    for (const request of this.pending) request.abort();
    this.pending.clear();
  }
  forgetAuthentication() { this.clear(); this.auth = { accessToken: '', expiresAt: 0 }; }
  async request<T>(path: string, method = 'GET', body?: unknown, unlocked = false): Promise<T> {
    if (!this.isAuthenticated()) throw new ApiError('AUTH_REQUIRED', 401);
    if (unlocked && !this.grant) throw new ApiError('LOCKED', 401);
    const generation = this.generation;
    const controller = new AbortController(); this.pending.add(controller);
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.auth.accessToken}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (unlocked) headers[UNLOCK_HEADER] = this.grant;
      const response = await this.fetcher(this.config.apiBaseUrl + '/api/' + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
      });
      if (generation !== this.generation) throw new ApiError('LOCKED', 401);
      let value: any;
      try { value = await response.json(); } catch { throw new ApiError('UNAVAILABLE', response.status); }
      if (generation !== this.generation) throw new ApiError('LOCKED', 401);
      if (!response.ok) throw new ApiError(typeof value?.code === 'string' ? value.code : 'UNAVAILABLE', response.status,
        validCounter(value?.epoch) ? value.epoch : undefined);
      return value as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('UNAVAILABLE', 503);
    } finally { this.pending.delete(controller); }
  }
  status() { return this.request<AccountStatus>('account/status'); }
  setup(pin: string, expectedEpoch: number) { return this.request<UnlockResponse>('account/setup', 'POST', { pin, expectedEpoch, startEmpty: true }); }
  unlock(pin: string) { return this.request<UnlockResponse>('account/unlock', 'POST', { pin, attemptId: crypto.randomUUID() }); }
  budget() { return this.request<BudgetEnvelope>('budget', 'GET', undefined, true); }
  save(epoch: number, revision: number, ledger: Ledger) {
    return this.request<{ epoch: number; revision: number }>('budget', 'PUT', { epoch, revision, ledger: validateLedger(ledger) }, true);
  }
  changePin(newPin: string) { return this.request<UnlockResponse>('account/pin', 'POST', { newPin }, true); }
  erase(epoch: number) { return this.request<{ epoch: number }>('account', 'DELETE', { epoch }); }
  async revoke() {
    if (!this.grant || !this.isAuthenticated()) return;
    // Isolated best-effort request: completion must never clear a later session.
    const headers = { Authorization: `Bearer ${this.auth.accessToken}`, [UNLOCK_HEADER]: this.grant, 'Content-Type': 'application/json' };
    try { await this.fetcher(this.config.apiBaseUrl + '/api/account/lock', { method: 'POST', headers, body: '{}', credentials: 'omit', cache: 'no-store', redirect: 'error', keepalive: true }); } catch { /* lease expiry is enforced by the server */ }
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
  private version = 0;
  constructor(public readonly api: BudgetApi) {}
  snapshot = () => this.state;
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  private publish(patch: Partial<SessionState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  private clear(phase: SessionPhase, message = '', epoch = this.state.epoch) {
    this.version++; clearTimeout(this.timer); clearTimeout(this.lease); this.queue = undefined; this.saving = false;
    this.api.clear(); this.publish({ phase, epoch, ledger: undefined, saving: false, message });
  }
  private failure(error: unknown) {
    const code = error instanceof ApiError ? error.code : 'UNAVAILABLE';
    if (code === 'ACCOUNT_ERASED' || code === 'STALE_EPOCH') {
      this.clear('erased', 'Your account budget data has been erased.', error instanceof ApiError ? error.epoch : undefined);
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
      if (status.state === 'erased') { this.clear('erased', 'Your account budget data has been erased.', status.epoch); return; }
      if (this.state.phase === 'ready' && (status.epoch !== this.state.epoch || status.state !== 'locked')) {
        this.clear('locked', 'This account changed. Unlock to load its current budget.', status.epoch); return;
      }
      if (this.state.phase !== 'ready') this.publish({ phase: status.state === 'new' ? 'new' : 'locked', epoch: status.epoch, message: '' });
    } catch (error) { if (version === this.version) this.failure(error); }
  }
  async open(pin: string, create = false) {
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
        const result = await this.api.save(this.state.epoch, this.state.revision, ledger);
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
    try { const response = await this.api.erase(this.state.epoch); if (!response || !validCounter(response.epoch)) throw new ApiError('UNAVAILABLE', 503); if (version === this.version) this.clear('erased', 'Your account budget data has been erased.', response.epoch); }
    catch (error) { if (version === this.version) this.failure(error); }
  }
  lock = () => {
    // Best-effort revocation starts with the old grant, then all financial state drops immediately.
    const revoke = this.api.revoke();
    this.clear('locked'); void revoke;
  };
  dispose() { const revoke = this.api.revoke(); this.clear('signedOut'); this.api.forgetAuthentication(); this.listeners.clear(); void revoke; }
}
