import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyLedger } from '../../shared/model.js';
import type { Ledger } from '../../shared/contracts.js';
import { ApiError, BudgetApi, BudgetSession } from '../src/api.js';
import type { PublicConfig } from '../src/auth.js';

const config: PublicConfig = { configured: true, clientId: '11111111-1111-4111-8111-111111111111', authority: 'https://login.microsoftonline.com/tenant', scope: 'api://33333333-3333-4333-8333-333333333333/Budget.Access', apiBaseUrl: 'https://budget-api.example.test' };
interface Call { path: string; method: string; body: any; headers: Headers; signal?: AbortSignal | null }
function fixture(override?: (call: Call) => Response | Promise<Response> | undefined) {
  const calls: Call[] = []; let epoch = 2, revision = 0;
  const ledger = emptyLedger();
  const fetcher = (async (input, init) => {
    const call: Call = { path: new URL(String(input)).pathname.replace('/api/', ''), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers), signal: init?.signal };
    calls.push(call);
    const custom = override?.(call); if (custom) return custom;
    if (call.path === 'account/status') return Response.json({ state: 'locked', epoch, accountId: 'synthetic-owner' });
    if (call.path === 'account/unlock' || call.path === 'account/setup' || call.path === 'account/pin') return Response.json({ epoch, unlockToken: 'synthetic-unlock-token', expiresAt: new Date(Date.now() + 600_000).toISOString() });
    if (call.path === 'budget' && call.method === 'GET') return Response.json({ epoch, revision, ledger });
    if (call.path === 'budget' && call.method === 'PUT') return Response.json({ epoch, revision: ++revision });
    if (call.path === 'account' && call.method === 'DELETE') return Response.json({ epoch: ++epoch });
    if (call.path === 'account/lock') return Response.json({});
    throw new Error('Unexpected test request: ' + call.path);
  }) as typeof fetch;
  const api = new BudgetApi(config, { accessToken: 'synthetic-api-token', expiresAt: Date.now() + 3600_000 }, fetcher);
  const session = new BudgetSession(api);
  return { api, session, calls, ledger, setEpoch: (value: number) => { epoch = value; } };
}
async function opened(override?: Parameters<typeof fixture>[0]) { const f = fixture(override); await f.session.checkStatus(); await f.session.open('1234'); assert.equal(f.session.snapshot().phase, 'ready'); return f; }
function changed(ledger: Ledger, payroll = '100.00') { const copy = structuredClone(ledger); copy.months[0].periods[0].realistic.payroll = payroll; return copy; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('API always requires bearer authentication and an unlock grant for budget reads', async () => {
  const f = fixture();
  await assert.rejects(f.api.budget(), (error: ApiError) => error.code === 'LOCKED');
  assert.equal(f.calls.length, 0);
  f.api.setGrant('synthetic-grant'); await f.api.budget();
  assert.equal(f.calls[0].headers.get('Authorization'), 'Bearer synthetic-api-token');
  assert.equal(f.calls[0].headers.get('X-Budget-Unlock'), 'synthetic-grant');
  f.api.forgetAuthentication();
  await assert.rejects(f.api.status(), (error: ApiError) => error.code === 'AUTH_REQUIRED');
});

test('each explicit unlock sends one unique attempt identifier and never automatically retries a failed PIN', async () => {
  const f = fixture(call => call.path === 'account/unlock' ? Response.json({ code: 'INCORRECT_PASSCODE' }, { status: 401 }) : undefined);
  await f.session.checkStatus();
  for (let i = 0; i < 2; i++) await f.session.open('9999');
  const attempts = f.calls.filter(c => c.path === 'account/unlock');
  assert.equal(attempts.length, 2);
  assert.equal(new Set(attempts.map(c => c.body.attemptId)).size, 2);
  for (const call of attempts) assert.match(call.body.attemptId, /^[0-9a-f-]{36}$/);
  assert.equal(f.session.snapshot().phase, 'locked');
  f.session.dispose();
});

test('three server-counted wrong attempts erase RAM and preserve the fresh epoch for an empty restart', async () => {
  let failures = 0;
  const f = fixture(call => call.path === 'account/unlock' ? Response.json(++failures < 3 ? { code: 'INCORRECT_PASSCODE' } : { code: 'ACCOUNT_ERASED', epoch: 3 }, { status: failures < 3 ? 401 : 410 }) : undefined);
  await f.session.checkStatus();
  await f.session.open('9999'); await f.session.open('9999'); await f.session.open('9999');
  assert.equal(f.session.snapshot().phase, 'erased');
  assert.equal(f.session.snapshot().epoch, 3);
  assert.equal(f.session.snapshot().ledger, undefined);
  assert.equal(f.calls.filter(c => c.path === 'account/unlock').length, 3);
  await f.session.open('1234', true);
  assert.equal(f.calls.find(c => c.path === 'account/setup')?.body.expectedEpoch, 3);
  assert.equal(f.calls.find(c => c.path === 'account/setup')?.body.startEmpty, true);
  f.session.dispose();
});

test('locking discards queued edits immediately, revokes the grant, and cannot upload them later', async t => {
  const f = await opened(); t.after(() => f.session.dispose());
  f.session.edit(changed(f.session.snapshot().ledger!));
  f.session.lock();
  assert.equal(f.session.snapshot().ledger, undefined);
  assert.equal(f.session.snapshot().phase, 'locked');
  assert.equal(f.session.snapshot().saving, false);
  await f.session.flush();
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 0);
  assert.equal(f.calls.filter(c => c.path === 'account/lock').length, 1);
  await assert.rejects(f.api.budget(), (error: ApiError) => error.code === 'LOCKED');
});

