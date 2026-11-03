import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyLedger } from '../../shared/model.js';
import type { Ledger } from '../../shared/contracts.js';
import { ApiError, BudgetApi, BudgetSession } from '../src/api.js';
import type { PublicConfig } from '../src/auth.js';
import { decryptLedger, encode, encryptLedger } from '../src/crypto.js';

const config: PublicConfig = { configured: true, apiBaseUrl: 'https://budget-api.example.test' };
const accountId = encode(new Uint8Array(32).fill(7));
const unlockToken = encode(new Uint8Array(32).fill(9));
const accessToken = accountId + '.' + encode(new Uint8Array(32).fill(3));
interface Call { path: string; method: string; body: any; headers: Headers; signal?: AbortSignal | null }
async function fixture(override?: (call: Call) => Response | Promise<Response> | undefined) {
  const calls: Call[] = []; let epoch = 2, revision = 0;
  let ledger = emptyLedger();
  const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const fetcher = (async (input, init) => {
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.cache, 'no-store'); assert.equal(init?.redirect, 'error');
    const call: Call = { path: new URL(String(input)).pathname.replace('/api/', ''), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers), signal: init?.signal };
    calls.push(call);
    const custom = override?.(call); if (custom) return custom;
    if (call.path === 'account/status') return Response.json({ state: 'locked', epoch, revision, accountId });
    if (call.path === 'account/unlock' || call.path === 'account/pin') return Response.json({ epoch, unlockToken, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    if (call.path === 'account/setup') { epoch = call.body.expectedEpoch + 1; revision = 0; ledger = await decryptLedger(dataKey, accountId, epoch, revision, call.body.payload); return Response.json({ epoch, unlockToken, expiresAt: new Date(Date.now() + 600_000).toISOString() }); }
    if (call.path === 'budget' && call.method === 'GET') return Response.json({ epoch, revision, payload: await encryptLedger(dataKey, accountId, epoch, revision, ledger) });
    if (call.path === 'budget' && call.method === 'PUT') { assert.equal(call.body.epoch, epoch); assert.equal(call.body.revision, revision); ledger = await decryptLedger(dataKey, accountId, epoch, revision + 1, call.body.payload); return Response.json({ epoch, revision: ++revision }); }
    if (call.path === 'account' && call.method === 'DELETE') return Response.json({ epoch: ++epoch });
    if (call.path === 'account/lock' || call.path === 'auth/logout') return new Response(null, { status: 204 });
    throw new Error('Unexpected test request: ' + call.path);
  }) as typeof fetch;
  const api = new BudgetApi(config, { accessToken, expiresAt: Date.now() + 1_800_000, accountId, dataKey }, fetcher);
  const session = new BudgetSession(api);
  return { api, session, calls, ledger, dataKey, setEpoch: (value: number) => { epoch = value; }, remoteSave: (value: Ledger) => { ledger = value; revision++; } };
}
async function opened(override?: Parameters<typeof fixture>[0]) { const f = await fixture(override); await f.session.checkStatus(); await f.session.open('1234'); assert.equal(f.session.snapshot().phase, 'ready'); return f; }
function changed(ledger: Ledger, payroll = '100.00') { const copy = structuredClone(ledger); copy.months[0].periods[0].realistic.payroll = payroll; return copy; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function requestStarted(calls: Call[], method: string) { for (let i = 0; i < 100; i++) { const found = calls.find(c => c.method === method); if (found) return found; await new Promise(resolve => setTimeout(resolve, 1)); } throw new Error('Expected request did not start.'); }

test('budget reads require bearer identity and a session-bound unlock grant; first status must match the signed-in account', async () => {
  const f = await fixture();
  await assert.rejects(f.api.budget(), (error: ApiError) => error.code === 'LOCKED');
  assert.equal(f.calls.length, 0);
  f.api.setGrant(unlockToken); await f.api.budget();
  assert.equal(f.calls[0].headers.get('Authorization'), 'Bearer ' + accessToken);
  assert.equal(f.calls[0].headers.get('X-Budget-Unlock'), unlockToken);
  f.api.forgetAuthentication(); await assert.rejects(f.api.status(), (error: ApiError) => error.code === 'AUTH_REQUIRED');
  const other = await fixture(call => call.path === 'account/status' ? Response.json({ state: 'locked', epoch: 2, revision: 0, accountId: encode(new Uint8Array(32).fill(4)) }) : undefined);
  await other.session.checkStatus(); assert.equal(other.session.snapshot().phase, 'unavailable'); other.session.dispose();
});

test('setup and saves send authenticated ciphertext rather than financial records or encryption keys', async t => {
  const f = await fixture(); t.after(() => f.session.dispose());
  await f.session.checkStatus(); await f.session.open('1234', true);
  assert.equal(f.session.snapshot().phase, 'ready');
  const setup = f.calls.find(c => c.path === 'account/setup')!;
  assert.deepEqual(Object.keys(setup.body).sort(), ['expectedEpoch', 'payload', 'pin', 'startEmpty']);
  assert.equal((await decryptLedger(f.dataKey, accountId, 3, 0, setup.body.payload)).schemaVersion, 1);
  f.session.edit(changed(f.session.snapshot().ledger!, '8765.43')); await f.session.flush();
  const put = f.calls.find(c => c.method === 'PUT')!;
  assert.deepEqual(Object.keys(put.body).sort(), ['epoch', 'payload', 'revision']);
  assert.ok(!JSON.stringify(put.body).includes('8765.43')); assert.ok(!JSON.stringify(put.body).includes('payroll'));
  assert.equal((await decryptLedger(f.dataKey, accountId, 3, 1, put.body.payload)).months[0].periods[0].realistic.payroll, '8765.43');
});

test('each explicit unlock has one unique attempt identifier with no automatic retry of wrong PINs', async () => {
  const f = await fixture(call => call.path === 'account/unlock' ? Response.json({ code: 'INCORRECT_PASSCODE' }, { status: 401 }) : undefined);
  await f.session.checkStatus(); await f.session.open('9999'); await f.session.open('9999');
  const attempts = f.calls.filter(c => c.path === 'account/unlock');
  assert.equal(attempts.length, 2); assert.equal(new Set(attempts.map(c => c.body.attemptId)).size, 2);
  for (const call of attempts) assert.match(call.body.attemptId, /^[0-9a-f-]{36}$/);
  assert.equal(f.session.snapshot().phase, 'locked'); f.session.dispose();
});

test('third wrong PIN clears financial memory and account key, so an erased session cannot recreate data', async () => {
  let failures = 0;
  const f = await fixture(call => call.path === 'account/unlock' ? Response.json(++failures < 3 ? { code: 'INCORRECT_PASSCODE' } : { code: 'ACCOUNT_ERASED', epoch: 3 }, { status: failures < 3 ? 401 : 410 }) : undefined);
  await f.session.checkStatus(); await f.session.open('9999'); await f.session.open('9999'); await f.session.open('9999');
  assert.equal(f.session.snapshot().phase, 'erased'); assert.equal(f.session.snapshot().epoch, 3); assert.equal(f.session.snapshot().ledger, undefined);
  await assert.rejects(f.api.status(), (error: ApiError) => error.code === 'AUTH_REQUIRED');
  await f.session.open('1234', true); assert.equal(f.calls.filter(c => c.path === 'account/setup').length, 0); f.session.dispose();
});

test('locking immediately clears financial memory, then saves only encrypted queued edits before revoking the old grant', async t => {
  const f = await opened(); t.after(() => f.session.dispose());
  f.session.edit(changed(f.session.snapshot().ledger!, '432.10')); const locking = f.session.lock();
  assert.equal(f.session.snapshot().ledger, undefined); assert.equal(f.session.snapshot().phase, 'locked'); assert.equal(f.session.snapshot().saving, false);
  await f.session.flush(); await assert.rejects(f.api.budget(), (error: ApiError) => error.code === 'LOCKED');
  assert.equal(await locking, true);
  const put = f.calls.find(c => c.method === 'PUT')!;
  assert.ok(!JSON.stringify(put.body).includes('432.10'));
  assert.equal((await decryptLedger(f.dataKey, accountId, 2, 1, put.body.payload)).months[0].periods[0].realistic.payroll, '432.10');
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  assert.ok(f.calls.indexOf(put) < f.calls.findIndex(c => c.path === 'account/lock'));
  await f.session.open('1234'); assert.equal(f.session.snapshot().ledger?.months[0].periods[0].realistic.payroll, '432.10');
});

test('remote epoch changes discard unsaved memory and never restore the older budget', async t => {
  const f = await opened(); t.after(() => f.session.dispose()); f.session.edit(changed(f.session.snapshot().ledger!)); f.setEpoch(3);
  await f.session.checkStatus(); await f.session.flush();
  assert.equal(f.session.snapshot().phase, 'locked'); assert.equal(f.session.snapshot().epoch, 3); assert.equal(f.session.snapshot().ledger, undefined); assert.equal(f.calls.filter(c => c.method === 'PUT').length, 0);
});

test('a clean open device automatically decrypts a newer remote revision', async t => {
  const f = await opened(); t.after(() => f.session.dispose()); f.remoteSave(changed(f.ledger, '250.00'));
  await f.session.checkStatus(); assert.equal(f.session.snapshot().revision, 1); assert.equal(f.session.snapshot().ledger?.months[0].periods[0].realistic.payroll, '250.00');
});

test('erase or revision conflict on save clears queued financial data and never retries the overwrite', async t => {
  for (const [code, status, phase] of [['ACCOUNT_ERASED', 410, 'erased'], ['REVISION_CONFLICT', 409, 'conflict']] as const) {
    const f = await opened(call => call.method === 'PUT' ? Response.json({ code, epoch: 3 }, { status }) : undefined); t.after(() => f.session.dispose());
    f.session.edit(changed(f.session.snapshot().ledger!)); await f.session.flush(); await f.session.flush();
    assert.equal(f.session.snapshot().phase, phase); assert.equal(f.session.snapshot().ledger, undefined); assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  }
});

test('a write still encrypting when lock begins can finish without repopulating financial memory', async t => {
  const f = await opened(); t.after(() => f.session.dispose());
  f.session.edit(changed(f.session.snapshot().ledger!, '654.32')); const saving = f.session.flush();
  // Lock in the same turn, before Web Crypto resolves or fetch receives the PUT.
  const locking = f.session.lock(); assert.equal(f.session.snapshot().ledger, undefined);
  assert.equal(await locking, true); await saving;
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  assert.equal(f.session.snapshot().phase, 'locked'); assert.equal(f.session.snapshot().ledger, undefined); assert.equal(f.session.snapshot().revision, 0);
  await f.session.open('1234'); assert.equal(f.session.snapshot().ledger?.months[0].periods[0].realistic.payroll, '654.32');
});

test('lock waits for an in-flight revision before saving the latest encrypted queued edit and revoking', async t => {
  const response = deferred<Response>(); let puts = 0;
  const f = await opened(call => call.method === 'PUT' && ++puts === 1 ? response.promise : undefined); t.after(() => f.session.dispose());
  f.session.edit(changed(f.session.snapshot().ledger!, '100.00')); const saving = f.session.flush(); const first = await requestStarted(f.calls, 'PUT');
  f.session.edit(changed(f.session.snapshot().ledger!, '200.00')); const locking = f.session.lock();
  assert.equal(first.signal?.aborted, false); assert.equal(f.session.snapshot().ledger, undefined);
  assert.equal(f.calls.filter(c => c.path === 'account/lock').length, 0);
  // Simulate acknowledgement from the first successful revision, then let the
  // default adapter store the second. Its state must reflect that first commit.
  f.remoteSave(changed(f.ledger, '100.00')); response.resolve(Response.json({ epoch: 2, revision: 1 }));
  assert.equal(await locking, true); await saving;
  const writes = f.calls.filter(c => c.method === 'PUT');
  assert.deepEqual(writes.map(c => c.body.revision), [0, 1]);
  assert.equal((await decryptLedger(f.dataKey, accountId, 2, 2, writes[1].body.payload)).months[0].periods[0].realistic.payroll, '200.00');
  assert.ok(f.calls.indexOf(writes[1]) < f.calls.findIndex(c => c.path === 'account/lock'));
  assert.equal(f.session.snapshot().phase, 'locked'); assert.equal(f.session.snapshot().ledger, undefined);
});

test('erasure during the encrypted lock flush drops account keys and never retries stale data', async t => {
  const f = await opened(call => call.method === 'PUT' ? Response.json({ code: 'ACCOUNT_ERASED', epoch: 3 }, { status: 410 }) : undefined); t.after(() => f.session.dispose());
  f.session.edit(changed(f.session.snapshot().ledger!)); const locking = f.session.lock();
  assert.equal(f.session.snapshot().ledger, undefined); assert.equal(await locking, false);
  assert.equal(f.session.snapshot().phase, 'signedOut');
  await assert.rejects(f.api.status(), (error: ApiError) => error.code === 'AUTH_REQUIRED');
  await f.session.flush(); assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
});

test('an unresponsive lock flush is bounded and late acknowledgements cannot restore memory', async t => {
  const response = deferred<Response>(); const f = await opened(call => call.method === 'PUT' ? response.promise : undefined); t.after(() => { t.mock.timers.reset(); f.session.dispose(); });
  f.session.edit(changed(f.session.snapshot().ledger!)); const saving = f.session.flush(); const first = await requestStarted(f.calls, 'PUT');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const locking = f.session.lock(); t.mock.timers.tick(8_000);
  assert.equal(await locking, false); assert.equal(first.signal?.aborted, true);
  assert.equal(f.session.snapshot().phase, 'locked'); assert.equal(f.session.snapshot().ledger, undefined); assert.match(f.session.snapshot().message, /could not be confirmed/);
  response.resolve(Response.json({ epoch: 2, revision: 1 })); await saving;
  assert.equal(f.session.snapshot().ledger, undefined); assert.equal(f.session.snapshot().revision, 0);
});

test('invalid amounts cannot replace the valid ledger or cause a save', async t => {
  const f = await opened(); t.after(() => f.session.dispose()); const ledger = f.session.snapshot().ledger!;
  for (const value of ['.', '-', '1.234', 'NaN', '999999999999999999999999']) f.session.edit(changed(ledger, value));
  assert.equal(f.session.snapshot().ledger, ledger); assert.match(f.session.snapshot().message, /Correct/); await f.session.flush(); assert.equal(f.calls.filter(c => c.method === 'PUT').length, 0);
});

test('serialized encrypted saves use successive revisions and detached queued edits', async t => {
  const first = deferred<Response>(); let saves = 0;
  const f = await opened(call => call.method === 'PUT' ? (++saves === 1 ? first.promise : Response.json({ epoch: 2, revision: 2 })) : undefined); t.after(() => f.session.dispose());
  f.session.edit(changed(f.session.snapshot().ledger!, '100.00')); const saving = f.session.flush(); await requestStarted(f.calls, 'PUT');
  const second = changed(f.session.snapshot().ledger!, '200.00'); f.session.edit(second); second.months[0].periods[0].realistic.payroll = '999.00';
  first.resolve(Response.json({ epoch: 2, revision: 1 })); await saving;
  const puts = f.calls.filter(c => c.method === 'PUT'); assert.deepEqual(puts.map(c => c.body.revision), [0, 1]);
  assert.equal((await decryptLedger(f.dataKey, accountId, 2, 2, puts[1].body.payload)).months[0].periods[0].realistic.payroll, '200.00'); assert.equal(f.session.snapshot().revision, 2); assert.equal(f.session.snapshot().saving, false);
});

test('tampered ciphertext and malformed grants fail closed without exposing a ledger', async () => {
  const f = await fixture(call => call.path === 'budget' ? Response.json({ epoch: 2, revision: 0, payload: { v: 1, iv: encode(new Uint8Array(12)), data: encode(new Uint8Array(32)) } }) : undefined);
  await f.session.checkStatus(); await f.session.open('1234'); assert.equal(f.session.snapshot().phase, 'unavailable'); assert.equal(f.session.snapshot().ledger, undefined); f.session.dispose();
  for (const grant of [{ epoch: -1, unlockToken, expiresAt: new Date(Date.now() + 600_000).toISOString() }, { epoch: 2, unlockToken: '', expiresAt: new Date(Date.now() + 600_000).toISOString() }, { epoch: 2, unlockToken, expiresAt: 'not-a-date' }, { epoch: 2, unlockToken, expiresAt: new Date(Date.now() - 1000).toISOString() }]) {
    const invalid = await fixture(call => call.path === 'account/unlock' ? Response.json(grant) : undefined);
    await invalid.session.checkStatus(); await invalid.session.open('1234'); assert.equal(invalid.session.snapshot().phase, 'unavailable'); assert.equal(invalid.calls.filter(c => c.path === 'budget').length, 0); invalid.session.dispose();
  }
});

test('explicit erasure requires the unlock grant, and disposal logs out and drops authentication', async () => {
  const f = await opened(); await f.session.erase(); assert.equal(f.calls.find(c => c.path === 'account' && c.method === 'DELETE')?.headers.get('X-Budget-Unlock'), unlockToken);
  assert.equal(f.session.snapshot().phase, 'erased'); await assert.rejects(f.api.status(), (error: ApiError) => error.code === 'AUTH_REQUIRED'); f.session.dispose();
  const g = await opened(); g.session.dispose(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(g.calls.filter(c => c.path === 'account/lock').length, 1); assert.equal(g.calls.filter(c => c.path === 'auth/logout').length, 1);
  assert.equal(g.session.snapshot().phase, 'signedOut'); assert.equal(g.session.snapshot().ledger, undefined); await assert.rejects(g.api.status(), (error: ApiError) => error.code === 'AUTH_REQUIRED');
});
