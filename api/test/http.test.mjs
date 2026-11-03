import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '@azure/functions';
import { ApiError } from '../dist/api/src/types.js';
import { fixture, pin, encrypted, unlockInput } from './helpers.mjs';

// Capture the deployed route boundaries without starting a host or database.
const handlers = new Map();
const registration = app.http;
app.http = (name, options) => handlers.set(name, options);
let createHandler;
try { ({ createHandler } = await import('../dist/api/src/functions.js')); }
finally { app.http = registration; }
const origin = 'https://budget.example.test';
process.env.APP_ORIGIN = origin;
function request(value = {}, options = {}) {
  return {
    method: options.method ?? 'POST',
    headers: new Headers({ origin, 'content-type': 'application/json', ...options.headers }),
    async text() { return options.text ?? JSON.stringify(value); },
  };
}
const authenticated = (f, value, options = {}) => request(value, {
  ...options, headers: { authorization: 'Bearer ' + f.session.token, ...options.headers },
});

test('all deployed account and financial routes reject missing identity before reading a body or opening database clients', async () => {
  assert.equal(handlers.size, 11);
  const publicNames = ['authParameters', 'authRegister', 'authLogin'];
  for (const [name, { handler }] of handlers) {
    if (publicNames.includes(name)) continue;
    for (const authorization of ['', 'Bearer malformed.token']) {
      let reads = 0;
      const input = request({}, { headers: { authorization, 'x-ms-client-principal-id': 'untrusted-owner' } });
      input.text = async () => { reads++; throw new Error('Must not read this body.'); };
      const response = await handler(input);
      assert.equal(response.status, 401, name);
      assert.deepEqual(response.jsonBody, { code: 'AUTH_REQUIRED' });
      assert.equal(reads, 0);
      assert.equal(response.headers['Cache-Control'], 'no-store, private');
      assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
    }
  }
});

test('cross-origin and missing-origin writes fail before reading credentials or resolving services', async () => {
  let resolves = 0;
  const handle = createHandler(() => { resolves++; throw new Error('Must remain unopened.'); });
  for (const received of ['https://attacker.example.test', 'null', '']) {
    const input = request({}, { headers: { origin: received } });
    input.text = async () => { throw new Error('Must not read this body.'); };
    const response = await handle(input, 'register');
    assert.equal(response.status, 403);
    assert.deepEqual(response.jsonBody, { code: 'ORIGIN_REJECTED' });
  }
  assert.equal(resolves, 0);
});

test('public login accepts only derived proofs and rejects password fields and oversized or malformed bodies', async () => {
  let calls = 0;
  const handle = createHandler(() => ({ authentication: { async login() { calls++; } }, service: {} }));
  for (const [input, status] of [
    [request({ username: 'synthetic', password: 'synthetic-secret' }), 400],
    [request({}, { text: 'null' }), 400],
    [request({}, { text: '[]' }), 400],
    [request({}, { text: '{invalid' }), 400],
    [request({}, { headers: { 'content-type': 'text/plain' } }), 400],
    [request({}, { headers: { 'content-length': '1025' } }), 413],
    [request({}, { text: ' '.repeat(1025) }), 413],
  ]) {
    const response = await handle(input, 'login');
    assert.equal(response.status, status);
    assert.deepEqual(response.jsonBody, { code: 'INVALID_DATA' });
  }
  assert.equal(calls, 0);
});

test('network rate-limit sources ignore caller prefixes and changing source ports', async () => {
  const sources = [];
  const handle = createHandler(() => ({ authentication: {
    async parameters(_input, source) { sources.push(source); return {}; },
  }, service: {} }));
  for (const value of ['untrusted-prefix, 192.0.2.8:10001', 'other-prefix, 192.0.2.8:65535', '[2001:db8::1]:4444', '[2001:DB8::1]:5555', 'not-an-address']) {
    assert.equal((await handle(request({ username: 'synthetic' }, { headers: { 'x-forwarded-for': value } }), 'parameters')).status, 200);
  }
  assert.deepEqual(sources, ['192.0.2.8', '192.0.2.8', '2001:db8::1', '2001:db8::1', 'unavailable']);
});

test('unexpected failures expose no SDK details, request fields, or credentials', async () => {
  const handle = createHandler(() => ({ authentication: { async parameters() { throw new Error('private-proof SDK endpoint detail'); } }, service: {} }));
  const response = await handle(request({ username: 'synthetic' }), 'parameters');
  assert.equal(response.status, 503);
  assert.deepEqual(response.jsonBody, { code: 'UNAVAILABLE' });
  assert.ok(!JSON.stringify(response).includes('private-proof'));
  const limited = createHandler(() => ({ authentication: { async parameters() { throw new ApiError(429, 'RATE_LIMITED'); } }, service: {} }));
  assert.equal((await limited(request({ username: 'synthetic' }), 'parameters')).headers['Retry-After'], '60');
});

test('HTTP flow keeps financial payloads encrypted and invalidates all device sessions on third wrong app passcode', async () => {
  const f = await fixture(undefined, { setup: false });
  const handle = createHandler(() => ({ authentication: f.auth, service: f.service }));
  const payload = encrypted('Synthetic private income 2468.10');
  const setup = await handle(authenticated(f, { pin, expectedEpoch: 1, startEmpty: true, payload }), 'setup');
  assert.equal(setup.status, 200);
  const unlocked = { 'x-budget-unlock': setup.jsonBody.unlockToken };
  const first = await handle(authenticated(f, {}, { method: 'GET', headers: unlocked }), 'budget');
  assert.equal(first.status, 200);
  assert.deepEqual(first.jsonBody.payload, payload);
  assert.ok(!JSON.stringify(first).includes('2468.10'));
  const invalidPlaintext = await handle(authenticated(f, { epoch: setup.jsonBody.epoch, revision: 0, ledger: { payroll: '2468.10' } }, { method: 'PUT', headers: unlocked }), 'budget');
  assert.equal(invalidPlaintext.status, 400);
  for (let i = 0; i < 3; i++) {
    const wrong = await handle(authenticated(f, unlockInput()), 'unlock');
    assert.equal(wrong.status, i === 2 ? 410 : 401);
    assert.equal(wrong.jsonBody.code, i === 2 ? 'ACCOUNT_ERASED' : 'INCORRECT_PASSCODE');
  }
  assert.equal((await handle(authenticated(f, {}, { method: 'GET' }), 'status')).status, 401);
  assert.equal((await f.repository.read(f.identity.ownerId)).ledger, null);
});
