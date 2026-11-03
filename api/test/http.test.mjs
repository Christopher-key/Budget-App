import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '@azure/functions';

// Capture the registered production handlers without starting the host or creating a database client.
const handlers = new Map();
const registration = app.http;
app.http = (name, options) => handlers.set(name, options.handler);
try { await import('../dist/api/src/functions.js'); }
finally { app.http = registration; }

const configuration = {
  AUTH_ISSUER: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0',
  AUTH_AUDIENCE: '22222222-2222-4222-8222-222222222222',
  AUTH_TENANT_ID: '11111111-1111-4111-8111-111111111111',
  AUTH_ALLOWED_CLIENT_IDS: '33333333-3333-4333-8333-333333333333',
};

test('every production route requires a strong signed identity before reading a body, PIN or database', async () => {
  const saved = Object.fromEntries(Object.keys(configuration).map(key => [key, process.env[key]]));
  Object.assign(process.env, configuration);
  try {
    assert.equal(handlers.size, 7);
    for (const handler of handlers.values()) {
      for (const authorization of [undefined, 'Bearer malformed.token']) {
        let reads = 0;
        const request = {
          method: 'POST',
          headers: new Headers(authorization ? { authorization } : {
            'x-ms-client-principal-id': 'client-selected-owner',
            'x-ms-client-principal': 'untrusted-header',
          }),
          async text() { reads++; throw new Error('Body must remain unread before identity verification'); },
        };
        const response = await handler(request);
        assert.equal(response.status, 401);
        assert.deepEqual(response.jsonBody, { code: 'AUTH_REQUIRED' });
        assert.equal(reads, 0);
        assert.equal(response.headers['Cache-Control'], 'no-store, private');
        assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
      }
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
