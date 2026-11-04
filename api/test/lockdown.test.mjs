import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { BlobSecurityGate, LockdownController, controlBlobUrl, productionSecurityGate, validateControl } from '../dist/api/src/lockdown.js';
import { alertConfig, alertVerifier, verifiedAlert } from '../dist/api/src/alerts.js';
import { createHandler, createControllerHandler, registerRoutes } from '../dist/api/src/functions.js';
import { ApiError } from '../dist/api/src/types.js';
import { fixture, errorIs } from './helpers.mjs';

const stamp = Date.now();
const initial = () => ({ schemaVersion: 1, locked: false, generation: 1, updatedAt: new Date(stamp - 1000).toISOString(), reason: 'initialization', incidentId: null, review: 'none', handledAlertHashes: [] });
function memoryControl(state = initial()) {
  let version = 1;
  return { state, broken: false, conflicts: 0,
    async read() { if (this.broken) throw new Error('private SDK detail'); return { state: structuredClone(this.state), etag: String(version) }; },
    async write(value, etag) { if (this.conflicts > 0) { this.conflicts--; return false; } if (etag !== String(version)) return false; this.state = structuredClone(value); version++; return true; },
  };
}
process.env.APP_ORIGIN = 'https://budget.example.test';
const request = (body = {}, token) => ({ method: 'POST', headers: new Headers({ origin: process.env.APP_ORIGIN, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }), body: new Response(JSON.stringify(body)).body });
const routes = ['parameters', 'register', 'login', 'logout', 'status', 'setup', 'unlock', 'lock', 'pin', 'erase', 'budget'];

test('private security control is strict; missing/invalid gate configuration cannot silently open', async () => {
  assert.deepEqual(await productionSecurityGate({}).status(), { schemaVersion: 1, state: 'open', generation: 0 });
  for (const value of ['TRUE', '1', '']) assert.throws(() => productionSecurityGate({ SECURITY_GATE_ENFORCED: value }), errorIs(503, 'SECURITY_STATE_UNAVAILABLE'));
  for (const url of ['http://validstore.blob.core.windows.net/service-control/lockdown.json', 'https://example.test/service-control/lockdown.json', 'https://validstore.blob.core.windows.net/service-control/lockdown.json?sig=secret', 'https://validstore.blob.core.windows.net/other/lockdown.json']) {
    assert.throws(() => controlBlobUrl(url), errorIs(503, 'SECURITY_STATE_UNAVAILABLE'));
  }
  for (const patch of [{ generation: 0 }, { generation: 1.5 }, { locked: 'false' }, { extra: true }, { handledAlertHashes: ['secret alert details'] }, { updatedAt: 'not-date' }]) {
    assert.throws(() => validateControl({ ...initial(), ...patch }), errorIs(503, 'SECURITY_STATE_UNAVAILABLE'));
  }
});

test('all budget/account endpoints deny locked and unverifiable security before parsing credentials or opening budget clients', async () => {
  const store = memoryControl({ ...initial(), locked: true }), gate = new BlobSecurityGate(store);
  let resolves = 0, reads = 0;
  const handler = createHandler(() => { resolves++; throw new Error('must not open database'); }, () => gate);
  for (const broken of [false, true]) {
    store.broken = broken;
    for (const route of routes) {
      const input = request(); Object.defineProperty(input, 'body', { get() { reads++; throw new Error('must not read credentials'); } });
      const response = await handler(input, route);
      assert.equal(response.status, 503, route);
      assert.equal(response.jsonBody.code, broken ? 'SECURITY_STATE_UNAVAILABLE' : 'SERVICE_LOCKED', route);
    }
  }
  assert.equal(resolves, 0); assert.equal(reads, 0);
});

test('late incident suppresses an admitted response and public status never exposes incident metadata', async () => {
  const store = memoryControl(), gate = new BlobSecurityGate(store);
  const handler = createHandler(() => ({ authentication: { async parameters() { store.state.locked = true; return { privateValue: 'must never return' }; } }, service: {} }), () => gate);
  const response = await handler(request({ username: 'synthetic' }), 'parameters');
  assert.deepEqual(response.jsonBody, { code: 'SERVICE_LOCKED' });
  assert.deepEqual(await gate.status(), { schemaVersion: 1, state: 'locked', generation: 1 });
  store.broken = true;
  assert.deepEqual(await gate.status(), { schemaVersion: 1, state: 'unavailable', generation: 0 });
});

