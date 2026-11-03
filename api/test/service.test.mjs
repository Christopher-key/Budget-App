import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../dist/api/src/repository.js';
import { BudgetService } from '../dist/api/src/service.js';
import { fixture, pin, encrypted, errorIs, unlockInput, now, config } from './helpers.mjs';

async function save(f) {
  const envelope = await f.service.budget(f.identity, f.grant.unlockToken);
  const payload = encrypted('Synthetic payroll 2345.67 Home 765.43');
  await f.service.save(f.identity, f.grant.unlockToken, { ...envelope, payload });
  return { ...envelope, payload };
}

test('third consecutive wrong passcode erases ciphertext, login verifier, wrapped key and all sessions atomically', async () => {
  const f = await fixture(); await save(f);
  const second = await f.auth.login(f.credentials);
  const secondIdentity = await f.auth.authenticate(new Headers({ Authorization: 'Bearer ' + second.token }));
  const otherInstance = new BudgetService(f.repository, () => now, config.pepper);
  await assert.rejects(f.service.unlock(f.identity, unlockInput()), errorIs(401, 'INCORRECT_PASSCODE'));
  await assert.rejects(otherInstance.unlock(secondIdentity, unlockInput()), errorIs(401, 'INCORRECT_PASSCODE'));
  await assert.rejects(f.service.unlock(f.identity, unlockInput()), errorIs(410, 'ACCOUNT_ERASED'));
  const erased = await f.repository.read(f.identity.ownerId);
  assert.equal(erased.ledger, null);
  assert.deepEqual(Object.keys(erased.access).sort(), ['epoch', 'id', 'ownerId', 'revision', 'state', 'version']);
  assert.equal(erased.access.state, 'erased');
  for (const token of [f.session.token, second.token]) await assert.rejects(f.auth.authenticate(new Headers({ Authorization: 'Bearer ' + token })), errorIs(401, 'AUTH_REQUIRED'));
  await assert.rejects(f.auth.login(f.credentials), errorIs(401, 'INVALID_LOGIN'));
});

test('correct passcode resets failures; duplicate failed requests never count twice', async () => {
  const f = await fixture(), first = unlockInput();
  await assert.rejects(f.service.unlock(f.identity, first), errorIs(401, 'INCORRECT_PASSCODE'));
  await assert.rejects(f.service.unlock(f.identity, { ...first, attemptId: first.attemptId.toUpperCase() }), errorIs(401, 'INCORRECT_PASSCODE'));
  assert.equal((await f.repository.read(f.identity.ownerId)).access.failures, 1);
  await assert.rejects(f.service.unlock(f.identity, { ...first, pin }), errorIs(400, 'INVALID_DATA'));
  await f.service.unlock(f.identity, unlockInput(pin));
  assert.equal((await f.repository.read(f.identity.ownerId)).access.failures, 0);
  await assert.rejects(f.service.unlock(f.identity, first), errorIs(401, 'INCORRECT_PASSCODE'));
  assert.equal((await f.repository.read(f.identity.ownerId)).access.failures, 0);
});

test('server stores and returns only ciphertext and rejects plaintext financial payloads', async () => {
  const f = await fixture(); const input = await save(f);
  const snapshot = await f.repository.read(f.identity.ownerId);
  assert.deepEqual(snapshot.ledger.payload, input.payload);
  assert.ok(!JSON.stringify(snapshot).includes('2345.67'));
  assert.ok(!('ledger' in snapshot.ledger));
  for (const payload of [{ payroll: '1234.56' }, { ...input.payload, extra: 'financial field' }, { ...input.payload, iv: 'short' }, { ...input.payload, data: 'A'.repeat(1500004) }]) {
    await assert.rejects(f.service.save(f.identity, f.grant.unlockToken, { epoch: f.grant.epoch, revision: 1, payload }), errorIs(400, 'INVALID_DATA'));
  }
});