test('remote epoch changes discard unsaved RAM and never re-upload its ledger', async t => {
  const f = await opened(); t.after(() => f.session.dispose());
  f.session.edit(changed(f.session.snapshot().ledger!)); f.setEpoch(3);
  await f.session.checkStatus(); await f.session.flush();
  assert.equal(f.session.snapshot().phase, 'locked'); assert.equal(f.session.snapshot().epoch, 3);
  assert.equal(f.session.snapshot().ledger, undefined);
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 0);
});

test('410 on save clears all queued financial data and stops the save queue', async t => {
  const f = await opened(call => call.method === 'PUT' ? Response.json({ code: 'ACCOUNT_ERASED', epoch: 3 }, { status: 410 }) : undefined); t.after(() => f.session.dispose());
  f.session.edit(changed(f.session.snapshot().ledger!)); await f.session.flush();
  assert.equal(f.session.snapshot().phase, 'erased'); assert.equal(f.session.snapshot().ledger, undefined);
  f.session.edit(changed(f.ledger, '999.00')); await f.session.flush();
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
});

test('409 conflicts clear the local ledger and do not retry or overwrite newer server data', async t => {
  const f = await opened(call => call.method === 'PUT' ? Response.json({ code: 'REVISION_CONFLICT' }, { status: 409 }) : undefined); t.after(() => f.session.dispose());
  f.session.edit(changed(f.session.snapshot().ledger!)); await f.session.flush(); await f.session.flush();
  assert.equal(f.session.snapshot().phase, 'conflict'); assert.equal(f.session.snapshot().ledger, undefined);
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
});

test('late save responses cannot repopulate a locked session or advance its revision', async t => {
  const response = deferred<Response>();
  const f = await opened(call => call.method === 'PUT' ? response.promise : undefined); t.after(() => f.session.dispose());
  f.session.edit(changed(f.session.snapshot().ledger!)); const saving = f.session.flush();
  const put = f.calls.find(c => c.method === 'PUT')!;
  f.session.lock(); assert.equal(put.signal?.aborted, true);
  response.resolve(Response.json({ epoch: 2, revision: 1 })); await saving;
  assert.equal(f.session.snapshot().phase, 'locked'); assert.equal(f.session.snapshot().ledger, undefined); assert.equal(f.session.snapshot().revision, 0);
});

test('invalid intermediate amounts are rejected without replacing the usable ledger or making a request', async t => {
  const f = await opened(); t.after(() => f.session.dispose());
  const ledger = f.session.snapshot().ledger!;
  for (const input of ['.', '-', '1.234', 'NaN', '999999999999999999999999']) f.session.edit(changed(ledger, input));
  assert.equal(f.session.snapshot().ledger, ledger); assert.match(f.session.snapshot().message, /Correct/);
  await f.session.flush(); assert.equal(f.calls.filter(c => c.method === 'PUT').length, 0);
});

test('serialized saves use the latest server revision and a detached copy of queued edits', async t => {
  const first = deferred<Response>(); let saves = 0;
  const f = await opened(call => call.method === 'PUT' ? (++saves === 1 ? first.promise : Response.json({ epoch: 2, revision: 2 })) : undefined); t.after(() => f.session.dispose());
  f.session.edit(changed(f.session.snapshot().ledger!, '100.00')); const saving = f.session.flush();
  const second = changed(f.session.snapshot().ledger!, '200.00'); f.session.edit(second); second.months[0].periods[0].realistic.payroll = '999.00';
  first.resolve(Response.json({ epoch: 2, revision: 1 })); await saving;
  const puts = f.calls.filter(c => c.method === 'PUT');
  assert.deepEqual(puts.map(c => c.body.revision), [0, 1]);
  assert.equal(puts[1].body.ledger.months[0].periods[0].realistic.payroll, '200.00');
  assert.equal(f.session.snapshot().revision, 2); assert.equal(f.session.snapshot().saving, false);
});

test('fresh PIN reauthentication rejects a changed epoch and drops financial memory', async t => {
  const f = await opened(); t.after(() => f.session.dispose()); f.setEpoch(3);
  assert.equal(await f.session.reauthenticate('1234'), false);
  assert.equal(f.session.snapshot().phase, 'erased'); assert.equal(f.session.snapshot().ledger, undefined);
});

test('invalid or expired unlock grants never expose a ledger', async () => {
  for (const grant of [
    { epoch: -1, unlockToken: 'synthetic', expiresAt: new Date(Date.now() + 600_000).toISOString() },
    { epoch: 2, unlockToken: '', expiresAt: new Date(Date.now() + 600_000).toISOString() },
    { epoch: 2, unlockToken: 'synthetic', expiresAt: 'not-a-date' },
    { epoch: 2, unlockToken: 'synthetic', expiresAt: new Date(Date.now() - 1000).toISOString() },
  ]) {
    const f = fixture(call => call.path === 'account/unlock' ? Response.json(grant) : undefined);
    await f.session.checkStatus(); await f.session.open('1234');
    assert.equal(f.session.snapshot().phase, 'unavailable'); assert.equal(f.session.snapshot().ledger, undefined);
    assert.equal(f.calls.filter(c => c.path === 'budget').length, 0); f.session.dispose();
  }
});

test('dispose revokes the current grant and removes access-token authentication', async () => {
  const f = await opened(); f.session.dispose();
  assert.equal(f.calls.filter(c => c.path === 'account/lock').length, 1);
  assert.equal(f.session.snapshot().phase, 'signedOut'); assert.equal(f.session.snapshot().ledger, undefined);
  await assert.rejects(f.api.status(), (error: ApiError) => error.code === 'AUTH_REQUIRED');
});