test('recovery requires new login; original encrypted ledger and account credentials survive global incident', async () => {
  const f = await fixture(), before = await f.repository.read(f.identity.ownerId);
  const newLogin = await f.auth.login(f.credentials, 'synthetic-device', 3);
  await assert.rejects(f.auth.authenticate(new Headers({ authorization: `Bearer ${f.session.token}` }), 3), errorIs(401, 'AUTH_REQUIRED'));
  const current = await f.auth.authenticate(new Headers({ authorization: `Bearer ${newLogin.token}` }), 3);
  assert.equal(current.securityGeneration, 3);
  await assert.rejects(f.auth.authenticate(new Headers({ authorization: `Bearer ${newLogin.token}` }), 4), errorIs(401, 'AUTH_REQUIRED'));
  const after = await f.repository.read(f.identity.ownerId);
  assert.deepEqual(after.ledger, before.ledger); assert.deepEqual(after.access.credentials, before.access.credentials);
  assert.equal(after.access.sessions.length, 1);
  assert.equal(after.access.sessions[0].securityGeneration, 3);
  // Service's independent session validation also checks the generation.
  await assert.rejects(f.service.status({ ...current, securityGeneration: 4 }), errorIs(401, 'AUTH_REQUIRED'));
});

test('controller role exposes only independent status and alert routes, never budget routes or reopen', () => {
  const records = new Map();
  registerRoutes('security-controller', (name, value) => records.set(name, value));
  assert.deepEqual([...records.values()].map(v => v.route).sort(), ['security/alerts', 'service/status']);
  records.clear(); registerRoutes('budget-api', (name, value) => records.set(name, value));
  assert.equal(records.size, 11); assert.ok(![...records.values()].some(v => v.route.startsWith('security/')));
  assert.throws(() => registerRoutes('invalid-role', () => {}), /Invalid service role/);
});

test('control CAS retries, records hashed evidence, stops physically, and replay cannot reopen or relock after recovery', async () => {
  const store = memoryControl(); let stops = 0;
  store.conflicts = 1;
  const controller = new LockdownController(store, async () => { stops++; }, () => stamp);
  assert.deepEqual(await controller.trigger('/subscriptions/synthetic/alerts/1', stamp), { locked: true, duplicate: false });
  assert.equal(store.state.generation, 2); assert.equal(stops, 1);
  assert.equal(store.state.review, 'pending'); assert.equal(store.state.reason, 'verified-alert');
  assert.ok(!JSON.stringify(store.state).includes('/subscriptions/'));
  assert.deepEqual(await controller.trigger('/subscriptions/synthetic/alerts/1', stamp), { locked: true, duplicate: true });
  assert.equal(stops, 2); assert.equal(store.state.generation, 2);
  store.state = { ...store.state, locked: false, generation: 3, reason: 'recovery', review: 'false-positive', updatedAt: new Date(stamp + 1).toISOString(), handledAlertHashes: [] };
  // Even if an older hash was evicted, incident evidence predating explicit recovery cannot shut it down again.
  assert.deepEqual(await controller.trigger('/subscriptions/synthetic/alerts/1', stamp), { locked: false, duplicate: true });
  assert.equal(stops, 2); assert.equal(store.state.generation, 3);
  await controller.trigger('/subscriptions/synthetic/alerts/2', stamp + 2);
  assert.equal(stops, 3); assert.equal(store.state.generation, 4);
});

test('verified incident attempts physical stop even when control storage cannot be read or updated', async () => {
  for (const issue of ['read', 'conflicts', 'generation']) {
    const store = memoryControl(); let stops = 0;
    if (issue === 'read') store.broken = true;
    if (issue === 'conflicts') store.conflicts = 100;
    if (issue === 'generation') store.state.generation = Number.MAX_SAFE_INTEGER;
    const controller = new LockdownController(store, async () => { stops++; });
    await assert.rejects(controller.trigger('/subscriptions/synthetic/alerts/emergency'));
    assert.equal(stops, 1, issue);
  }
});

test('stopping failure keeps the private flag locked; redelivery retries physical stop', async () => {
  const store = memoryControl(); let stops = 0;
  const controller = new LockdownController(store, async () => { stops++; if (stops === 1) throw new ApiError(503, 'SECURITY_STOP_UNCONFIRMED'); });
  await assert.rejects(controller.trigger('/subscriptions/synthetic/alerts/retry'), errorIs(503, 'SECURITY_STOP_UNCONFIRMED'));
  assert.equal(store.state.locked, true);
  assert.deepEqual(await controller.trigger('/subscriptions/synthetic/alerts/retry'), { locked: true, duplicate: true });
  assert.equal(stops, 2);
});

