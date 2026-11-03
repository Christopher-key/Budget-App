import { randomUUID } from 'node:crypto';
import { ManagedIdentityCredential, type TokenCredential } from '@azure/identity';
import { BlobClient } from '@azure/storage-blob';
import type { LockdownControl, PublicServiceStatus, SecurityGate } from '../../shared/security.js';
import { ApiError } from './types.js';
import { digest } from './security.js';

const CONTROL_KEYS = 'generation,handledAlertHashes,incidentId,locked,reason,review,schemaVersion,updatedAt';
export function validateControl(value: unknown): LockdownControl {
  const v = value as Partial<LockdownControl> | null;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== CONTROL_KEYS ||
      v.schemaVersion !== 1 || typeof v.locked !== 'boolean' || !Number.isSafeInteger(v.generation) || Number(v.generation) < 1 ||
      !['initialization', 'manual', 'verified-alert', 'recovery'].includes(String(v.reason)) ||
      !['none', 'pending', 'confirmed', 'false-positive', 'remediated'].includes(String(v.review)) ||
      typeof v.updatedAt !== 'string' || v.updatedAt.length > 40 || !v.updatedAt.endsWith('Z') || !Number.isFinite(Date.parse(v.updatedAt)) ||
      !(v.incidentId === null || typeof v.incidentId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v.incidentId)) ||
      !Array.isArray(v.handledAlertHashes) || v.handledAlertHashes.length > 256 ||
      v.handledAlertHashes.some(h => typeof h !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(h)) ||
      new Set(v.handledAlertHashes).size !== v.handledAlertHashes.length) throw new ApiError(503, 'SECURITY_STATE_UNAVAILABLE');
  return structuredClone(v) as LockdownControl;
}
export interface ControlVersion { state: LockdownControl; etag: string }
export interface ControlStore {
  read(): Promise<ControlVersion>;
  /** Returns false on a competing update; never overwrites another version. */
  write(state: LockdownControl, etag: string): Promise<boolean>;
}
export function controlBlobUrl(value: string | undefined): string {
  let url: URL;
  try { url = new URL(value ?? ''); } catch { throw new ApiError(503, 'SECURITY_STATE_UNAVAILABLE'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname) ||
      url.pathname !== '/service-control/lockdown.json' || url.port || url.username || url.password || url.search || url.hash) {
    throw new ApiError(503, 'SECURITY_STATE_UNAVAILABLE');
  }
  return url.href;
}
export class BlobControlStore implements ControlStore {
  private client: BlobClient;
  constructor(url: string, credential: TokenCredential = new ManagedIdentityCredential()) {
    this.client = new BlobClient(controlBlobUrl(url), credential, { retryOptions: { maxTries: 1 } });
  }
  async read(): Promise<ControlVersion> {
    try {
      const response = await this.client.download(0, undefined, { abortSignal: AbortSignal.timeout(5_000), maxRetryRequests: 0 });
      if (!response.etag || (response.contentLength ?? 0) > 65_536 || !response.readableStreamBody) throw new Error('Invalid control blob');
      let length = 0; const parts: Buffer[] = [];
      for await (const chunk of response.readableStreamBody) {
        const bytes = Buffer.from(chunk); length += bytes.length;
        if (length > 65_536) { response.readableStreamBody.destroy(); throw new Error('Oversized control'); }
        parts.push(bytes);
      }
      return { state: validateControl(JSON.parse(Buffer.concat(parts).toString('utf8'))), etag: response.etag };
    } catch { throw new ApiError(503, 'SECURITY_STATE_UNAVAILABLE'); }
  }
  async write(state: LockdownControl, etag: string): Promise<boolean> {
    try {
      const text = JSON.stringify(validateControl(state));
      await this.client.getBlockBlobClient().upload(text, Buffer.byteLength(text), {
        conditions: { ifMatch: etag }, abortSignal: AbortSignal.timeout(5_000),
        blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' },
      });
      return true;
    } catch (error) {
      if ((error as { statusCode?: number })?.statusCode === 412) return false;
      throw new ApiError(503, 'SECURITY_STATE_UNAVAILABLE');
    }
  }
}
export class BlobSecurityGate implements SecurityGate {
  constructor(private store: ControlStore) {}
  async check(expectedGeneration?: number): Promise<number> {
    let state: LockdownControl;
    try { state = validateControl((await this.store.read()).state); }
    catch { throw new ApiError(503, 'SECURITY_STATE_UNAVAILABLE'); }
    if (state.locked) throw new ApiError(503, 'SERVICE_LOCKED');
    if (expectedGeneration !== undefined && expectedGeneration !== state.generation) throw new ApiError(401, 'AUTH_REQUIRED');
    return state.generation;
  }
  async status(): Promise<PublicServiceStatus> {
    try {
      const state = validateControl((await this.store.read()).state);
      return { schemaVersion: 1, state: state.locked ? 'locked' : 'open', generation: state.generation };
    } catch { return { schemaVersion: 1, state: 'unavailable', generation: 0 }; }
  }
}
export const disabledSecurityGate: SecurityGate = {
  async check(expectedGeneration) {
    if (expectedGeneration !== undefined && expectedGeneration !== 0) throw new ApiError(401, 'AUTH_REQUIRED');
    return 0;
  },
  async status() { return { schemaVersion: 1, state: 'open', generation: 0 }; },
};
export function productionSecurityGate(environment: NodeJS.ProcessEnv = process.env): SecurityGate {
  if (environment.SECURITY_GATE_ENFORCED === undefined || environment.SECURITY_GATE_ENFORCED === 'false') return disabledSecurityGate;
  if (environment.SECURITY_GATE_ENFORCED !== 'true') throw new ApiError(503, 'SECURITY_STATE_UNAVAILABLE');
  return new BlobSecurityGate(new BlobControlStore(controlBlobUrl(environment.LOCKDOWN_BLOB_URL)));
}

