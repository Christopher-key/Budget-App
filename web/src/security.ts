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

class TransientStatusFailure extends Error {}
const transientStatusCodes = new Set([502, 503, 504]);

/** Settle independently of fetch, because some adapters do not settle after abort. */
function readStatus(fetcher: typeof fetch, url: string, signal: AbortSignal, onTimeout: () => void): Promise<{ response: Response; text: string }> {
  return new Promise((resolve, reject) => {
    const attempt = new AbortController();
    let settled = false, timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, reply?: { response: Response; text: string }) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); signal.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(reply!);
    };
    const cancel = () => { finish(new Error('Status check cancelled')); attempt.abort(); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    timeout = setTimeout(() => {
      finish(new TransientStatusFailure()); attempt.abort(); onTimeout();
    }, 5_000);
    void (async () => {
      try {
        const response = await fetcher(url, {
          method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: attempt.signal,
          headers: { Accept: 'application/json' },
        });
        finish(undefined, { response, text: await response.text() });
      } catch { finish(new TransientStatusFailure()); }
    })();
  });
}

function waitForRetry(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timeout); signal.removeEventListener('abort', finish); resolve(); };
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
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
  private startupPending = true;
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
    this.startupPending = false;
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
    // One initial chain has at most three 5s attempts and 1s/2s delays (18s total).
    // Its single request slot also prevents the normal poll from overlapping retries.
    const retries = this.startupPending ? 2 : 0;
    const active = () => version === this.requestVersion && !this.stopped && !controller.signal.aborted;
    try {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const { response, text } = await readStatus(this.fetcher, this.config.securityStatusUrl, controller.signal, () => {
            if (!active() || attempt < retries) return;
            // Runtime checks and exhausted startup checks deny at the deadline itself.
            this.startupPending = false; this.requestVersion++; this.request = undefined;
            this.publish('unavailable');
          });
          if (!active()) return;
          if (text.length > 1_024) throw new ServiceSecurityError('SECURITY_STATE_UNAVAILABLE');
          let status: PublicServiceStatus;
          try {
            status = validateServiceStatus(JSON.parse(text));
          } catch (error) {
            // Gateways can return HTML/empty bodies while the public controller starts.
            if (transientStatusCodes.has(response.status)) throw new TransientStatusFailure();
            throw error;
          }
          if (status.generation < this.highestGeneration) throw new ServiceSecurityError('SECURITY_STATE_UNAVAILABLE');
          if (status.state !== 'unavailable' && status.generation < 1) throw new ServiceSecurityError('SECURITY_STATE_UNAVAILABLE');
          if (status.state === 'open' && status.generation <= this.lockedGeneration) throw new ServiceSecurityError('SECURITY_STATE_UNAVAILABLE');
          if (status.state === 'locked') this.lockedGeneration = status.generation;
          this.highestGeneration = status.generation;
          if (!response.ok && status.state !== 'unavailable') throw new ServiceSecurityError('SECURITY_STATE_UNAVAILABLE');
          if (status.state === 'unavailable' && attempt < retries && (response.ok || transientStatusCodes.has(response.status))) {
            // Keep generation=null while startup is unverified so even allowChecking operations stay denied.
            throw new TransientStatusFailure();
          }
          this.startupPending = false;
          this.publish(status.state, status.generation);
          return;
        } catch (error) {
          if (!active()) return;
          if (!(error instanceof TransientStatusFailure) || attempt === retries) {
            this.startupPending = false; this.publish('unavailable'); return;
          }
          await waitForRetry(controller.signal, (attempt + 1) * 1_000);
          if (!active()) return;
        }
      }
    } finally {
      if (this.request === controller) this.request = undefined;
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
