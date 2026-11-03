export interface PublicConfig {
  configured: true; clientId: string; authority: string; scope: string; apiBaseUrl: string;
}
export interface AuthSession { accessToken: string; expiresAt: number }
export interface TransientStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const PKCE_KEY = 'budget.oauth.pkce';
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function validatePublicConfig(value: unknown): PublicConfig | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Partial<PublicConfig>;
  if (c.configured !== true || !c.clientId || !c.authority || !c.scope || !c.apiBaseUrl) return null;
  try {
    const authority = new URL(c.authority), api = new URL(c.apiBaseUrl);
    if (authority.protocol !== 'https:' || !(authority.hostname === 'login.microsoftonline.com' || authority.hostname.endsWith('.ciamlogin.com')) ||
      authority.username || authority.password || authority.search || authority.hash ||
      !/^api:\/\/[0-9a-f-]{36}\/Budget\.Access$/i.test(c.scope) || !/^[0-9a-f-]{36}$/i.test(c.clientId) ||
      (api.protocol !== 'https:' && !(['localhost', '127.0.0.1'].includes(api.hostname) && api.protocol === 'http:')) || api.pathname !== '/' || api.username || api.password || api.search || api.hash) return null;
    return { ...c, authority: c.authority.replace(/\/$/, ''), apiBaseUrl: c.apiBaseUrl.replace(/\/$/, '') } as PublicConfig;
  } catch { return null; }
}
export async function authorizationURL(config: PublicConfig, redirectUri: string,
  storage: TransientStorage, cryptoAPI: Crypto = crypto): Promise<string> {
  const verifier = encode(cryptoAPI.getRandomValues(new Uint8Array(64)));
  const state = encode(cryptoAPI.getRandomValues(new Uint8Array(32)));
  const challenge = encode(new Uint8Array(await cryptoAPI.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  storage.setItem(PKCE_KEY, JSON.stringify({ state, verifier, redirectUri, createdAt: Date.now() }));
  const url = new URL(config.authority + '/oauth2/v2.0/authorize');
  url.search = new URLSearchParams({ client_id: config.clientId, response_type: 'code', response_mode: 'query',
    redirect_uri: redirectUri, scope: config.scope, state, code_challenge: challenge,
    code_challenge_method: 'S256', prompt: 'select_account' }).toString();
  return url.href;
}
export function consumePKCE(storage: TransientStorage, state: string, redirectUri: string) {
  const text = storage.getItem(PKCE_KEY);
  storage.removeItem(PKCE_KEY);
  if (!text) throw new Error('Sign-in expired. Please sign in again.');
  let entry: { state?: string; verifier?: string; redirectUri?: string; createdAt?: number };
  try { entry = JSON.parse(text); } catch { throw new Error('Sign-in could not be verified.'); }
  if (!entry || typeof entry !== 'object' || entry.state !== state || entry.redirectUri !== redirectUri ||
      typeof entry.verifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(entry.verifier) ||
      !Number.isSafeInteger(entry.createdAt) || !entry.createdAt || Date.now() - entry.createdAt > 600_000 || entry.createdAt > Date.now() + 30_000) {
    throw new Error('Sign-in could not be verified.');
  }
  return entry.verifier;
}
export async function completeSignIn(config: PublicConfig, search: string, redirectUri: string,
  storage: TransientStorage, fetcher: typeof fetch = fetch): Promise<AuthSession | null> {
  const query = new URLSearchParams(search);
  if (!query.has('code') && !query.has('error')) return null;
  if (query.getAll('code').length > 1 || query.getAll('state').length > 1 || query.getAll('error').length > 1) {
    storage.removeItem(PKCE_KEY); throw new Error('Sign-in could not be verified.');
  }
  if (query.has('error')) { storage.removeItem(PKCE_KEY); throw new Error('Microsoft sign-in was not completed.'); }
  const code = query.get('code'), state = query.get('state');
  if (!code || !state) { storage.removeItem(PKCE_KEY); throw new Error('Sign-in could not be verified.'); }
  const verifier = consumePKCE(storage, state, redirectUri);
  const response = await fetcher(config.authority + '/oauth2/v2.0/token', {
    method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, grant_type: 'authorization_code', code,
      code_verifier: verifier, redirect_uri: redirectUri, scope: config.scope })
  });
  if (!response.ok) throw new Error('Microsoft sign-in could not be completed.');
  const result = await response.json();
  if (!result || typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 15) throw new Error('The sign-in response was invalid.');
  // Ignore ID/refresh tokens. Only an API access token is held in this page's memory.
  return { accessToken: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 - 15_000 };
}
