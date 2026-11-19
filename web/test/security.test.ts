import assert from 'node:assert/strict';
import test from 'node:test';
import { SecurityMonitor, ServiceSecurityError, validateServiceStatus } from '../src/security.js';

const required = { securityGateRequired: true, securityStatusUrl: 'https://security.example.test/api/service/status' };
const documentForTest = () => new EventTarget() as EventTarget & { hidden: boolean };
const status = (state = 'open', generation = 1) => Response.json({ schemaVersion: 1, state, generation });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function flushPromises() { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); }

test('controller status is checked before any operation and failures deny access without exposing incident metadata', async () => {
  let next = status();
  const monitor = new SecurityMonitor(required, (async (_url, init) => {
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.cache, 'no-store'); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), null);
    return next;
  }) as typeof fetch);
  assert.equal(monitor.snapshot().phase, 'checking'); assert.throws(() => monitor.operation(), ServiceSecurityError);
  await monitor.check(); const operation = monitor.operation();
  next = status('locked', 2); await monitor.check();
  assert.equal(monitor.snapshot().phase, 'locked'); assert.equal(operation.signal.aborted, true); assert.throws(operation.assertOpen, ServiceSecurityError);
  next = status('open', 2); await monitor.check(); assert.equal(monitor.snapshot().phase, 'unavailable');
  next = status('open', 3); await monitor.check(); assert.equal(monitor.snapshot().phase, 'open');
  next = Response.json({ schemaVersion: 1, state: 'open', generation: 4, incident: 'private incident detail' });
  await monitor.check(); assert.equal(monitor.snapshot().phase, 'unavailable');
  assert.ok(!JSON.stringify(monitor.snapshot()).includes('private'));
  for (const value of [null, [], {}, { schemaVersion: 1, state: 'open', generation: -1 }, { schemaVersion: 1, state: 'open', generation: 1.1 }]) assert.throws(() => validateServiceStatus(value));
});

test('a stale controller response cannot undo a backend denial', async () => {
  const response = deferred<Response>();
  const monitor = new SecurityMonitor(required, (async () => response.promise) as typeof fetch);
  const checking = monitor.check(); monitor.reportFailure('SERVICE_LOCKED'); response.resolve(status('open', 1)); await checking;
  assert.equal(monitor.snapshot().phase, 'locked');
});

test('controller outages and generation rollback fail closed', async () => {
  let next = status('open', 10);
  const monitor = new SecurityMonitor(required, (async () => next) as typeof fetch);
  await monitor.check(); assert.equal(monitor.snapshot().phase, 'open');
  next = status('open', 9); await monitor.check(); assert.equal(monitor.snapshot().phase, 'unavailable');
  next = new Response('not json', { status: 503 }); await monitor.check(); assert.equal(monitor.snapshot().phase, 'unavailable');
  const failure = new SecurityMonitor(required, (async () => next) as typeof fetch);
  next = status(); await failure.check();
  next = new Response('private diagnostics', { status: 503 });
  await failure.check(); assert.equal(failure.snapshot().phase, 'unavailable');
});

test('hiding suspends operations immediately and resume verifies status before admitting new operations', async () => {
  let pending: ReturnType<typeof deferred<Response>> | undefined;
  const monitor = new SecurityMonitor(required, (async () => pending ? pending.promise : status()) as typeof fetch);
  await monitor.check(); const operation = monitor.operation();
  const page = documentForTest(); page.hidden = false;
  const stop = monitor.start(page);
  await monitor.check();
  page.hidden = true; page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(monitor.snapshot().phase, 'checking'); assert.equal(operation.signal.aborted, true);
  pending = deferred<Response>(); page.hidden = false; page.dispatchEvent(new Event('visibilitychange'));
  assert.throws(() => monitor.operation(), ServiceSecurityError);
  pending.resolve(status());
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(monitor.snapshot().phase, 'open'); stop();
  assert.throws(() => monitor.operation(), ServiceSecurityError);
});


