import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

function configure(api?: string, production = true) {
  const directory = mkdtempSync(join(tmpdir(), 'budget-config-test-'));
  mkdirSync(join(directory, 'scripts'));
  copyFileSync(new URL('../scripts/configure.mjs', import.meta.url), join(directory, 'scripts/configure.mjs'));
  const env = { ...process.env };
  delete env.VITE_API_BASE_URL;
  delete env.NODE_ENV;
  if (api !== undefined) env.VITE_API_BASE_URL = api;
  try {
    execFileSync(process.execPath, [join(directory, 'scripts/configure.mjs'), ...(production ? ['--production'] : [])], { env, stdio: 'pipe' });
    return {
      config: JSON.parse(readFileSync(join(directory, 'public/config.json'), 'utf8')),
      hosting: JSON.parse(readFileSync(join(directory, 'public/staticwebapp.config.json'), 'utf8')),
    };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('unconfigured hosting publishes no external identity or financial endpoint', () => {
  const { config, hosting } = configure();
  assert.deepEqual(config, { configured: false });
  assert.match(hosting.globalHeaders['Content-Security-Policy'], /connect-src 'self';/);
});

test('only the selected HTTPS service is allowed for data connections', () => {
  const { config, hosting } = configure('https://budget-api.example.test/');
  assert.deepEqual(config, { configured: true, apiBaseUrl: 'https://budget-api.example.test' });
  const policy = hosting.globalHeaders['Content-Security-Policy'];
  assert.match(policy, /connect-src 'self' https:\/\/budget-api\.example\.test;/);
  assert.doesNotMatch(policy, /microsoft|openai|google|unsafe-inline|\*/);
  assert.equal(hosting.globalHeaders['Cache-Control'], 'no-store');
});

test('production rejects HTTP, embedded credentials, paths and query strings', () => {
  for (const origin of ['http://127.0.0.1:7071', 'https://user:private-value@example.test', 'https://example.test/api', 'https://example.test/?secret=value', 'https://example.test/#value']) {
    assert.throws(() => configure(origin));
  }
  assert.equal(configure('http://127.0.0.1:7071', false).config.apiBaseUrl, 'http://127.0.0.1:7071');
});

test('a malformed public setting is rejected without echoing its contents', () => {
  assert.throws(() => configure('private-value invalid-url'), error => {
    assert.doesNotMatch(String((error as { stderr?: Buffer }).stderr), /private-value/);
    return true;
  });
});
