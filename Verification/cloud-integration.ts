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
import type { SecurityGate } from '../shared/security.js';
import { ApiError } from '../api/src/types.js';
import { SecurityMonitor } from '../web/src/security.js';

const origin = 'https://budget.example.test';
const config = { configured: true as const, apiBaseUrl: 'https://api.example.test' };
const routes: Record<string, Route> = {
  'auth/parameters': 'parameters', 'auth/register': 'register', 'auth/login': 'login',
  'auth/logout': 'logout', 'account/status': 'status', 'account/setup': 'setup',
  'account/unlock': 'unlock', 'account/lock': 'lock', 'account/pin': 'pin',
  account: 'erase', budget: 'budget',
};

function fixture(gate?: SecurityGate) {
  process.env.APP_ORIGIN = origin;
  const repository = new MemoryRepository();
  const secrets = { lookupKey: randomBytes(32).toString('base64url'), pepper: randomBytes(32).toString('base64url') };
  const authentication = new AuthenticationService(repository, secrets);
  const service = new BudgetService(repository, Date.now, secrets.pepper);
  const handle = createHandler(() => ({ authentication, service }), gate ? () => gate : undefined);
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

test('site lockdown clears two web sessions without deleting encrypted budgets and recovery rejects their old credentials', async () => {
  let locked = false, generation = 1;
  const gate: SecurityGate = {
    async check(expected) {
      if (locked) throw new ApiError(503, 'SERVICE_LOCKED');
      if (expected !== undefined && expected !== generation) throw new ApiError(401, 'AUTH_REQUIRED');
      return generation;
    },
    async status() { return { schemaVersion: 1, state: locked ? 'locked' : 'open', generation }; },
  };
  const { repository, fetcher } = fixture(gate);
  const username = 'synthetic-lockdown-check', password = 'Example-only password 8163!';
  const securityA = new SecurityMonitor({}), securityB = new SecurityMonitor({});
  const authA = await authenticate(config, username, password, true, fetcher, securityA);
  const oldBearer = authA.accessToken;
  const deviceA = new BudgetSession(new BudgetApi(config, authA, fetcher, securityA));
  let deviceB: BudgetSession | undefined, recovered: BudgetSession | undefined;
  try {
    await deviceA.checkStatus(); await deviceA.open('3141', true);
    const edited = structuredClone(deviceA.snapshot().ledger!);
    edited.months[0].periods[0].realistic.payroll = '1234.56';
    deviceA.edit(edited); await deviceA.flush();
    const authB = await authenticate(config, username, password, false, fetcher, securityB);
    deviceB = new BudgetSession(new BudgetApi(config, authB, fetcher, securityB));
    await deviceB.checkStatus(); await deviceB.open('3141');
    const before = await repository.read(authA.accountId);

    locked = true; generation = 2;
    await deviceA.checkStatus(); await deviceB.checkStatus();
    for (const [device, monitor] of [[deviceA, securityA], [deviceB, securityB]] as const) {
      assert.equal(monitor.snapshot().phase, 'locked');
      assert.equal(device.snapshot().ledger, undefined);
      assert.equal(device.api.isAuthenticated(), false);
    }
    const during = await repository.read(authA.accountId);
    assert.deepEqual(during.ledger, before.ledger, 'global incident control does not erase financial records');
    assert.ok(during.access?.credentials, 'global control is separate from three-wrong-PIN account erasure');

    locked = false; generation = 3;
    const stale = await fetcher(config.apiBaseUrl + '/api/account/status', {
      headers: { Authorization: 'Bearer ' + oldBearer }, credentials: 'omit', cache: 'no-store',
    });
    assert.equal(stale.status, 401);
    const fresh = await authenticate(config, username, password, false, fetcher);
    recovered = new BudgetSession(new BudgetApi(config, fresh, fetcher));
    await recovered.checkStatus(); await recovered.open('3141');
    assert.equal(recovered.snapshot().phase, 'ready');
    assert.equal(recovered.snapshot().ledger!.months[0].periods[0].realistic.payroll, '1234.56');
    assert.deepEqual((await repository.read(authA.accountId)).ledger, before.ledger);
  } finally { deviceA.dispose(); deviceB?.dispose(); recovered?.dispose(); }
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
