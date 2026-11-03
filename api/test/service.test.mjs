import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BudgetService } from '../dist/api/src/service.js';
import { MemoryRepository } from '../dist/api/src/repository.js';
import { ApiError } from '../dist/api/src/types.js';

const owner = 'synthetic-owner-a';
const otherOwner = 'synthetic-owner-b';
const setupPin = '2048';
const incorrectPin = '4096';
const now = Date.UTC(2026, 0, 15, 12);
const errorIs = (status, code) => error => error instanceof ApiError && error.status === status && error.code === code;
const unlockInput = (pin = incorrectPin, attemptId = randomUUID()) => ({ pin, attemptId });
async function fixture(repository = new MemoryRepository()) {
  let time = now;
  const service = new BudgetService(repository, () => time);
  const grant = await service.setup(owner, { pin: setupPin, expectedEpoch: 0, startEmpty: true });
  return { repository, service, grant, setTime(value) { time = value; } };
}
async function saveSyntheticData(service, grant) {
  const budget = await service.budget(owner, grant.unlockToken);
  budget.ledger.months[0].periods[0].realistic.payroll = '1234.56';
  budget.ledger.months[0].transactions.push({ id: randomUUID(), date: '2026-01-15T12:00:00.000Z',
    dayOfMonth: 15, category: 'Grocery', amount: '12.34', note: 'Synthetic test entry' });
  await service.save(owner, grant.unlockToken, budget);
  return budget;
}

test('three wrong PINs across devices atomically erase every financial field and invalidate every grant', async () => {
  const { repository, service, grant } = await fixture();
  const secondDevice = await service.unlock(owner, unlockInput(setupPin));
  const saved = await saveSyntheticData(service, grant);
  await assert.rejects(service.unlock(owner, unlockInput()), errorIs(401, 'INCORRECT_PASSCODE'));
  assert.equal((await repository.read(owner)).access.failures, 1);
  await assert.rejects(service.unlock(owner, unlockInput()), errorIs(401, 'INCORRECT_PASSCODE'));
  assert.equal((await service.budget(owner, secondDevice.unlockToken)).revision, 1);
  await assert.rejects(service.unlock(owner, unlockInput()), errorIs(410, 'ACCOUNT_ERASED'));
  const erased = await repository.read(owner);
  assert.equal(erased.ledger, null);
  assert.deepEqual(Object.keys(erased.access).sort(), ['epoch', 'id', 'ownerId', 'revision', 'state', 'version']);
  assert.equal(erased.access.state, 'erased');
  assert.equal(erased.access.epoch, grant.epoch + 1);
  for (const token of [grant.unlockToken, secondDevice.unlockToken]) {
    await assert.rejects(service.budget(owner, token), errorIs(410, 'ACCOUNT_ERASED'));
    await assert.rejects(service.save(owner, token, saved), errorIs(410, 'ACCOUNT_ERASED'));
  }
  await assert.rejects(service.unlock(owner, unlockInput(setupPin)), errorIs(410, 'ACCOUNT_ERASED'));
  assert.deepEqual(await service.status(owner), { state: 'erased', epoch: 2, accountId: owner });
});

test('a correct PIN resets consecutive failures account-wide; retried failures never count twice', async () => {
  const { repository, service } = await fixture();
  const first = unlockInput();
  await assert.rejects(service.unlock(owner, first), errorIs(401, 'INCORRECT_PASSCODE'));
  await assert.rejects(service.unlock(owner, { ...first, attemptId: first.attemptId.toUpperCase() }), errorIs(401, 'INCORRECT_PASSCODE'));
  assert.equal((await repository.read(owner)).access.failures, 1);
  await assert.rejects(service.unlock(owner, { ...first, pin: setupPin }), errorIs(400, 'INVALID_DATA'));
  await assert.rejects(service.unlock(owner, unlockInput()), errorIs(401, 'INCORRECT_PASSCODE'));
  const correct = await service.unlock(owner, unlockInput(setupPin));
  assert.equal((await repository.read(owner)).access.failures, 0);
  await assert.rejects(service.unlock(owner, first), errorIs(401, 'INCORRECT_PASSCODE'));
  assert.equal((await repository.read(owner)).access.failures, 0);
  await assert.rejects(service.unlock(owner, unlockInput()), errorIs(401, 'INCORRECT_PASSCODE'));
  assert.equal((await repository.read(owner)).access.failures, 1);
  assert.equal((await service.budget(owner, correct.unlockToken)).epoch, 1);
});

