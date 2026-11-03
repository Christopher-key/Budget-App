import { CosmosClient, type Container, type OperationInput, type JSONObject } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import { ApiError, type AccessRecord, type LedgerRecord, type Repository, type Snapshot } from './types.js';

function status(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'code' in error) return Number(error.code);
  return undefined;
}
function body(value: unknown): JSONObject { return JSON.parse(JSON.stringify(value)) as JSONObject; }
async function batch(container: Container, operations: OperationInput[], ownerId: string): Promise<boolean> {
  try {
    const response = await container.items.batch(operations, ownerId);
    const codes = [response.code ?? 0, ...(response.result ?? []).map(item => item.statusCode)];
    if (codes.some(code => [409, 412, 424].includes(code))) return false;
    if (codes.some(code => code < 200 || code >= 300)) throw new Error('Atomic commit failed');
    return true;
  } catch (error) {
    if ([409, 412, 424].includes(status(error) ?? 0)) return false;
    throw error;
  }
}

/** Compare-and-swap credentials, grants, epochs and ciphertext in one owner partition. */
export class CosmosRepository implements Repository {
  constructor(private readonly container: Container) {}
  async read(ownerId: string, includeLedger = true): Promise<Snapshot> {
    let access: AccessRecord | null = null, ledger: LedgerRecord | null = null, etag: string | null = null;
    try {
      const response = await this.container.item('access', ownerId).read<AccessRecord>();
      if (response.resource) {
        const record = response.resource as AccessRecord & { _etag?: string };
        access = { id: 'access', ownerId, state: record.state, epoch: record.epoch, version: record.version,
          revision: record.revision, credentials: record.credentials, sessions: record.sessions,
          verifier: record.verifier, failures: record.failures, grants: record.grants, badAttempts: record.badAttempts };
        etag = record._etag ?? response.etag ?? null;
        if (!etag) throw new Error('Missing version');
      }
    } catch (error) { if (status(error) !== 404) throw error; }
    if (includeLedger && access?.state === 'locked') {
      try {
        const response = await this.container.item('ledger', ownerId).read<LedgerRecord>();
        if (response.resource) {
          const value = response.resource;
          ledger = { id: 'ledger', ownerId, epoch: value.epoch, revision: value.revision, payload: value.payload };
        }
      } catch (error) { if (status(error) !== 404) throw error; }
    }
    return { access, ledger, etag };
  }
  async commit(ownerId: string, expectedETag: string | null, access: AccessRecord,
    ledger: LedgerRecord | null | undefined): Promise<boolean> {
    if (access.ownerId !== ownerId || (ledger && ledger.ownerId !== ownerId)) throw new Error('Partition mismatch');
    const operations: OperationInput[] = expectedETag
      ? [{ operationType: 'Replace', id: 'access', ifMatch: expectedETag, resourceBody: body(access) }]
      : [{ operationType: 'Create', resourceBody: body(access) }];
    if (ledger === null) operations.push({ operationType: 'Delete', id: 'ledger' });
    else if (ledger !== undefined) operations.push(ledger.revision === 0
      ? { operationType: 'Create', resourceBody: body(ledger) }
      : { operationType: 'Replace', id: 'ledger', resourceBody: body(ledger) });
    return batch(this.container, operations, ownerId);
  }
  async consumeRate(bucket: string, limit: number, windowMs: number, now: number): Promise<boolean> {
    const ownerId = 'rate:' + bucket;
    for (let retry = 0; retry < 32; retry++) {
      let existing: { start: number; count: number; _etag?: string } | undefined;
      let etag: string | undefined;
      try {
        const response = await this.container.item('rate', ownerId).read<{ start: number; count: number; _etag?: string }>();
        existing = response.resource; etag = existing?._etag ?? response.etag;
      } catch (error) { if (status(error) !== 404) throw error; }
      const current = existing && now - existing.start < windowMs && now >= existing.start
        ? existing : { start: now, count: 0 };
      if (current.count >= limit) return false;
      const resourceBody = body({ id: 'rate', ownerId, start: current.start, count: current.count + 1,
        ttl: Math.ceil(windowMs / 1000) + 60 });
      if (existing && !etag) throw new Error('Missing version');
      const operation: OperationInput = existing
        ? { operationType: 'Replace', id: 'rate', ifMatch: etag, resourceBody }
        : { operationType: 'Create', resourceBody };
      if (await batch(this.container, [operation], ownerId)) return true;
    }
    throw new ApiError(503, 'UNAVAILABLE');
  }
}

/** Synthetic tests only. Production never chooses an in-memory identity/database. */
export class MemoryRepository implements Repository {
  private records = new Map<string, Snapshot>();
  private rates = new Map<string, { start: number; count: number }>();
  private version = 0;
  async read(ownerId: string, includeLedger = true): Promise<Snapshot> {
    const snapshot = structuredClone(this.records.get(ownerId) ?? { access: null, ledger: null, etag: null });
    if (!includeLedger) snapshot.ledger = null;
    return snapshot;
  }
  async commit(ownerId: string, expectedETag: string | null, access: AccessRecord,
    ledger: LedgerRecord | null | undefined): Promise<boolean> {
    const existing = this.records.get(ownerId) ?? { access: null, ledger: null, etag: null };
    if (existing.etag !== expectedETag) return false;
    if (access.ownerId !== ownerId || (ledger && ledger.ownerId !== ownerId)) throw new Error('Partition mismatch');
    this.records.set(ownerId, structuredClone({ access, etag: String(++this.version),
      ledger: ledger === undefined ? existing.ledger : ledger }));
    return true;
  }
  async consumeRate(bucket: string, limit: number, windowMs: number, now: number): Promise<boolean> {
    const stored = this.rates.get(bucket);
    const current = stored && now - stored.start < windowMs && now >= stored.start ? stored : { start: now, count: 0 };
    if (current.count >= limit) return false;
    this.rates.set(bucket, { start: current.start, count: current.count + 1 });
    return true;
  }
}

export function productionRepository(): Repository {
  const endpoint = process.env.COSMOS_ENDPOINT, database = process.env.DATABASE_NAME, container = process.env.CONTAINER_NAME;
  if (!endpoint || !database || !container || new URL(endpoint).protocol !== 'https:') throw new Error('Missing database configuration');
  const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential(),
    connectionPolicy: { enableEndpointDiscovery: false } });
  return new CosmosRepository(client.database(database).container(container));
}