const tenantId = '11111111-1111-1111-1111-111111111111';
const callerId = '22222222-2222-2222-2222-222222222222';
const target = `/subscriptions/${tenantId}/resourceGroups/synthetic/providers/Microsoft.Web/sites/budget-test`;
const env = { ALERT_AUTH_ISSUER: `https://login.microsoftonline.com/${tenantId}/v2.0`, ALERT_AUTH_AUDIENCE: 'api://synthetic-security', ALERT_AUTH_TENANT_ID: tenantId, ALERT_ALLOWED_CALLER_IDS: callerId, ALERT_ALLOWED_RULE_IDS: 'approved-security-rule', ALERT_ALLOWED_MONITORING_SERVICES: 'DedicatedSecurityAdapter', BUDGET_FUNCTION_RESOURCE_ID: target };
const config = alertConfig(env);
const alert = () => ({ schemaId: 'azureMonitorCommonAlertSchema', data: { essentials: { alertId: `/subscriptions/${tenantId}/providers/security/alerts/synthetic-one`, alertRule: 'approved-security-rule', monitoringService: 'DedicatedSecurityAdapter', severity: 'Sev1', monitorCondition: 'Fired', alertTargetIDs: [target], firedDateTime: new Date(stamp).toISOString() } } });

test('automation is disabled until exact trusted source, rule, resource, audience and tenant are configured', () => {
  for (const key of Object.keys(env)) assert.throws(() => alertConfig({ ...env, [key]: '' }));
  assert.throws(() => alertConfig({ ...env, ALERT_ALLOWED_CALLER_IDS: 'application-id-not-object-guid' }));
  assert.throws(() => alertConfig({ ...env, ALERT_AUTH_ISSUER: 'https://attacker.test' }));
});

test('only fresh active high alerts from exact approved security rule/source/target pass; resolved never recovers', () => {
  assert.equal(verifiedAlert(alert(), config, stamp).id, alert().data.essentials.alertId);
  for (const patch of [{ severity: 'Sev2' }, { severity: 'High' }, { monitorCondition: 'Resolved' }, { alertRule: 'different-rule' }, { monitoringService: 'GenericMetricService' }, { alertTargetIDs: [target, '/other'] }, { alertTargetIDs: [target + '-other'] }, { firedDateTime: new Date(stamp - 300_001).toISOString() }, { firedDateTime: new Date(stamp + 30_001).toISOString() }, { firedDateTime: 'invalid' }]) {
    const value = alert(); Object.assign(value.data.essentials, patch);
    assert.throws(() => verifiedAlert(value, config, stamp), errorIs(400, 'INVALID_SECURITY_ALERT'));
  }
  for (const value of [null, {}, [], { severity: 'High' }, { ...alert(), schemaId: 'other' }]) assert.throws(() => verifiedAlert(value, config, stamp));
});

test('RS256 alert JWT binds trusted tenant, issuer, audience, dedicated caller oid, app role and expiry', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'synthetic-signing-key', alg: 'RS256', use: 'sig' };
  const verify = alertVerifier(config, createLocalJWKSet({ keys: [jwk] }));
  const now = Math.floor(Date.now() / 1000);
  const token = async (claims = {}, header = {}) => new SignJWT({ tid: tenantId, oid: callerId, roles: ['Budget.Lockdown.Trigger'], iss: config.issuer, aud: config.audience, iat: now, nbf: now - 1, exp: now + 60, ...claims }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid, ...header }).sign(privateKey);
  await verify('Bearer ' + await token());
  for (const claim of [{ tid: 'untrusted' }, { oid: '33333333-3333-3333-3333-333333333333' }, { aud: 'wrong-audience' }, { iss: 'https://attacker.test' }, { roles: [] }, { exp: now - 60 }, { nbf: now + 60 }]) {
    await assert.rejects(verify('Bearer ' + await token(claim)), errorIs(401, 'ALERT_AUTH_REQUIRED'));
  }
  for (const input of [null, 'Bearer unverified-token', 'Basic x', 'Bearer ' + (await token()).slice(0, -8)]) await assert.rejects(verify(input), errorIs(401, 'ALERT_AUTH_REQUIRED'));
});

test('alert authentication happens before reading body or triggering denial; public status stays available during lock', async () => {
  const store = memoryControl({ ...initial(), locked: true }); let reads = 0, stops = 0;
  const handler = createControllerHandler(() => ({ gate: new BlobSecurityGate(store), controller: new LockdownController(store, async () => { stops++; }), alertConfig: () => config, verify: async () => { throw new ApiError(401, 'ALERT_AUTH_REQUIRED'); } }));
  const input = request(alert()); Object.defineProperty(input, 'body', { get() { reads++; throw new Error('must authenticate before reading credentials'); } });
  const denied = await handler(input, 'alerts');
  assert.equal(denied.status, 401); assert.equal(reads, 0); assert.equal(stops, 0);
  const status = await handler(request(), 'status');
  assert.deepEqual(status.jsonBody, { schemaVersion: 1, state: 'locked', generation: 1 });
  assert.equal(status.headers['Cache-Control'], 'no-store, private');
});