test('an unresponsive status check denies access at timeout even if fetch ignores abort', async t => {
  const response = deferred<Response>(); let hang = false;
  const monitor = new SecurityMonitor(required, (async () => hang ? response.promise : status()) as typeof fetch);
  await monitor.check(); const operation = monitor.operation(); hang = true;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = monitor.check(); t.mock.timers.tick(5_000);
  assert.equal(monitor.snapshot().phase, 'unavailable'); assert.equal(operation.signal.aborted, true);
  response.resolve(status()); await pending; assert.equal(monitor.snapshot().phase, 'unavailable');
  t.mock.timers.reset();
});

test('a timed-out initial request retries while closed and opens without a refresh', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => t.mock.timers.reset());
  const cold = deferred<Response>(); let calls = 0; let firstSignal: AbortSignal | undefined;
  const monitor = new SecurityMonitor(required, (async (_url, init) => {
    calls++; if (calls === 1) { firstSignal = init?.signal as AbortSignal; return cold.promise; }
    return status('open', 2);
  }) as typeof fetch);
  const checking = monitor.check();
  t.mock.timers.tick(5_000); await flushPromises();
  assert.equal(firstSignal?.aborted, true); assert.equal(monitor.snapshot().phase, 'checking');
  assert.equal(monitor.snapshot().generation, null); assert.throws(() => monitor.operation(true), ServiceSecurityError);
  t.mock.timers.tick(1_000); await checking;
  assert.equal(calls, 2); assert.equal(monitor.snapshot().phase, 'open'); assert.equal(monitor.snapshot().generation, 2);
  cold.resolve(status('locked', 100)); await flushPromises();
  assert.equal(monitor.snapshot().phase, 'open'); assert.equal(monitor.snapshot().generation, 2);
});

test('initial unresponsive requests exhaust a bounded budget without overlapping normal polls', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); t.after(() => t.mock.timers.reset());
  const signals: AbortSignal[] = [];
  const monitor = new SecurityMonitor(required, (async (_url, init) => {
    signals.push(init?.signal as AbortSignal); return new Promise<Response>(() => {});
  }) as typeof fetch);
  const checking = monitor.check(); const page = documentForTest(); page.hidden = false;
  const stop = monitor.start(page); t.after(stop);
  t.mock.timers.tick(5_000); await flushPromises();
  t.mock.timers.tick(1_000); await flushPromises(); assert.equal(signals.length, 2);
  t.mock.timers.tick(4_000); await flushPromises(); assert.equal(signals.length, 2);
  assert.equal(monitor.snapshot().phase, 'checking');
  t.mock.timers.tick(1_000); await flushPromises();
  t.mock.timers.tick(2_000); await flushPromises(); assert.equal(signals.length, 3);
  t.mock.timers.tick(5_000);
  assert.equal(monitor.snapshot().phase, 'unavailable'); await checking;
  assert.ok(signals.every(signal => signal.aborted)); assert.throws(() => monitor.operation(true), ServiceSecurityError);
});

test('transient initial network and gateway failures recover with bounded retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => t.mock.timers.reset());
  for (const failure of ['network', 502, 503, 504] as const) {
    let calls = 0;
    const monitor = new SecurityMonitor(required, (async () => {
      if (++calls > 1) return status();
      if (failure === 'network') throw new Error('private network detail');
      return new Response('<html>Gateway warming up</html>', { status: failure });
    }) as typeof fetch);
    const checking = monitor.check(); await flushPromises();
    assert.equal(monitor.snapshot().phase, 'checking'); assert.throws(() => monitor.operation(), ServiceSecurityError);
    t.mock.timers.tick(1_000); await checking;
    assert.equal(calls, 2); assert.equal(monitor.snapshot().phase, 'open');
  }
});

