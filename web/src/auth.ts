import type { AuthParameters, AuthResponse, RegistrationRequest } from '../../shared/cloud.js';
import { createDataKey, decode, normalizeUsername, PASSWORD_ITERATIONS, passwordKeys, randomSalt, unwrapDataKey, validateBlob, validatePassword } from './crypto.js';

export interface PublicConfig { configured: true; apiBaseUrl: string }
/** Never persist this object: both the opaque bearer and nonextractable key stay in memory. */
export interface AuthSession { accessToken: string; expiresAt: number; accountId: string; dataKey: CryptoKey }
export class AuthError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function validatePublicConfig(value: unknown): PublicConfig | null {
  if (!value || typeof value !== 'object') return null;
  const config = value as Partial<PublicConfig>;
  if (config.configured !== true || typeof config.apiBaseUrl !== 'string' || !config.apiBaseUrl) return null;
  try {
    const api = new URL(config.apiBaseUrl);
    if ((api.protocol !== 'https:' && !(['localhost', '127.0.0.1'].includes(api.hostname) && api.protocol === 'http:')) ||
        api.pathname !== '/' || api.username || api.password || api.search || api.hash) return null;
    return { configured: true, apiBaseUrl: api.origin };
  } catch { return null; }
}
function failure(code: string): AuthError {
  switch (code) {
  case 'AUTH_REQUIRED': case 'INVALID_CREDENTIALS': case 'INVALID_LOGIN': return new AuthError(code, 'The username or password is incorrect.');
  case 'ACCOUNT_UNAVAILABLE': case 'ACCOUNT_EXISTS': return new AuthError(code, 'That username is unavailable. Choose another username.');
  case 'RATE_LIMITED': return new AuthError(code, 'Too many attempts. Wait a few minutes before trying again.');
  case 'INVALID_DATA': return new AuthError(code, 'Check your username and password, then try again.');
  default: return new AuthError('UNAVAILABLE', 'The secure connection is unavailable. Please try again.');
  }
}
async function post<T>(config: PublicConfig, path: string, body: unknown, fetcher: typeof fetch): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(config.apiBaseUrl + '/api/auth/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      credentials: 'omit', cache: 'no-store', redirect: 'error',
    });
  } catch { throw failure('UNAVAILABLE'); }
  let value: unknown;
  try { value = await response.json(); } catch { throw failure('UNAVAILABLE'); }
  if (!response.ok) throw failure(value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' ? value.code : 'UNAVAILABLE');
  return value as T;
}
function parameters(value: unknown): AuthParameters {
  if (!value || typeof value !== 'object') throw failure('UNAVAILABLE');
  const result = value as AuthParameters;
  try {
    if (!/^[A-Za-z0-9_-]{43}$/.test(result.accountId) || decode(result.accountId, 32).length !== 32 ||
        typeof result.salt !== 'string' || decode(result.salt, 32).length !== 32 || result.iterations !== PASSWORD_ITERATIONS) throw failure('UNAVAILABLE');
  } catch { throw failure('UNAVAILABLE'); }
  return { accountId: result.accountId, salt: result.salt, iterations: PASSWORD_ITERATIONS };
}
function sessionResponse(value: unknown, expected: AuthParameters): AuthResponse {
  if (!value || typeof value !== 'object') throw failure('UNAVAILABLE');
  const result = value as AuthResponse;
  try {
    if (typeof result.token !== 'string' || !/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(result.token) ||
        !result.token.startsWith(expected.accountId + '.') || result.accountId !== expected.accountId || result.salt !== expected.salt ||
        typeof result.expiresAt !== 'string' || !Number.isFinite(Date.parse(result.expiresAt)) ||
        Date.parse(result.expiresAt) <= Date.now() || Date.parse(result.expiresAt) > Date.now() + 3_600_000) throw failure('UNAVAILABLE');
    const wrappedKey = validateBlob(result.wrappedKey, 48);
    if (decode(wrappedKey.data, 48).length !== 48) throw failure('UNAVAILABLE');
    return { token: result.token, accountId: result.accountId, salt: result.salt, expiresAt: result.expiresAt, wrappedKey };
  } catch { throw failure('UNAVAILABLE'); }
}
/** Passwords are processed locally; the server receives a separate, slow-derived login proof. */
export async function authenticate(config: PublicConfig, username: string, password: string, create = false,
  fetcher: typeof fetch = fetch.bind(globalThis)): Promise<AuthSession> {
  if (!validatePublicConfig(config)) throw failure('UNAVAILABLE');
  try { username = normalizeUsername(username); validatePassword(password); }
  catch (error) { throw new AuthError('INVALID_DATA', error instanceof Error ? error.message : 'Check your username and password.'); }
  const provided = parameters(await post<unknown>(config, 'parameters', { username }, fetcher));
  const expected = create ? { ...provided, salt: randomSalt() } : provided;
  const keys = await passwordKeys(password, expected.salt);
  let response: AuthResponse;
  if (create) {
    const { wrappedKey } = await createDataKey(keys.wrappingKey, expected.accountId);
    const request: RegistrationRequest = { username, proof: keys.proof, salt: expected.salt, wrappedKey };
    response = sessionResponse(await post<unknown>(config, 'register', request, fetcher), expected);
  } else {
    response = sessionResponse(await post<unknown>(config, 'login', { username, proof: keys.proof }, fetcher), expected);
  }
  try {
    const dataKey = await unwrapDataKey(keys.wrappingKey, response.wrappedKey, response.accountId);
    return { accessToken: response.token, expiresAt: Date.parse(response.expiresAt), accountId: response.accountId, dataKey };
  } catch { throw new AuthError('INVALID_ENCRYPTION', 'Your encrypted account could not be opened. No records have been changed.'); }
}
