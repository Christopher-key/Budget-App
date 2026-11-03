import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { authorizationURL, completeSignIn, consumePKCE, validatePublicConfig, type PublicConfig, type TransientStorage } from '../src/auth.js';

const config: PublicConfig = {
  configured: true, clientId: '11111111-1111-4111-8111-111111111111',
  authority: 'https://login.microsoftonline.com/22222222-2222-4222-8222-222222222222',
  scope: 'api://33333333-3333-4333-8333-333333333333/Budget.Access', apiBaseUrl: 'https://budget-api.example.test',
};
const redirect = 'https://budget.example.test/';
function transient(): TransientStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
}
const cryptoAPI = webcrypto as unknown as Crypto;
async function begin(storage = transient()) {
  const url = new URL(await authorizationURL(config, redirect, storage, cryptoAPI));
  return { storage, url, state: url.searchParams.get('state')! };
}

test('configuration allows only an Azure authority and the custom Budget.Access scope', () => {
  assert.ok(validatePublicConfig(config));
  for (const value of [
    { ...config, configured: false }, { ...config, scope: 'openid profile offline_access' },
    { ...config, scope: `${config.scope} https://graph.microsoft.com/User.Read` },
    { ...config, scope: 'api://33333333-3333-4333-8333-333333333333/Other.Access' },
    { ...config, authority: 'https://login.microsoftonline.com.attacker.test/tenant' },
    { ...config, authority: 'https://user:password@login.microsoftonline.com/tenant' },
    { ...config, authority: 'http://login.microsoftonline.com/tenant' },
    { ...config, apiBaseUrl: 'http://budget-api.example.test' },
    { ...config, apiBaseUrl: 'https://budget-api.example.test/api' },
  ]) assert.equal(validatePublicConfig(value), null);
});

test('authorization uses a fresh S256 challenge and custom scope without refresh or ID token scopes', async () => {
  const first = await begin(), second = await begin();
  assert.equal(first.url.searchParams.get('scope'), config.scope);
  assert.equal(first.url.searchParams.get('response_type'), 'code');
  assert.equal(first.url.searchParams.get('code_challenge_method'), 'S256');
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.url.searchParams.get('code_challenge'), second.url.searchParams.get('code_challenge'));
  const verifier = consumePKCE(first.storage, first.state, redirect);
  const challenge = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
  assert.equal(challenge, first.url.searchParams.get('code_challenge'));
  assert.equal(first.storage.data.size, 0);
  assert.throws(() => consumePKCE(first.storage, first.state, redirect), /expired/);
});

test('state mismatch, redirect mismatch, stale state, and malformed verifier fail closed and consume state', async () => {
  for (const change of [
    (entry: any) => { entry.state = 'wrong-state'; },
    (entry: any) => { entry.redirectUri = 'https://attacker.example.test/'; },
    (entry: any) => { entry.createdAt = Date.now() - 600_001; },
    (entry: any) => { entry.createdAt = Date.now() + 60_000; },
    (entry: any) => { entry.verifier = {}; },
  ]) {
    const { storage, state } = await begin();
    const [key, raw] = [...storage.data.entries()][0];
    const entry = JSON.parse(raw); change(entry); storage.setItem(key, JSON.stringify(entry));
    assert.throws(() => consumePKCE(storage, state, redirect), /could not be verified/);
    assert.equal(storage.data.size, 0);
  }
});

test('token exchange uses the consumed verifier; only access token and expiry survive', async () => {
  const { storage, state } = await begin();
  let calls = 0;
  const fetcher = (async (url, init) => {
    calls++;
    assert.equal(url, config.authority + '/oauth2/v2.0/token');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.redirect, 'error');
    const body = new URLSearchParams(init?.body as URLSearchParams);
    assert.equal(body.get('scope'), config.scope);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.match(body.get('code_verifier')!, /^[A-Za-z0-9_-]{43,128}$/);
    return Response.json({ access_token: 'synthetic-access-token', expires_in: 3600, id_token: 'discarded', refresh_token: 'discarded' });
  }) as typeof fetch;
  const auth = await completeSignIn(config, `?code=synthetic-code&state=${state}`, redirect, storage, fetcher);
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(auth!).sort(), ['accessToken', 'expiresAt']);
  assert.equal(auth?.accessToken, 'synthetic-access-token');
  assert.ok(auth!.expiresAt > Date.now());
  assert.equal(storage.data.size, 0);
});

test('unverified and ambiguous callbacks never reach the token endpoint', async () => {
  for (const query of ['?code=x&state=wrong', '?code=x&code=y&state=x', '?error=access_denied']) {
    const { storage } = await begin(); let calls = 0;
    await assert.rejects(completeSignIn(config, query, redirect, storage, (async () => { calls++; throw new Error('unexpected'); }) as typeof fetch));
    assert.equal(calls, 0); assert.equal(storage.data.size, 0);
  }
});

test('empty or already-expired access token responses are rejected', async () => {
  for (const response of [{ access_token: '', expires_in: 3600 }, { access_token: 'synthetic', expires_in: 10 }, null]) {
    const { storage, state } = await begin();
    await assert.rejects(completeSignIn(config, `?code=x&state=${state}`, redirect, storage, (async () => Response.json(response)) as typeof fetch), /invalid/);
  }
});
