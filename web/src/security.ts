import { LOCKDOWN_MESSAGE, SECURITY_UNAVAILABLE_MESSAGE, type PublicServiceStatus } from '../../shared/security.js';

export type ServicePhase = 'checking' | 'open' | 'locked' | 'unavailable';
export interface ServiceSnapshot { phase: ServicePhase; generation: number | null; version: number }
export interface SecurityConfig { securityGateRequired?: boolean; securityStatusUrl?: string }
export const isServiceFailure = (code: unknown): code is 'SERVICE_LOCKED' | 'SECURITY_STATE_UNAVAILABLE' =>
  code === 'SERVICE_LOCKED' || code === 'SECURITY_STATE_UNAVAILABLE';
export class ServiceSecurityError extends Error {
  constructor(readonly code: 'SERVICE_LOCKED' | 'SECURITY_STATE_UNAVAILABLE') {
    super(code === 'SERVICE_LOCKED' ? LOCKDOWN_MESSAGE : SECURITY_UNAVAILABLE_MESSAGE);
  }
}

/** Only this small public document is accepted. Incident details never reach the app. */
export function validateServiceStatus(value: unknown): PublicServiceStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ServiceSecurityError('SECURITY_STATE_UNAVAILABLE');
  const status = value as Partial<PublicServiceStatus>;
  if (Object.keys(status).sort().join(',') !== 'generation,schemaVersion,state' || status.schemaVersion !== 1 ||
      !['open', 'locked', 'unavailable'].includes(String(status.state)) ||
      !Number.isSafeInteger(status.generation) || Number(status.generation) < 0) throw new ServiceSecurityError('SECURITY_STATE_UNAVAILABLE');
  return status as PublicServiceStatus;
}

/** In-memory only. A transition invalidates every operation from an older service state. */
export class SecurityMonitor {
  private state: ServiceSnapshot;
  private listeners = new Set<() => void>();
  private operations = new Map<AbortController, boolean>();
  private request?: AbortController;
  private requestVersion = 0;
  private highestGeneration = -1;
  private lockedGeneration = -1;
  private stopped = false;
  constructor(private config: SecurityConfig, private fetcher: typeof fetch = fetch.bind(globalThis)) {
    this.state = { phase: config.securityGateRequired ? 'checking' : 'open', generation: null, version: 0 };
  }
  snapshot = () => this.state;
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  private publish(phase: ServicePhase, generation = this.state.generation) {
    if (this.state.phase === phase && this.state.generation === generation) return;
    const suspend = phase === 'checking' || (phase === 'open' && this.state.phase === 'checking' && generation === this.state.generation);
    const version = this.state.version + (suspend ? 0 : 1);
    this.state = { phase, generation, version };
    for (const [operation, allowChecking] of this.operations) {
      if (!suspend || !allowChecking) { operation.abort(); this.operations.delete(operation); }
    }
    for (const listener of this.listeners) listener();
  }
  assertOpen(version = this.state.version, allowChecking = false) {
    const allowed = this.state.phase === 'open' || (allowChecking && this.state.phase === 'checking' && this.state.generation !== null);
    if (this.stopped || !allowed || version !== this.state.version) {
      throw new ServiceSecurityError(this.state.phase === 'locked' ? 'SERVICE_LOCKED' : 'SECURITY_STATE_UNAVAILABLE');
    }
  }
  operation(allowChecking = false) {
    this.assertOpen(undefined, allowChecking);
    const version = this.state.version, controller = new AbortController();
    this.operations.set(controller, allowChecking);
    return { signal: controller.signal, assertOpen: () => { this.assertOpen(version, allowChecking); if (controller.signal.aborted) throw new ServiceSecurityError('SECURITY_STATE_UNAVAILABLE'); }, release: () => { this.operations.delete(controller); } };
  }
  reportFailure(code: unknown) {
    if (!isServiceFailure(code)) return;
    // A reply already in flight cannot undo an API denial with an older open status.
    this.requestVersion++; this.request?.abort(); this.request = undefined;
    this.publish(code === 'SERVICE_LOCKED' ? 'locked' : 'unavailable');
  }
  /** Hide immediately; never show an old decrypted page while resume verification runs. */
  pause() {
    if (!this.config.securityGateRequired) return;
    this.requestVersion++; this.request?.abort(); this.request = undefined;
    this.publish('checking');
  }
  async check(): Promise<void> {
    if (this.stopped || !this.config.securityGateRequired || !this.config.securityStatusUrl || this.request) return;
    const controller = new AbortController(), version = ++this.requestVersion;
    this.request = controller;
    const timeout = setTimeout(() => {
      if (version !== this.requestVersion || this.stopped) return;
      this.requestVersion++; this.request = undefined; controller.abort();
      // Deny immediately even if an adapter fails to settle an aborted fetch.
      this.publish('unavailable');
    }, 5_000);
    try {
      const response = await this.fetcher(this.config.securityStatusUrl, {
        method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      const text = await response.text();
      if (text.length > 1_024) throw new ServiceSecurityError('SECURITY_STATE_UNAVAILABLE');
      const status = validateServiceStatus(JSON.parse(text));
      if (controller.signal.aborted || version !== this.requestVersion || this.stopped) return;
      if (status.generation < this.highestGeneration) throw new ServiceSecurityError('SECURITY_STATE_UNAVAILABLE');
      if (status.state !== 'unavailable' && status.generation < 1) throw new ServiceSecurityError('SECURITY_STATE_UNAVAILABLE');
      if (status.state === 'open' && status.generation <= this.lockedGeneration) throw new ServiceSecurityError('SECURITY_STATE_UNAVAILABLE');
      if (status.state === 'locked') this.lockedGeneration = status.generation;
      this.highestGeneration = status.generation;
      if (!response.ok && status.state !== 'unavailable') throw new ServiceSecurityError('SECURITY_STATE_UNAVAILABLE');
      this.publish(status.state, status.generation);
    } catch {
      if (version === this.requestVersion && !this.stopped) this.publish('unavailable');
    } finally {
      clearTimeout(timeout); if (this.request === controller) this.request = undefined;
    }
  }
  start(page: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> = document) {
    this.stopped = false;
    const visibility = () => { if (page.hidden) this.pause(); else void this.check(); };
    const poll = setInterval(() => { if (!page.hidden) void this.check(); }, 10_000);
    page.addEventListener('visibilitychange', visibility);
    if (page.hidden) this.pause(); else void this.check();
    return () => {
      this.stopped = true; this.requestVersion++; this.request?.abort(); this.request = undefined;
      for (const operation of this.operations.keys()) operation.abort(); this.operations.clear();
      clearInterval(poll); page.removeEventListener('visibilitychange', visibility);
    };
  }
}