export type StopBudgetApi = () => Promise<void>;
export function budgetResourceId(value: string | undefined): string {
  if (!value || !/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]{1,90}\/providers\/Microsoft\.Web\/sites\/[A-Za-z0-9-]{2,60}$/i.test(value)) {
    throw new ApiError(503, 'SECURITY_STATE_UNAVAILABLE');
  }
  return value;
}
export function stopBudgetApi(resourceId: string, credential: TokenCredential = new ManagedIdentityCredential(), fetcher: typeof fetch = fetch): StopBudgetApi {
  const id = budgetResourceId(resourceId);
  return async () => {
    try {
      const token = await credential.getToken('https://management.azure.com/.default');
      if (!token) throw new Error('Missing workload token');
      const response = await fetcher(`https://management.azure.com${id}/stop?api-version=2023-12-01`, {
        method: 'POST', headers: { Authorization: `Bearer ${token.token}` },
        redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Stop not accepted');
      await response.body?.cancel();
    } catch { throw new ApiError(503, 'SECURITY_STOP_UNCONFIRMED'); }
  };
}
export class LockdownController {
  constructor(private store: ControlStore, private stop: StopBudgetApi, private now: () => number = Date.now) {}
  async trigger(alertId: string, firedAt = this.now()): Promise<{ locked: boolean; duplicate: boolean }> {
    const hash = digest(alertId);
    let stopAttempted = false;
    const stop = async () => { stopAttempted = true; await this.stop(); };
    try {
    for (let retry = 0; retry < 8; retry++) {
      const { state: source, etag } = await this.store.read(), current = validateControl(source);
      if (!current.locked && current.reason === 'recovery' && firedAt <= Date.parse(current.updatedAt)) {
        return { locked: false, duplicate: true };
      }
      if (current.handledAlertHashes.includes(hash)) {
        // A replay after explicit recovery cannot shut down a reopened service.
        // While locked, retry stop so an earlier ARM/network failure is recoverable.
        if (current.locked) await stop();
        return { locked: current.locked, duplicate: true };
      }
      if (current.generation >= Number.MAX_SAFE_INTEGER) throw new ApiError(503, 'SECURITY_STATE_UNAVAILABLE');
      const state: LockdownControl = { ...current, locked: true, generation: current.generation + 1,
        updatedAt: new Date(this.now()).toISOString(), reason: 'verified-alert',
        incidentId: current.locked && current.incidentId ? current.incidentId : randomUUID(), review: 'pending',
        handledAlertHashes: [...current.handledAlertHashes, hash].slice(-256) };
      if (!await this.store.write(state, etag)) continue;
      await stop();
      return { locked: true, duplicate: false };
    }
    throw new ApiError(503, 'SECURITY_STATE_UNAVAILABLE');
    } catch (error) {
      // A verified incident must still attempt physical denial if the private
      // control store is unavailable. Never report that the flag was saved.
      if (!stopAttempted) await stop();
      throw error;
    }
  }
}
