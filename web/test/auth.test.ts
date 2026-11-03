import assert from 'node:assert/strict';
import test from 'node:test';
import { authenticate, AuthError, validatePublicConfig, type PublicConfig } from '../src/auth.js';
import { createDataKey, encode, passwordKeys, randomSalt } from '../src/crypto.js';

const config: PublicConfig = { configured: true, apiBaseUrl: 'https://budget-api.example.test' };
const accountId = encode(new Uint8Array(32).fill(1));
const secret = encode(new Uint8Array(32).fill(2));
const password = 'a long synthetic password';
const token = accountId + '.' + secret;
const expiresAt = () => new Date(Date.now() + 1_800_000).toISOString();

function server() {
  const calls: { path: string; body: any; init?: RequestInit }[] = [];
  let salt = randomSalt(), wrappedKey: unknown, proof = '';
  const fetcher = (async (url, init) => {
    const path = new URL(String(url)).pathname.split('/').pop()!, body = JSON.parse(String(init?.body)); calls.push({ path, body, init });
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.cache, 'no-store'); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), null);
    if (path === 'parameters') return Response.json({ accountId, salt, iterations: 600_000 });
    if (path === 'register') { salt = body.salt; wrappedKey = body.wrappedKey; proof = body.proof; }
    if (path === 'login' && body.proof !== proof) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 });
    return Response.json({ accountId, salt, wrappedKey, token, expiresAt: expiresAt() });
  }) as typeof fetch;
  return { calls, fetcher };
}

test('public configuration only needs an HTTPS API origin, never Microsoft identity or client secrets', () => {
  assert.deepEqual(validatePublicConfig(config), config);
  assert.deepEqual(validatePublicConfig({ ...config, apiBaseUrl: 'http://localhost:7071' }), { configured: true, apiBaseUrl: 'http://localhost:7071' });
  for (const value of [null, {}, { ...config, configured: false }, { ...config, apiBaseUrl: 'http://api.example.test' }, { ...config, apiBaseUrl: 'https://user:password@api.example.test/' }, { ...config, apiBaseUrl: 'https://api.example.test/api' }, { ...config, apiBaseUrl: 'https://api.example.test/?secret=x' }, { ...config, apiBaseUrl: 'https://api.example.test/#secret' }]) assert.equal(validatePublicConfig(value), null);
});

test('account creation and another-device login unlock the same data key without transmitting a password or persisting credentials', async () => {
  const remote = server();
  const created = await authenticate(config, ' Test.User ', password, true, remote.fetcher);
  const loggedIn = await authenticate(config, 'test.user', password, false, remote.fetcher);
  assert.equal(created.accountId, accountId); assert.equal(loggedIn.accountId, accountId);
  assert.equal(created.dataKey.extractable, false); assert.equal(loggedIn.dataKey.extractable, false);
  assert.equal(created.accessToken, token);
  assert.deepEqual(remote.calls.map(c => c.path), ['parameters', 'register', 'parameters', 'login']);
  for (const { body } of remote.calls) { assert.equal(body.username, 'test.user'); assert.ok(!JSON.stringify(body).includes(password)); assert.ok(!('password' in body)); }
  assert.match(remote.calls[1].body.proof, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(created).sort(), ['accessToken', 'accountId', 'dataKey', 'expiresAt']);
  await assert.rejects(authenticate(config, 'test.user', password + 'wrong', false, remote.fetcher), (error: AuthError) => error.code === 'AUTH_REQUIRED');
});

test('invalid usernames and short passwords are rejected before sending any request', async () => {
  let calls = 0; const fetcher = (async () => { calls++; throw new Error('unexpected'); }) as typeof fetch;
  for (const [username, pw] of [['ab', password], ['bad name', password], ['test-user', '1234'], ['test-user', 'x'.repeat(129)]]) await assert.rejects(authenticate(config, username, pw, false, fetcher));
  assert.equal(calls, 0);
});

test('KDF downgrade, untrusted account metadata, and rate limits cannot create an authenticated session', async () => {
  for (const parameters of [{ accountId, salt: randomSalt(), iterations: 1 }, { accountId: 'wrong', salt: randomSalt(), iterations: 600_000 }, { accountId, salt: 'short', iterations: 600_000 }]) {
    let calls = 0;
    await assert.rejects(authenticate(config, 'test-user', password, false, (async () => { calls++; return Response.json(parameters); }) as typeof fetch));
    assert.equal(calls, 1);
  }
  await assert.rejects(authenticate(config, 'test-user', password, false, (async () => Response.json({ code: 'RATE_LIMITED', debug: 'sensitive error' }, { status: 429 })) as typeof fetch), (error: AuthError) => error.code === 'RATE_LIMITED' && !error.message.includes('sensitive'));
});

test('token replies must match the requested account, salt, expiry, and encrypted key schema', async () => {
  const salt = randomSalt(), keys = await passwordKeys(password, salt), { wrappedKey } = await createDataKey(keys.wrappingKey, accountId);
  const base = { accountId, salt, token, expiresAt: expiresAt(), wrappedKey };
  for (const response of [{ ...base, salt: randomSalt() }, { ...base, accountId: encode(new Uint8Array(32).fill(8)) }, { ...base, token: 'unbound-token' }, { ...base, expiresAt: new Date(Date.now() - 1).toISOString() }, { ...base, expiresAt: new Date(Date.now() + 7_200_000).toISOString() }, { ...base, wrappedKey: { ...wrappedKey, data: encode(new Uint8Array(16)) } }]) {
    await assert.rejects(authenticate(config, 'test-user', password, false, (async (url) => Response.json(String(url).endsWith('parameters') ? { accountId, salt, iterations: 600_000 } : response)) as typeof fetch));
  }
});
