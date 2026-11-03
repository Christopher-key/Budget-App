// Synthetic cross-layer checks only. Never put a real account or budget here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AuthenticationService } from '../api/src/auth.js';
import { BudgetService } from '../api/src/service.js';
import { MemoryRepository } from '../api/src/repository.js';
import { createHandler, type Route } from '../api/src/functions.js';
import { authenticate } from '../web/src/auth.js';
import { BudgetApi, BudgetSession } from '../web/src/api.js';
import type { Ledger } from '../shared/contracts.js';

const origin = 'https://budget.example.test';
const config = { configured: true as const, apiBaseUrl: 'https://api.example.test' };
const routes: Record<string, Route> = {
  'auth/parameters': 'parameters', 'auth/register': 'register', 'auth/login': 'login',
  'auth/logout': 'logout', 'account/status': 'status', 'account/setup': 'setup',
  'account/unlock': 'unlock', 'account/lock': 'lock', 'account/pin': 'pin',
  account: 'erase', budget: 'budget',
};

function fixture() {
  process.env.APP_ORIGIN = origin;
  const repository = new MemoryRepository();
  const secrets = { lookupKey: randomBytes(32).toString('base64url'), pepper: randomBytes(32).toString('base64url') };
  const authentication = new AuthenticationService(repository, secrets);
  const service = new BudgetService(repository, Date.now, secrets.pepper);
  const handle = createHandler(() => ({ authentication, service }));
  const requests: { path: string; method: string; headers: Headers; body: string }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), path = url.pathname.replace(/^\/api\//, '');
    assert.equal(url.origin, config.apiBaseUrl, 'no identity, bank, or AI endpoint is contacted');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.cache, 'no-store');
    const headers = new Headers(init?.headers); headers.set('origin', origin);
    const method = init?.method ?? 'GET', body = String(init?.body ?? '');
    requests.push({ path, method, headers, body });
    const response = await handle({ method, headers, text: async () => body } as never, routes[path]);
    return new Response(response.jsonBody === undefined ? null : JSON.stringify(response.jsonBody), {
      status: response.status, headers: response.headers as HeadersInit,
    });
  };
  return { repository, requests, fetcher };
}

test('real browser crypto and API sync two devices, then third wrong PIN revokes both without a stale restore', async () => {
  const { repository, requests, fetcher } = fixture();
  const username = 'synthetic-device-check', password = 'Example-only password 6148!';
  const authA = await authenticate(config, username, password, true, fetcher);
  const apiA = new BudgetApi(config, authA, fetcher), deviceA = new BudgetSession(apiA);
  let deviceB: BudgetSession | undefined;
  try {
    await deviceA.checkStatus();
    assert.equal(deviceA.snapshot().phase, 'new');
    await deviceA.open('3141', true);
    assert.equal(deviceA.snapshot().phase, 'ready');
    const edited = structuredClone(deviceA.snapshot().ledger!);
    edited.months[0].periods[0].realistic.payroll = '4321.09';
    deviceA.edit(edited); await deviceA.flush();
    assert.equal(deviceA.snapshot().saving, false);
    const snapshot = await repository.read(authA.accountId);
    const stored = JSON.stringify(snapshot);
    assert.ok(snapshot.ledger?.payload);
    assert.doesNotMatch(stored, /4321\.09|payroll|realistic|months|Example-only password/);
    const proof = JSON.parse(requests.find(r => r.path === 'auth/register')!.body).proof;
    assert.equal(stored.includes(proof), false, 'the server stores a slow verifier, not the login proof');
    assert.equal(requests.some(r => r.body.includes(password)), false, 'the password never leaves the client');

    const authB = await authenticate(config, username, password, false, fetcher);
    deviceB = new BudgetSession(new BudgetApi(config, authB, fetcher));
    await deviceB.checkStatus(); await deviceB.open('3141');
    assert.equal(deviceB.snapshot().ledger!.months[0].periods[0].realistic.payroll, '4321.09');
    const secondEdit = structuredClone(deviceB.snapshot().ledger!);
    secondEdit.months[0].periods[0].realistic.extra = '67.89';
    deviceB.edit(secondEdit); await deviceB.flush(); await deviceA.checkStatus();
    assert.equal(deviceA.snapshot().ledger!.months[0].periods[0].realistic.extra, '67.89');

    const staleSave = requests.filter(r => r.path === 'budget' && r.method === 'PUT').at(-1)!;
    for (let n = 0; n < 3; n++) assert.equal(await deviceA.reauthenticate('0000'), false);
    assert.equal(deviceA.snapshot().phase, 'erased');
    assert.equal(deviceA.snapshot().ledger, undefined);
    await deviceB.checkStatus();
    assert.equal(deviceB.snapshot().phase, 'signedOut');
    assert.equal(deviceB.snapshot().ledger, undefined);
    const erased = await repository.read(authA.accountId);
    assert.equal(erased.access?.state, 'erased');
    assert.equal(erased.access?.credentials, undefined);
    assert.equal(erased.access?.sessions, undefined);
    assert.equal(erased.ledger, null);
    const late = await fetcher(config.apiBaseUrl + '/api/budget', {
      method: 'PUT', headers: staleSave.headers, body: staleSave.body, credentials: 'omit', cache: 'no-store',
    });
    assert.equal(late.status, 401);
    assert.equal((await repository.read(authA.accountId)).ledger, null);
  } finally { deviceA.dispose(); deviceB?.dispose(); }
});

test('three wrong public account passwords leave the encrypted budget and PIN failure counter intact', async () => {
  const { repository, fetcher } = fixture();
  const username = 'synthetic-password-check', password = 'Example-only password 4937!';
  const auth = await authenticate(config, username, password, true, fetcher);
  const device = new BudgetSession(new BudgetApi(config, auth, fetcher));
  try {
    await device.checkStatus(); await device.open('2718', true);
    const before = await repository.read(auth.accountId);
    for (let n = 0; n < 3; n++) {
      await assert.rejects(authenticate(config, username, 'An incorrect example password!', false, fetcher));
    }
    const after = await repository.read(auth.accountId);
    assert.equal(after.access?.state, 'locked');
    assert.equal(after.access?.failures, 0);
    assert.deepEqual(after.ledger, before.ledger);
    await device.checkStatus();
    assert.equal(device.snapshot().phase, 'ready');
    assert.ok(device.snapshot().ledger as Ledger);
  } finally { device.dispose(); }
});
