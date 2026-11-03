import test from 'node:test';
import assert from 'node:assert/strict';
import { CosmosRepository } from '../dist/api/src/repository.js';

const owner = 'synthetic-owner';
const access = { id: 'access', ownerId: owner, state: 'locked', epoch: 1, version: 1, revision: 0 };
const ledger = { id: 'ledger', ownerId: owner, epoch: 1, revision: 0, ledger: { schemaVersion: 1 } };

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
