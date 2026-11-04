import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthenticationService, authenticationConfig } from '../dist/api/src/auth.js';
import { MemoryRepository } from '../dist/api/src/repository.js';
import { config, fixture, proof, wrapped, errorIs, now } from './helpers.mjs';

const headers = token => new Headers({ Authorization: 'Bearer ' + token });

test('app-owned registration stores only pseudonymous lookup, salted verifier and token hash', async () => {
  const { repository, identity, session, credentials } = await fixture(undefined, { setup: false });
  const stored = await repository.read(identity.ownerId), serialized = JSON.stringify(stored);
  assert.match(session.token, /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
  for (const privateValue of [credentials.username, credentials.proof, session.token]) assert.ok(!serialized.includes(privateValue));
  assert.match(stored.access.credentials.verifier.salt, /^[A-Za-z0-9_-]{43}$/);
  assert.match(stored.access.credentials.verifier.hash, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(stored.access.credentials.verifier.hash, credentials.proof);
  assert.equal(stored.access.sessions.length, 1);
  assert.equal(stored.access.credentials.wrappedKey.data.length, 64);
  assert.equal(stored.ledger, null);
});

test('normalised app username signs into the same account from a second device', async () => {
  const { auth, identity, credentials } = await fixture(undefined, { setup: false });
  const params = await auth.parameters({ username: '  SYNTHETIC-OWNER ' });
  assert.deepEqual(params, { accountId: identity.ownerId, salt: credentials.salt, iterations: 600000 });
  const second = await auth.login({ username: 'SYNTHETIC-OWNER', proof: credentials.proof });
  assert.equal(second.accountId, identity.ownerId);
  assert.deepEqual(second.wrappedKey, credentials.wrappedKey);
  assert.notEqual(second.token, credentials.proof);
  assert.equal((await auth.authenticate(headers(second.token))).ownerId, identity.ownerId);
});

test('three public account-password failures never erase budget, keys or app-passcode count', async () => {
  const { repository, auth, identity } = await fixture();
  const before = await repository.read(identity.ownerId);
  for (let i = 0; i < 3; i++) await assert.rejects(auth.login({ username: 'synthetic-owner', proof: proof() }), errorIs(401, 'INVALID_LOGIN'));
  const after = await repository.read(identity.ownerId);
  assert.deepEqual(after, before);
  assert.equal(after.access.failures, 0);
});

test('unknown usernames have plausible deterministic parameters and cannot authenticate', async () => {
  const auth = new AuthenticationService(new MemoryRepository(), config, () => now);
  const a = await auth.parameters({ username: 'unknown-account' });
  assert.deepEqual(await auth.parameters({ username: 'UNKNOWN-ACCOUNT' }), a);
  assert.match(a.salt, /^[A-Za-z0-9_-]{43}$/);
  assert.match(a.accountId, /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(auth.login({ username: 'unknown-account', proof: proof() }), errorIs(401, 'INVALID_LOGIN'));
});

test('opaque session tokens expire, reject tampering and revoke independently', async () => {
  const { auth, credentials, identity, session, setTime } = await fixture(undefined, { setup: false });
  const second = await auth.login(credentials);
  await assert.rejects(auth.authenticate(headers(session.token.slice(0, -1) + 'X')), errorIs(401, 'AUTH_REQUIRED'));
  await assert.rejects(auth.authenticate(new Headers({ 'x-ms-client-principal-id': identity.ownerId })), errorIs(401, 'AUTH_REQUIRED'));
  await auth.logout(identity);
  await assert.rejects(auth.authenticate(headers(session.token)), errorIs(401, 'AUTH_REQUIRED'));
  assert.equal((await auth.authenticate(headers(second.token))).ownerId, identity.ownerId);
  setTime(now + 30 * 60000);
  await assert.rejects(auth.authenticate(headers(second.token)), errorIs(401, 'AUTH_REQUIRED'));
});

test('same client proof receives independent random slow-hash salt for each account', async () => {
  const first = await fixture(undefined, { setup: false });
  const second = await first.auth.register({ ...first.credentials, username: 'another-account' }, 'second-source');
  const a = (await first.repository.read(first.identity.ownerId)).access.credentials.verifier;
  const b = (await first.repository.read(second.accountId)).access.credentials.verifier;
  assert.notEqual(a.salt, b.salt); assert.notEqual(a.hash, b.hash);
});

test('persistent parameter limits are shared by separate auth service instances and expire', async () => {
  const repository = new MemoryRepository(); let time = now;
  const a = new AuthenticationService(repository, config, () => time), b = new AuthenticationService(repository, config, () => time);
  for (let i = 0; i < 60; i++) await (i % 2 ? a : b).parameters({ username: 'unknown-account' });
  await assert.rejects(b.parameters({ username: 'unknown-account' }), errorIs(429, 'RATE_LIMITED'));
  time += 60000;
  assert.ok((await a.parameters({ username: 'unknown-account' })).salt);
});

test('missing secrets and malformed public credentials fail closed', async () => {
  assert.throws(() => authenticationConfig({}), /configuration/);
  assert.throws(() => authenticationConfig({ AUTH_LOOKUP_KEY: 'weak', AUTH_PEPPER: config.pepper }), /configuration/);
  const auth = new AuthenticationService(new MemoryRepository(), config, () => now);
  for (const username of ['a', 'two words', 'üsername', '../user']) await assert.rejects(auth.parameters({ username }), errorIs(400, 'INVALID_DATA'));
  await assert.rejects(auth.register({ username: 'valid-user', proof: 'plaintext-password', salt: proof(), wrappedKey: wrapped() }), errorIs(400, 'INVALID_DATA'));
  await assert.rejects(auth.register({ username: 'valid-user', proof: proof(), salt: proof(), wrappedKey: { ...wrapped(), data: 'plaintext-key' } }), errorIs(400, 'INVALID_DATA'));
});

test('distributed parameter requests have a shared allocation bound before creating distinct source/name records', async () => {
  const inner = new MemoryRepository(), buckets = new Set(); let reads = 0, time = now;
  const repository = {
    async read(...args) { reads++; return inner.read(...args); },
    commit: (...args) => inner.commit(...args),
    async consumeRate(bucket, ...args) { buckets.add(bucket); return inner.consumeRate(bucket, ...args); },
  };
  const a = new AuthenticationService(repository, config, () => time), b = new AuthenticationService(repository, config, () => time);
  for (let index = 0; index < 600; index++) {
    await (index % 2 ? a : b).parameters({ username: 'synthetic-name-' + index }, 'synthetic-source-' + index);
  }
  assert.equal(reads, 600);
  const allocated = buckets.size;
  assert.equal(allocated, 1201, 'one shared admission bucket and two buckets per admitted request');
  for (let index = 600; index < 620; index++) {
    await assert.rejects((index % 2 ? a : b).parameters({ username: 'synthetic-name-' + index }, 'synthetic-source-' + index), errorIs(429, 'RATE_LIMITED'));
  }
  assert.equal(buckets.size, allocated, 'denied rotating sources cannot allocate more dynamic buckets');
  assert.equal(reads, 600, 'denied requests cannot query account records');
  time += 60_000;
  assert.ok((await b.parameters({ username: 'synthetic-after-window' }, 'new-synthetic-source')).salt);
  assert.equal(reads, 601);
});

test('login and registration share admission before dynamic allocation and do not erase account data when exhausted', async () => {
  const f = await fixture(), before = await f.repository.read(f.identity.ownerId);
  // Registration used one of the existing 120 expensive-work admissions.
  for (let index = 0; index < 119; index++) {
    assert.equal(await f.repository.consumeRate('global-auth-work', 120, 60_000, now), true);
  }
  const buckets = new Set(); let reads = 0;
  const repository = {
    async read(...args) { reads++; return f.repository.read(...args); },
    commit: (...args) => f.repository.commit(...args),
    async consumeRate(bucket, ...args) { buckets.add(bucket); return f.repository.consumeRate(bucket, ...args); },
  };
  const a = new AuthenticationService(repository, config, () => now), b = new AuthenticationService(repository, config, () => now);
  for (let index = 0; index < 20; index++) {
    const input = { ...f.credentials, username: 'synthetic-overflow-' + index };
    await assert.rejects((index % 2 ? a : b).login(input, 'overflow-login-' + index), errorIs(429, 'RATE_LIMITED'));
    await assert.rejects((index % 2 ? b : a).register(input, 'overflow-register-' + index), errorIs(429, 'RATE_LIMITED'));
  }
  assert.deepEqual([...buckets], ['global-auth-work']);
  assert.equal(reads, 0);
  assert.deepEqual(await f.repository.read(f.identity.ownerId), before);
  // Parameter discovery has a separate allowance and consumes no KDF capacity.
  assert.equal((await a.parameters({ username: f.credentials.username }, 'separate-parameters')).accountId, f.identity.ownerId);
});
