import { CosmosClient, type Container, type OperationInput, type JSONObject } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import type { AccessRecord, LedgerRecord, Repository, Snapshot } from './types.js';

function status(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'code' in error) return Number(error.code);
  return undefined;
}

/** All writes, including financial writes, CAS the access document in one partition batch. */
export class CosmosRepository implements Repository {
  constructor(private readonly container: Container) {}

  async read(ownerId: string): Promise<Snapshot> {
    let access: AccessRecord | null = null, ledger: LedgerRecord | null = null, etag: string | null = null;
    try {
      const response = await this.container.item('access', ownerId).read<AccessRecord>();
      if (response.resource) {
        const record = response.resource as AccessRecord & { _etag?: string };
        access = {
          id: 'access', ownerId, state: record.state, epoch: record.epoch, version: record.version,
          revision: record.revision, verifier: record.verifier, failures: record.failures,
          grants: record.grants, badAttempts: record.badAttempts,
        };
        etag = record._etag ?? response.etag ?? null;
        if (!etag) throw new Error('Missing version');
      }
    } catch (error) { if (status(error) !== 404) throw error; }
    if (access?.state === 'locked') {
      try {
        const response = await this.container.item('ledger', ownerId).read<LedgerRecord>();
        if (response.resource) {
          const value = response.resource;
          ledger = { id: 'ledger', ownerId, epoch: value.epoch, revision: value.revision, ledger: value.ledger };
        }
      } catch (error) { if (status(error) !== 404) throw error; }
    }
    return { access, ledger, etag };
  }

  async commit(ownerId: string, expectedETag: string | null, access: AccessRecord,
               ledger: LedgerRecord | null | undefined): Promise<boolean> {
    if (access.ownerId !== ownerId || (ledger && ledger.ownerId !== ownerId)) throw new Error('Partition mismatch');
    const accessBody = JSON.parse(JSON.stringify(access)) as JSONObject;
    const operations: OperationInput[] = expectedETag
      ? [{ operationType: 'Replace', id: 'access', ifMatch: expectedETag, resourceBody: accessBody }]
      : [{ operationType: 'Create', resourceBody: accessBody }];
    if (ledger === null) operations.push({ operationType: 'Delete', id: 'ledger' });
    else if (ledger !== undefined) {
      const resourceBody = JSON.parse(JSON.stringify(ledger)) as JSONObject;
      operations.push(ledger.revision === 0
        ? { operationType: 'Create', resourceBody }
        : { operationType: 'Replace', id: 'ledger', resourceBody });
    }
    try {
      const response = await this.container.items.batch(operations, ownerId);
      const codes = [response.code ?? 0, ...(response.result ?? []).map(item => item.statusCode)];
      if (codes.some(code => [409, 412, 424].includes(code))) return false;
      if (codes.some(code => code < 200 || code >= 300)) throw new Error('Atomic commit failed');
      return true;
    } catch (error) {
      if ([409, 412, 424].includes(status(error) ?? 0)) return false;
      throw error;
    }
  }
}

/** Test adapter only. Production functions never select this adapter. */
export class MemoryRepository implements Repository {
  private records = new Map<string, Snapshot>();
  private version = 0;
  async read(ownerId: string): Promise<Snapshot> {
    return structuredClone(this.records.get(ownerId) ?? { access: null, ledger: null, etag: null });
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
}

export function productionRepository(): Repository {
  const endpoint = process.env.COSMOS_ENDPOINT;
  const database = process.env.DATABASE_NAME;
  const container = process.env.CONTAINER_NAME;
  if (!endpoint || !database || !container || new URL(endpoint).protocol !== 'https:') throw new Error('Missing database configuration');
  const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential(),
    connectionPolicy: { enableEndpointDiscovery: false } });
  return new CosmosRepository(client.database(database).container(container));
}
