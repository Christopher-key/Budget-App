import assert from 'node:assert/strict';
import test from 'node:test';
import { SecurityMonitor, ServiceSecurityError, validateServiceStatus } from '../src/security.js';

const required = { securityGateRequired: true, securityStatusUrl: 'https://security.example.test/api/service/status' };
const documentForTest = () => new EventTarget() as EventTarget & { hidden: boolean };
const status = (state = 'open', generation = 1) => Response.json({ schemaVersion: 1, state, generation });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

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
  const failure = new SecurityMonitor(required, (async () => { throw new Error('private diagnostics'); }) as typeof fetch);
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