test('concurrent duplicate retries count once, while three independent concurrent attempts erase', async () => {
  const { repository, service } = await fixture();
  const duplicate = unlockInput();
  const retried = await Promise.allSettled(Array.from({ length: 5 }, () => service.unlock(owner, duplicate)));
  assert.ok(retried.every(result => result.status === 'rejected' && errorIs(401, 'INCORRECT_PASSCODE')(result.reason)));
  assert.equal((await repository.read(owner)).access.failures, 1);
  await service.unlock(owner, unlockInput(setupPin));
  const independent = await Promise.allSettled(Array.from({ length: 3 }, () => service.unlock(owner, unlockInput())));
  assert.equal(independent.filter(result => result.status === 'rejected' && result.reason.code === 'INCORRECT_PASSCODE').length, 2);
  assert.equal(independent.filter(result => result.status === 'rejected' && result.reason.code === 'ACCOUNT_ERASED').length, 1);
  assert.equal((await repository.read(owner)).ledger, null);
});

test('account grants and failure counters remain isolated', async () => {
  const { repository, service, grant } = await fixture();
  const otherGrant = await service.setup(otherOwner, { pin: setupPin, expectedEpoch: 0, startEmpty: true });
  await assert.rejects(service.budget(otherOwner, grant.unlockToken), errorIs(423, 'LOCKED'));
  await assert.rejects(service.budget(owner, otherGrant.unlockToken), errorIs(423, 'LOCKED'));
  for (let i = 0; i < 3; i++) await assert.rejects(service.unlock(owner, unlockInput()), errorIs(i === 2 ? 410 : 401, i === 2 ? 'ACCOUNT_ERASED' : 'INCORRECT_PASSCODE'));
  assert.equal((await repository.read(otherOwner)).access.failures, 0);
  assert.equal((await service.budget(otherOwner, otherGrant.unlockToken)).epoch, 1);
});

test('expired and revoked grants cannot read, save, or change a PIN', async () => {
  const { service, grant, setTime } = await fixture();
  const budget = await service.budget(owner, grant.unlockToken);
  setTime(now + 600_000);
  await assert.rejects(service.budget(owner, grant.unlockToken), errorIs(423, 'LOCKED'));
  await assert.rejects(service.save(owner, grant.unlockToken, budget), errorIs(423, 'LOCKED'));
  await assert.rejects(service.changePin(owner, grant.unlockToken, { newPin: '1024' }), errorIs(423, 'LOCKED'));
  const fresh = await service.unlock(owner, unlockInput(setupPin));
  await service.lock(owner, fresh.unlockToken);
  await service.lock(owner, fresh.unlockToken);
  await assert.rejects(service.budget(owner, fresh.unlockToken), errorIs(423, 'LOCKED'));
});

test('PIN change requires recent authentication, rotates every grant, and preserves financial data', async () => {
  const { service, grant, setTime } = await fixture();
  await saveSyntheticData(service, grant);
  setTime(now + 60_001);
  await assert.rejects(service.changePin(owner, grant.unlockToken, { newPin: '1024' }), errorIs(423, 'LOCKED'));
  const fresh = await service.unlock(owner, unlockInput(setupPin));
  const changed = await service.changePin(owner, fresh.unlockToken, { newPin: '1024' });
  await assert.rejects(service.budget(owner, grant.unlockToken), errorIs(423, 'LOCKED'));
  await assert.rejects(service.budget(owner, fresh.unlockToken), errorIs(423, 'LOCKED'));
  assert.equal((await service.budget(owner, changed.unlockToken)).ledger.months[0].transactions.length, 1);
  await assert.rejects(service.unlock(owner, unlockInput(setupPin)), errorIs(401, 'INCORRECT_PASSCODE'));
  await service.unlock(owner, unlockInput('1024'));
});

test('erasure remains a tombstone until explicit empty setup; old epochs cannot restore a ledger', async () => {
  const { repository, service, grant } = await fixture();
  const oldBudget = await saveSyntheticData(service, grant);
  const erased = await service.erase(owner, 1);
  assert.equal(erased.epoch, 2);
  await assert.rejects(service.setup(owner, { pin: setupPin, expectedEpoch: 2, startEmpty: false }), errorIs(400, 'INVALID_DATA'));
  await assert.rejects(service.setup(owner, { pin: setupPin, expectedEpoch: 1, startEmpty: true }), errorIs(409, 'STALE_EPOCH'));
  assert.equal((await repository.read(owner)).ledger, null);
  const restarted = await service.setup(owner, { pin: setupPin, expectedEpoch: erased.epoch, startEmpty: true });
  assert.equal(restarted.epoch, 3);
  const empty = await service.budget(owner, restarted.unlockToken);
  assert.equal(empty.ledger.months[0].transactions.length, 0);
  assert.equal(empty.ledger.months[0].periods[0].realistic.payroll, '');
  await assert.rejects(service.save(owner, restarted.unlockToken, oldBudget), errorIs(409, 'STALE_EPOCH'));
  assert.deepEqual(await service.budget(owner, restarted.unlockToken), empty);
});