test('unlock grants are tied to authenticated device sessions and account boundaries', async () => {
  const f = await fixture();
  const second = await f.auth.login(f.credentials);
  const otherIdentity = await f.auth.authenticate(new Headers({ Authorization: 'Bearer ' + second.token }));
  await assert.rejects(f.service.budget(otherIdentity, f.grant.unlockToken), errorIs(423, 'LOCKED'));
  const otherGrant = await f.service.unlock(otherIdentity, unlockInput(pin));
  assert.ok((await f.service.budget(otherIdentity, otherGrant.unlockToken)).payload);
  const unrelated = await fixture(f.repository, { username: 'another-account' });
  await assert.rejects(unrelated.service.budget(unrelated.identity, f.grant.unlockToken), errorIs(423, 'LOCKED'));
});

test('logout invalidates an already-verified session in subsequent service and CAS retries', async () => {
  const f = await fixture(); await f.auth.logout(f.identity);
  await assert.rejects(f.service.budget(f.identity, f.grant.unlockToken), errorIs(401, 'AUTH_REQUIRED'));
  await assert.rejects(f.service.unlock(f.identity, unlockInput(pin)), errorIs(401, 'AUTH_REQUIRED'));
});

test('revisions reject a stale device save while status reports newer changes', async () => {
  const f = await fixture(), stale = await f.service.budget(f.identity, f.grant.unlockToken);
  await save(f);
  await assert.rejects(f.service.save(f.identity, f.grant.unlockToken, stale), errorIs(409, 'REVISION_CONFLICT'));
  assert.equal((await f.service.status(f.identity)).revision, 1);
});

test('expired, revoked and stale grants cannot read or save', async () => {
  const f = await fixture(), original = await f.service.budget(f.identity, f.grant.unlockToken);
  f.setTime(now + 600000);
  await assert.rejects(f.service.budget(f.identity, f.grant.unlockToken), errorIs(423, 'LOCKED'));
  await assert.rejects(f.service.save(f.identity, f.grant.unlockToken, original), errorIs(423, 'LOCKED'));
  const grant = await f.service.unlock(f.identity, unlockInput(pin));
  await f.service.lock(f.identity, grant.unlockToken);
  await assert.rejects(f.service.budget(f.identity, grant.unlockToken), errorIs(423, 'LOCKED'));
});

test('changing a passcode requires fresh verification and revokes all old grants', async () => {
  const f = await fixture(); await save(f);
  f.setTime(now + 60001);
  await assert.rejects(f.service.changePin(f.identity, f.grant.unlockToken, { newPin: '1024' }), errorIs(423, 'LOCKED'));
  const fresh = await f.service.unlock(f.identity, unlockInput(pin));
  const changed = await f.service.changePin(f.identity, fresh.unlockToken, { newPin: '1024' });
  await assert.rejects(f.service.budget(f.identity, fresh.unlockToken), errorIs(423, 'LOCKED'));
  assert.equal((await f.service.budget(f.identity, changed.unlockToken)).revision, 1);
  await assert.rejects(f.service.unlock(f.identity, unlockInput(pin)), errorIs(401, 'INCORRECT_PASSCODE'));
  await f.service.unlock(f.identity, unlockInput('1024'));
});

test('manual erase requires authenticated unlock and stale sessions cannot resurrect a recreated account', async () => {
  const f = await fixture(), old = await f.service.budget(f.identity, f.grant.unlockToken);
  await assert.rejects(f.service.erase(f.identity, undefined, old.epoch), errorIs(423, 'LOCKED'));
  const erased = await f.service.erase(f.identity, f.grant.unlockToken, old.epoch);
  const recreated = await f.auth.register(f.credentials, 'new-device');
  const newIdentity = await f.auth.authenticate(new Headers({ Authorization: 'Bearer ' + recreated.token }));
  await assert.rejects(f.service.setup(f.identity, { pin, expectedEpoch: erased.epoch, startEmpty: true, payload: encrypted() }), errorIs(401, 'AUTH_REQUIRED'));
  await assert.rejects(f.service.save(f.identity, f.grant.unlockToken, old), errorIs(401, 'AUTH_REQUIRED'));
  assert.equal((await f.service.status(newIdentity)).state, 'new');
});

