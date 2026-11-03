import test from 'node:test';
import assert from 'node:assert/strict';
import { CosmosRepository } from '../dist/api/src/repository.js';

const owner = 'synthetic-owner';
const access = { id: 'access', ownerId: owner, state: 'locked', epoch: 1, version: 1, revision: 0 };
const payload = { v: 1, iv: Buffer.alloc(12, 1).toString('base64url'), data: Buffer.alloc(48, 2).toString('base64url') };
const ledger = { id: 'ledger', ownerId: owner, epoch: 1, revision: 0, payload };

function mockContainer(batch = async operations => ({ code: 200, result: operations.map(() => ({ statusCode: 200 })) })) {
  const calls = [];
  return {
    calls,
    container: { items: { async batch(operations, partition) { calls.push({ operations, partition }); return batch(operations, partition); } } },
  };
}

test('Cosmos setup creates access and ledger together in exactly one owner partition batch', async () => {
  const { container, calls } = mockContainer();
  assert.equal(await new CosmosRepository(container).commit(owner, null, access, ledger), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].partition, owner);
  assert.deepEqual(calls[0].operations, [
    { operationType: 'Create', resourceBody: access },
    { operationType: 'Create', resourceBody: ledger },
  ]);
});

test('Cosmos financial save and erasure both compare-and-swap the access document in the same atomic batch', async () => {
  const { container, calls } = mockContainer();
  const repository = new CosmosRepository(container);
  const updated = { ...access, revision: 1, version: 2 };
  const newLedger = { ...ledger, revision: 1 };
  await repository.commit(owner, 'expected-version', updated, newLedger);
  assert.deepEqual(calls[0].operations, [
    { operationType: 'Replace', id: 'access', ifMatch: 'expected-version', resourceBody: updated },
    { operationType: 'Replace', id: 'ledger', resourceBody: newLedger },
  ]);
  const tombstone = { id: 'access', ownerId: owner, state: 'erased', epoch: 2, version: 3, revision: 0 };
  await repository.commit(owner, 'next-version', tombstone, null);
  assert.deepEqual(calls[1].operations, [
    { operationType: 'Replace', id: 'access', ifMatch: 'next-version', resourceBody: tombstone },
    { operationType: 'Delete', id: 'ledger' },
  ]);
});

test('Cosmos rejects cross-partition payloads before attempting any write', async () => {
  const { container, calls } = mockContainer();
  const repository = new CosmosRepository(container);
  await assert.rejects(repository.commit(owner, null, { ...access, ownerId: 'another-owner' }, ledger), /Partition mismatch/);
  await assert.rejects(repository.commit(owner, null, access, { ...ledger, ownerId: 'another-owner' }), /Partition mismatch/);
  assert.equal(calls.length, 0);
});

test('Cosmos batch conflicts are retriable, while non-conflict failures remain errors', async () => {
  for (const code of [409, 412, 424]) {
    const { container } = mockContainer(async () => ({ code: 207, result: [{ statusCode: code }, { statusCode: 424 }] }));
    assert.equal(await new CosmosRepository(container).commit(owner, 'version', access, ledger), false);
    const thrown = mockContainer(async () => { throw { code }; });
    assert.equal(await new CosmosRepository(thrown.container).commit(owner, 'version', access, ledger), false);
  }
  const { container } = mockContainer(async () => ({ code: 500, result: [{ statusCode: 500 }] }));
  await assert.rejects(new CosmosRepository(container).commit(owner, 'version', access, ledger), /Atomic commit failed/);
});

test('Cosmos reads an erased account without loading financial records', async () => {
  const reads = [];
  const tombstone = { id: 'access', ownerId: owner, state: 'erased', epoch: 2, version: 3, revision: 0, _etag: 'version' };
  const repository = new CosmosRepository({ item(id, partition) {
    reads.push({ id, partition });
    assert.equal(id, 'access');
    return { async read() { return { resource: tombstone }; } };
  } });
  const result = await repository.read(owner);
  assert.equal(result.ledger, null);
  assert.equal(result.etag, 'version');
  assert.equal(result.access.state, 'erased');
  assert.deepEqual(reads, [{ id: 'access', partition: owner }]);
});


test('account-only checks never load encrypted financial payloads, and full reads preserve ciphertext exactly', async () => {
  const reads = [];
  const repository = new CosmosRepository({ item(id, partition) {
    reads.push({ id, partition });
    return { async read() { return { resource: id === 'access' ? { ...access, _etag: 'current' } : ledger }; } };
  } });
  const statusOnly = await repository.read(owner, false);
  assert.equal(statusOnly.ledger, null);
  assert.deepEqual(reads, [{ id: 'access', partition: owner }]);
  reads.length = 0;
  const full = await repository.read(owner);
  assert.deepEqual(full.ledger, ledger);
  assert.deepEqual(reads, [{ id: 'access', partition: owner }, { id: 'ledger', partition: owner }]);
});

test('Cosmos rate counters share atomic persistent buckets and expire without storing usernames or IP addresses', async () => {
  const documents = new Map(); let serial = 0;
  const calls = [];
  const container = {
    item(id, partition) { return { async read() {
      const resource = documents.get(partition);
      if (!resource) throw { code: 404 };
      return { resource: structuredClone(resource) };
    } }; },
    items: { async batch(operations, partition) {
      const [operation] = operations;
      const existing = documents.get(partition);
      if ((operation.operationType === 'Create' && existing) || (operation.operationType === 'Replace' && existing?._etag !== operation.ifMatch)) {
        return { code: 412, result: [{ statusCode: 412 }] };
      }
      calls.push({ operations, partition });
      documents.set(partition, { ...structuredClone(operation.resourceBody), _etag: String(++serial) });
      return { code: 200, result: [{ statusCode: 200 }] };
    } },
  };
  const a = new CosmosRepository(container), b = new CosmosRepository(container);
  const outcomes = await Promise.all([a.consumeRate('opaque-source', 2, 60000, 100000), b.consumeRate('opaque-source', 2, 60000, 100000), a.consumeRate('opaque-source', 2, 60000, 100000)]);
  assert.equal(outcomes.filter(Boolean).length, 2);
  assert.equal(await b.consumeRate('opaque-source', 2, 60000, 159999), false);
  assert.equal(await a.consumeRate('opaque-source', 2, 60000, 160000), true);
  const counter = documents.get('rate:opaque-source');
  assert.equal(counter.count, 1);
  assert.equal(counter.ttl, 120);
  assert.equal(counter.start, 160000);
  assert.ok(calls.every(call => call.partition === 'rate:opaque-source'));
  assert.ok(calls.slice(1).every(call => call.operations[0].ifMatch));
  assert.deepEqual(Object.keys(counter).sort(), ['_etag', 'count', 'id', 'ownerId', 'start', 'ttl']);
});