test('a PUT already in progress when deletion commits cannot resurrect financial data', async () => {
  const inner = new MemoryRepository();
  let releaseSave;
  let sawSave;
  const pendingSave = new Promise(resolve => { sawSave = resolve; });
  const resume = new Promise(resolve => { releaseSave = resolve; });
  let pause = true;
  const repository = {
    read: ownerId => inner.read(ownerId),
    async commit(ownerId, etag, access, ledger) {
      if (pause && ledger?.revision === 1) { pause = false; sawSave(); await resume; }
      return inner.commit(ownerId, etag, access, ledger);
    },
  };
  const { service, grant } = await fixture(repository);
  const input = await service.budget(owner, grant.unlockToken);
  input.ledger.months[0].periods[0].realistic.payroll = '987.65';
  const saving = service.save(owner, grant.unlockToken, input);
  const rejected = assert.rejects(saving, errorIs(410, 'ACCOUNT_ERASED'));
  await pendingSave;
  await service.erase(owner, grant.epoch);
  releaseSave();
  await rejected;
  assert.equal((await inner.read(owner)).ledger, null);
  assert.equal((await inner.read(owner)).access.state, 'erased');
});

test('concurrent same-revision PUTs allow one writer and reject lost updates', async () => {
  const { service, grant } = await fixture();
  const input = await service.budget(owner, grant.unlockToken);
  const other = structuredClone(input);
  input.ledger.months[0].periods[0].realistic.payroll = '1.00';
  other.ledger.months[0].periods[0].realistic.payroll = '2.00';
  const results = await Promise.allSettled([service.save(owner, grant.unlockToken, input), service.save(owner, grant.unlockToken, other)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && errorIs(409, 'REVISION_CONFLICT')(result.reason)).length, 1);
  assert.equal((await service.budget(owner, grant.unlockToken)).revision, 1);
});

test('invalid PINs, attempts, epochs and financial payloads fail without changing records', async () => {
  const { repository, service, grant } = await fixture();
  const before = await repository.read(owner);
  for (const value of ['', '123', '12345', '１２３４', 1234, null]) {
    await assert.rejects(service.unlock(owner, { pin: value, attemptId: randomUUID() }), errorIs(400, 'INVALID_DATA'));
  }
  await assert.rejects(service.unlock(owner, { pin: incorrectPin, attemptId: 'not-an-id' }), errorIs(400, 'INVALID_DATA'));
  const input = await service.budget(owner, grant.unlockToken);
  for (const epoch of [-1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(service.save(owner, grant.unlockToken, { ...input, epoch }), errorIs(400, 'INVALID_DATA'));
  }
  const invalid = [
    { ...input.ledger, ownerId: otherOwner },
    { ...input.ledger, schemaVersion: 2 },
    { ...input.ledger, months: [...input.ledger.months, input.ledger.months[0]] },
  ];
  const negative = structuredClone(input.ledger);
  negative.months[0].periods[0].realistic.payroll = '-10';
  invalid.push(negative);
  for (const ledger of invalid) await assert.rejects(service.save(owner, grant.unlockToken, { ...input, ledger }), errorIs(400, 'INVALID_DATA'));
  assert.deepEqual(await repository.read(owner), before);
});

test('MemoryRepository snapshots are detached, CAS rejects stale versions, and partitions cannot be mixed', async () => {
  const { repository } = await fixture();
  const first = await repository.read(owner);
  const stale = await repository.read(owner);
  first.access.failures = 1;
  assert.equal(await repository.commit(owner, first.etag, first.access, undefined), true);
  assert.equal(await repository.commit(owner, stale.etag, stale.access, null), false);
  stale.ledger.ledger.months.length = 0;
  assert.equal((await repository.read(owner)).ledger.ledger.months.length, 1);
  const current = await repository.read(owner);
  await assert.rejects(repository.commit(owner, current.etag, { ...current.access, ownerId: otherOwner }, undefined), /Partition mismatch/);
});