test('in-flight save cannot recreate ciphertext after atomic erasure wins its CAS', async () => {
  const inner = new MemoryRepository(); let enabled = false, release, reached;
  const pending = new Promise(resolve => { reached = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const repository = {
    read: (...args) => inner.read(...args), consumeRate: (...args) => inner.consumeRate(...args),
    async commit(ownerId, etag, access, ledger) {
      if (enabled && ledger?.revision === 1) { enabled = false; reached(); await resume; }
      return inner.commit(ownerId, etag, access, ledger);
    },
  };
  const f = await fixture(repository), old = await f.service.budget(f.identity, f.grant.unlockToken);
  enabled = true;
  const saving = f.service.save(f.identity, f.grant.unlockToken, old);
  await pending;
  await f.service.erase(f.identity, f.grant.unlockToken, old.epoch); release();
  await assert.rejects(saving, errorIs(401, 'AUTH_REQUIRED'));
  assert.equal((await inner.read(f.identity.ownerId)).ledger, null);
});

test('expensive authenticated PIN routes share persistent account limits', async () => {
  const f = await fixture();
  const secondService = new BudgetService(f.repository, () => now, config.pepper);
  for (let i = 0; i < 19; i++) await f.repository.consumeRate((await import('../dist/api/src/security.js')).digest('pin-work:' + f.identity.ownerId), 20, 60000, now);
  await assert.rejects(secondService.unlock(f.identity, unlockInput(pin)), errorIs(429, 'RATE_LIMITED'));
  assert.equal((await f.repository.read(f.identity.ownerId)).access.failures, 0);
});


test('an in-flight read rechecks account deletion before returning encrypted records', async () => {
  const inner = new MemoryRepository(); let enabled = false, release, reached;
  const pending = new Promise(resolve => { reached = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const repository = {
    consumeRate: (...args) => inner.consumeRate(...args), commit: (...args) => inner.commit(...args),
    async read(ownerId, includeLedger = true) {
      const snapshot = await inner.read(ownerId, includeLedger);
      if (enabled && includeLedger && snapshot.ledger) { enabled = false; reached(); await resume; }
      return snapshot;
    },
  };
  const f = await fixture(repository);
  enabled = true;
  const reading = f.service.budget(f.identity, f.grant.unlockToken);
  await pending;
  await f.service.erase(f.identity, f.grant.unlockToken, f.grant.epoch);
  release();
  await assert.rejects(reading, errorIs(401, 'AUTH_REQUIRED'));
});

test('a login racing erasure cannot recreate credentials or issue a usable old session', async () => {
  const inner = new MemoryRepository(); let enabled = false, release, reached;
  const pending = new Promise(resolve => { reached = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const repository = {
    read: (...args) => inner.read(...args), consumeRate: (...args) => inner.consumeRate(...args),
    async commit(ownerId, etag, access, ledger) {
      if (enabled && access.sessions?.length === 2) { enabled = false; reached(); await resume; }
      return inner.commit(ownerId, etag, access, ledger);
    },
  };
  const f = await fixture(repository);
  enabled = true;
  const login = f.auth.login(f.credentials);
  await pending;
  await f.service.erase(f.identity, f.grant.unlockToken, f.grant.epoch);
  release();
  await assert.rejects(login, errorIs(401, 'INVALID_LOGIN'));
  const snapshot = await inner.read(f.identity.ownerId);
  assert.equal(snapshot.access.credentials, undefined);
  assert.equal(snapshot.access.sessions, undefined);
  assert.equal(snapshot.ledger, null);
});