test('initial unavailable status retries without admitting operations or forgetting its generation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => t.mock.timers.reset());
  for (const generation of [9, 10]) {
    let calls = 0;
    const monitor = new SecurityMonitor(required, (async () => ++calls === 1 ? status('unavailable', 10) : status('open', generation)) as typeof fetch);
    const checking = monitor.check(); await flushPromises();
    assert.deepEqual(monitor.snapshot(), { phase: 'checking', generation: null, version: 0 });
    assert.throws(() => monitor.operation(true), ServiceSecurityError);
    t.mock.timers.tick(1_000); await checking;
    assert.equal(calls, 2); assert.equal(monitor.snapshot().phase, generation === 10 ? 'open' : 'unavailable');
  }
});

test('locked, malformed and non-transient denied initial responses close immediately without retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => t.mock.timers.reset());
  for (const [response, phase] of [
    [status('locked', 2), 'locked'],
    [new Response('not json'), 'unavailable'],
    [Response.json({ schemaVersion: 1, state: 'open', generation: 0 }), 'unavailable'],
    [Response.json({ schemaVersion: 1, state: 'open', generation: 1 }, { status: 401 }), 'unavailable'],
    [Response.json({ schemaVersion: 1, state: 'unavailable', generation: 0 }, { status: 403 }), 'unavailable'],
    [new Response('x'.repeat(1_025), { status: 503 }), 'unavailable'],
  ] as const) {
    let calls = 0;
    const monitor = new SecurityMonitor(required, (async () => { calls++; return response; }) as typeof fetch);
    await monitor.check();
    assert.equal(monitor.snapshot().phase, phase);
    assert.throws(() => monitor.operation(), ServiceSecurityError);
    t.mock.timers.tick(30_000); await flushPromises(); assert.equal(calls, 1);
  }
});

test('stop, hide and API denials cancel a pending startup retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); t.after(() => t.mock.timers.reset());
  for (const cancel of ['stop', 'hide', 'denial'] as const) {
    let calls = 0;
    const monitor = new SecurityMonitor(required, (async () => { calls++; throw new Error('network'); }) as typeof fetch);
    const page = documentForTest(); page.hidden = false; const stop = monitor.start(page);
    await flushPromises(); assert.equal(calls, 1);
    if (cancel === 'stop') stop();
    else if (cancel === 'hide') { page.hidden = true; page.dispatchEvent(new Event('visibilitychange')); }
    else monitor.reportFailure('SERVICE_LOCKED');
    t.mock.timers.tick(3_000); await flushPromises();
    assert.equal(calls, 1); assert.equal(monitor.snapshot().phase, cancel === 'denial' ? 'locked' : 'checking');
    assert.throws(() => monitor.operation(true), ServiceSecurityError); stop();
    t.mock.timers.tick(30_000); await flushPromises(); assert.equal(calls, 1);
  }
});

test('stopping settles an aborted initial check even when fetch never settles', async () => {
  let signal: AbortSignal | undefined;
  const monitor = new SecurityMonitor(required, (async (_url, init) => {
    signal = init?.signal as AbortSignal; return new Promise<Response>(() => {});
  }) as typeof fetch);
  const checking = monitor.check(); const page = documentForTest(); page.hidden = false;
  const stop = monitor.start(page); stop(); await checking;
  assert.equal(signal?.aborted, true); assert.throws(() => monitor.operation(true), ServiceSecurityError);
});

test('post-open network failure revokes operations immediately without startup retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => t.mock.timers.reset());
  let calls = 0;
  const monitor = new SecurityMonitor(required, (async () => {
    if (++calls === 1) return status();
    throw new Error('network');
  }) as typeof fetch);
  await monitor.check(); const operation = monitor.operation();
  await monitor.check();
  assert.equal(monitor.snapshot().phase, 'unavailable'); assert.equal(operation.signal.aborted, true);
  t.mock.timers.tick(30_000); await flushPromises(); assert.equal(calls, 2);
});
