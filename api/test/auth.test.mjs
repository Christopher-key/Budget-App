import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { generateKeyPair, SignJWT } from 'jose';
import { authenticator, authenticationConfig } from '../dist/api/src/auth.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const audience = '20000000-0000-4000-8000-000000000002';
const clientId = '30000000-0000-4000-8000-000000000003';
const otherClientId = '30000000-0000-4000-8000-000000000004';
const objectId = '40000000-0000-4000-8000-000000000004';
const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
const environment = {
  AUTH_ISSUER: issuer,
  AUTH_AUDIENCE: audience,
  AUTH_TENANT_ID: tenantId,
  AUTH_ALLOWED_CLIENT_IDS: `${clientId}, ${otherClientId}`,
};
const config = authenticationConfig(environment);
const keys = await generateKeyPair('RS256');
const otherKeys = await generateKeyPair('RS256');
const verify = authenticator(config, async () => keys.publicKey);

function claims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: issuer, aud: audience, ver: '2.0', oid: objectId, tid: tenantId,
    azp: clientId, scp: 'openid Budget.Access', iat: now, exp: now + 600,
    ...overrides,
  };
}

async function signed(overrides = {}, signingKey = keys.privateKey) {
  return new SignJWT(claims(overrides)).setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).sign(signingKey);
}

function bearer(token, extra = {}) {
  return new Headers({ authorization: `Bearer ${token}`, ...extra });
}

function authRequired(error) {
  assert.equal(error.status, 401);
  assert.equal(error.code, 'AUTH_REQUIRED');
  assert.equal(error.message, 'AUTH_REQUIRED');
  return true;
}

test('authentication configuration requires pinned Microsoft issuer, tenant, API audience and client IDs', () => {
  assert.deepEqual(config, { issuer, audience, tenantId, allowedClientIds: [clientId, otherClientId] });
  assert.equal(authenticationConfig({ ...environment, AUTH_ISSUER: issuer + '/' }).issuer, issuer);
  assert.equal(authenticationConfig({ ...environment,
    AUTH_ISSUER: `https://example.ciamlogin.com/${tenantId}/v2.0`,
  }).tenantId, tenantId);

  const invalid = [
    {},
    { ...environment, AUTH_ISSUER: `http://login.microsoftonline.com/${tenantId}/v2.0` },
    { ...environment, AUTH_ISSUER: `https://login.microsoftonline.com.attacker.example/${tenantId}/v2.0` },
    { ...environment, AUTH_ISSUER: `https://ciamlogin.com.attacker.example/${tenantId}/v2.0` },
    { ...environment, AUTH_ISSUER: `https://user@login.microsoftonline.com/${tenantId}/v2.0` },
    { ...environment, AUTH_ISSUER: issuer + '?tenant=another' },
    { ...environment, AUTH_ISSUER: issuer + '#fragment' },
    { ...environment, AUTH_ISSUER: `https://login.microsoftonline.com/common/v2.0` },
    { ...environment, AUTH_ISSUER: `https://login.microsoftonline.com/${objectId}/v2.0` },
    { ...environment, AUTH_AUDIENCE: 'not-an-application-id' },
    { ...environment, AUTH_TENANT_ID: 'common' },
    { ...environment, AUTH_ALLOWED_CLIENT_IDS: '' },
    { ...environment, AUTH_ALLOWED_CLIENT_IDS: clientId + ',invalid' },
  ];
  for (const entry of invalid) assert.throws(() => authenticationConfig(entry));
});

test('a verified tenant and object ID determine the owner independently of subject, app or account headers', async () => {
  const first = await verify(bearer(await signed({ sub: 'first-subject', accountId: 'untrusted-first' })));
  const second = await verify(bearer(await signed({ sub: 'different-subject', accountId: 'untrusted-second', azp: otherClientId }), {
    'x-owner-id': 'untrusted-owner', 'x-account-id': 'untrusted-account',
    'x-ms-client-principal-id': 'untrusted-gateway-owner',
  }));
  const expected = createHash('sha256').update(issuer + '\0' + tenantId + '\0' + objectId).digest('base64url');
  assert.deepEqual(first, { ownerId: expected });
  assert.deepEqual(second, first);
  const other = await verify(bearer(await signed({ oid: '50000000-0000-4000-8000-000000000005' })));
  assert.notEqual(other.ownerId, first.ownerId);
});

test('gateway identity headers cannot replace a signed bearer token', async () => {
  let resolutions = 0;
  const guarded = authenticator(config, async () => { resolutions++; return keys.publicKey; });
  for (const headers of [
    new Headers(),
    new Headers({ 'x-ms-client-principal': 'untrusted', 'x-ms-client-principal-id': objectId }),
    new Headers({ authorization: 'Basic untrusted' }),
    new Headers({ authorization: 'Bearer malformed' }),
  ]) await assert.rejects(guarded(headers), authRequired);
  assert.equal(resolutions, 0);
});

test('JWT signature verification fails closed with a key that did not sign the access token', async () => {
  await assert.rejects(verify(bearer(await signed({}, otherKeys.privateKey))), authRequired);
});

test('JWT validation rejects incorrect issuer, audience, tenant, client, version and scopes', async t => {
  const cases = [
    ['issuer', { iss: 'https://attacker.example/issuer' }],
    ['API audience', { aud: otherClientId }],
    ['tenant', { tid: '50000000-0000-4000-8000-000000000005' }],
    ['unlisted client', { azp: '60000000-0000-4000-8000-000000000006' }],
    ['missing client', { azp: undefined }],
    ['object ID format', { oid: 'client-selected-owner' }],
    ['missing object ID', { oid: undefined }],
    ['token version', { ver: '1.0' }],
    ['missing scope', { scp: undefined }],
    ['different scope', { scp: 'openid Other.Access' }],
    ['scope substring', { scp: 'openid PrefixBudget.AccessSuffix' }],
    ['non-string scope', { scp: ['Budget.Access'] }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => assert.rejects(verify(bearer(await signed(overrides))), authRequired));
  }
});

test('JWT validation rejects expired, premature, over-age and missing lifetime claims', async t => {
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    ['expired', { iat: now - 120, exp: now - 60 }],
    ['not yet valid', { nbf: now + 60 }],
    ['future issued-at', { iat: now + 60 }],
    ['older than maximum age', { iat: now - 7300, exp: now + 600 }],
    ['missing expiry', { exp: undefined }],
    ['missing issued-at', { iat: undefined }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => assert.rejects(verify(bearer(await signed(overrides))), authRequired));
  }
});

test('only the pinned RS256 algorithm is accepted', async () => {
  const hmac = await new SignJWT(claims()).setProtectedHeader({ alg: 'HS256' }).sign(randomBytes(32));
  await assert.rejects(verify(bearer(hmac)), authRequired);
  const unsigned = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.'
    + Buffer.from(JSON.stringify(claims())).toString('base64url') + '.';
  await assert.rejects(verify(bearer(unsigned)), authRequired);
});

test('a key-resolution failure returns only the safe authentication error', async () => {
  const unavailable = authenticator(config, async () => { throw new Error('private upstream diagnostic'); });
  await assert.rejects(unavailable(bearer(await signed())), authRequired);
});
