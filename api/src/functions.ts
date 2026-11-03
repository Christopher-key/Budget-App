import { isIP } from 'node:net';
import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { UNLOCK_HEADER } from '../../shared/contracts.js';
import { AuthenticationService, authenticationConfig } from './auth.js';
import { productionRepository } from './repository.js';
import { BudgetService } from './service.js';
import { ApiError, type Repository } from './types.js';

const MAX_BODY = 1_600_000;
const headers = {
  'Cache-Control': 'no-store, private', Pragma: 'no-cache',
  'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin',
};
let repository: Repository | undefined;
let service: BudgetService | undefined;
let authentication: AuthenticationService | undefined;
function services() {
  repository ??= productionRepository();
  service ??= new BudgetService(repository);
  authentication ??= new AuthenticationService(repository, authenticationConfig());
  return { service, authentication };
}
function requireOrigin(request: HttpRequest) {
  const origin = request.headers.get('origin'), configured = process.env.APP_ORIGIN;
  if (!configured) throw new ApiError(503, 'UNAVAILABLE');
  const url = new URL(configured);
  const local = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.origin !== configured || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new ApiError(503, 'UNAVAILABLE');
  if ((origin !== null && origin !== configured) || (request.method !== 'GET' && origin !== configured)) throw new ApiError(403, 'ORIGIN_REJECTED');
}
async function body(request: HttpRequest, allowed: string[], max = MAX_BODY): Promise<Record<string, unknown>> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new ApiError(400, 'INVALID_DATA');
  const length = Number(request.headers.get('content-length') ?? 0);
  if (!Number.isFinite(length) || length < 0 || length > max) throw new ApiError(413, 'INVALID_DATA');
  let text: string;
  try { text = await request.text(); } catch { throw new ApiError(400, 'INVALID_DATA'); }
  if (Buffer.byteLength(text, 'utf8') > max) throw new ApiError(413, 'INVALID_DATA');
  let result: unknown;
  try { result = JSON.parse(text); } catch { throw new ApiError(400, 'INVALID_DATA'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || Object.keys(result).some(key => !allowed.includes(key))) throw new ApiError(400, 'INVALID_DATA');
  return result as Record<string, unknown>;
}
// Azure's hosting front-end appends the connection source. Never retain raw IPs.
// Missing/untrusted host metadata deliberately shares a restrictive fallback bucket.
function source(request: HttpRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (!forwarded || forwarded.length > 2048) return 'unavailable';
  const last = forwarded.split(',').at(-1)?.trim() ?? '';
  if (isIP(last)) return last.toLowerCase();
  const ipv4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(last)?.[1];
  if (ipv4 && isIP(ipv4) === 4) return ipv4;
  const ipv6 = /^\[([0-9a-fA-F:]+)\](?::\d{1,5})?$/.exec(last)?.[1];
  return ipv6 && isIP(ipv6) === 6 ? ipv6.toLowerCase() : 'unavailable';
}

export type Route = 'parameters' | 'register' | 'login' | 'logout' | 'status' | 'setup' | 'unlock' | 'lock' | 'pin' | 'erase' | 'budget';
export function createHandler(resolve: () => { authentication: AuthenticationService; service: BudgetService } = services) {
 return async function handle(request: HttpRequest, route: Route): Promise<HttpResponseInit> {
  try {
    requireOrigin(request);
    const publicRoute = ['parameters', 'register', 'login'].includes(route);
    // Reject malformed/missing credentials before opening database clients or bodies.
    if (!publicRoute && !/^Bearer [A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(request.headers.get('authorization') ?? '')) {
      throw new ApiError(401, 'AUTH_REQUIRED');
    }
    const { authentication, service } = resolve();
    let value: unknown;
    if (publicRoute) {
      switch (route) {
      case 'parameters': value = await authentication.parameters(await body(request, ['username'], 1024), source(request)); break;
      case 'register': value = await authentication.register(await body(request, ['username', 'proof', 'salt', 'wrappedKey'], 2048), source(request)); break;
      case 'login': value = await authentication.login(await body(request, ['username', 'proof'], 1024), source(request)); break;
      }
    } else {
      const identity = await authentication.authenticate(request.headers), token = request.headers.get(UNLOCK_HEADER) ?? undefined;
      switch (route) {
      case 'logout': await body(request, [], 1024); await authentication.logout(identity); value = { signedOut: true }; break;
      case 'status': value = await service.status(identity); break;
      case 'setup': value = await service.setup(identity, await body(request, ['pin', 'expectedEpoch', 'startEmpty', 'payload'])); break;
      case 'unlock': value = await service.unlock(identity, await body(request, ['pin', 'attemptId'], 1024)); break;
      case 'lock': await body(request, [], 1024); await service.lock(identity, token); value = { locked: true }; break;
      case 'pin': value = await service.changePin(identity, token, await body(request, ['newPin'], 1024)); break;
      case 'erase': value = await service.erase(identity, token, (await body(request, ['epoch'], 1024)).epoch); break;
      case 'budget': value = request.method === 'GET' ? await service.budget(identity, token)
        : await service.save(identity, token, await body(request, ['epoch', 'revision', 'payload'])); break;
      }
    }
    return { status: 200, headers, jsonBody: value };
  } catch (error) {
    // Never log request bodies, usernames, proofs, PINs, tokens, ciphertext or SDK diagnostics.
    const safe = error instanceof ApiError ? error : new ApiError(503, 'UNAVAILABLE');
    return { status: safe.status, headers: { ...headers, ...(safe.status === 429 ? { 'Retry-After': '60' } : {}) },
      jsonBody: { code: safe.code, ...(safe.epoch !== undefined ? { epoch: safe.epoch } : {}) } };
  }
}
}
const handle = createHandler();
for (const [name, route, methods, operation] of [
  ['authParameters', 'auth/parameters', ['POST'], 'parameters'],
  ['authRegister', 'auth/register', ['POST'], 'register'],
  ['authLogin', 'auth/login', ['POST'], 'login'],
  ['authLogout', 'auth/logout', ['POST'], 'logout'],
  ['accountStatus', 'account/status', ['GET'], 'status'],
  ['accountSetup', 'account/setup', ['POST'], 'setup'],
  ['accountUnlock', 'account/unlock', ['POST'], 'unlock'],
  ['accountLock', 'account/lock', ['POST'], 'lock'],
  ['accountPin', 'account/pin', ['POST'], 'pin'],
  ['accountErase', 'account', ['DELETE'], 'erase'],
  ['budgetData', 'budget', ['GET', 'PUT'], 'budget'],
] as const) {
  app.http(name, { route, methods: [...methods], authLevel: 'anonymous', handler: request => handle(request, operation) });
}
