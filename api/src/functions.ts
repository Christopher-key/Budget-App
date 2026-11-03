import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { UNLOCK_HEADER, type SaveBudgetRequest } from '../../shared/contracts.js';
import { authenticator, authenticationConfig } from './auth.js';
import { productionRepository } from './repository.js';
import { BudgetService } from './service.js';
import { ApiError } from './types.js';

const MAX_BODY = 1024 * 1024;
const headers = {
  'Cache-Control': 'no-store, private', 'Pragma': 'no-cache',
  'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
};
let service: BudgetService | undefined;
let verify: ReturnType<typeof authenticator> | undefined;

async function body(request: HttpRequest, allowed: string[]): Promise<Record<string, unknown>> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new ApiError(400, 'INVALID_DATA');
  const length = Number(request.headers.get('content-length') ?? 0);
  if (!Number.isFinite(length) || length > MAX_BODY) throw new ApiError(413, 'INVALID_DATA');
  let text: string;
  try { text = await request.text(); } catch { throw new ApiError(400, 'INVALID_DATA'); }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY) throw new ApiError(413, 'INVALID_DATA');
  let result: unknown;
  try { result = JSON.parse(text); } catch { throw new ApiError(400, 'INVALID_DATA'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || Object.keys(result).some(key => !allowed.includes(key))) throw new ApiError(400, 'INVALID_DATA');
  return result as Record<string, unknown>;
}

type Route = 'status' | 'setup' | 'unlock' | 'lock' | 'pin' | 'erase' | 'budget';
async function handle(request: HttpRequest, route: Route): Promise<HttpResponseInit> {
  try {
    verify ??= authenticator(authenticationConfig());
    const { ownerId } = await verify(request.headers);
    service ??= new BudgetService(productionRepository());
    const token = request.headers.get(UNLOCK_HEADER) ?? undefined;
    let value: unknown;
    switch (route) {
    case 'status': value = await service.status(ownerId); break;
    case 'setup': value = await service.setup(ownerId, await body(request, ['pin', 'expectedEpoch', 'startEmpty'])); break;
    case 'unlock': value = await service.unlock(ownerId, await body(request, ['pin', 'attemptId'])); break;
    case 'lock': await service.lock(ownerId, token); return { status: 204, headers };
    case 'pin': value = await service.changePin(ownerId, token, await body(request, ['newPin'])); break;
    case 'erase': value = await service.erase(ownerId, (await body(request, ['epoch'])).epoch); break;
    case 'budget':
      value = request.method === 'GET'
        ? await service.budget(ownerId, token)
        : await service.save(ownerId, token, await body(request, ['epoch', 'revision', 'ledger']) as unknown as SaveBudgetRequest);
      break;
    }
    return { status: 200, headers, jsonBody: value };
  } catch (error) {
    // Never log a request, token, PIN, record, or SDK diagnostic/error message.
    const safe = error instanceof ApiError ? error : new ApiError(503, 'UNAVAILABLE');
    return { status: safe.status, headers, jsonBody: { code: safe.code, ...(safe.epoch !== undefined ? { epoch: safe.epoch } : {}) } };
  }
}

for (const [name, route, methods, operation] of [
  ['accountStatus', 'account/status', ['GET'], 'status'],
  ['accountSetup', 'account/setup', ['POST'], 'setup'],
  ['accountUnlock', 'account/unlock', ['POST'], 'unlock'],
  ['accountLock', 'account/lock', ['POST'], 'lock'],
  ['accountPin', 'account/pin', ['POST'], 'pin'],
  ['accountErase', 'account', ['DELETE'], 'erase'],
  ['budgetData', 'budget', ['GET', 'PUT'], 'budget'],
] as const) {
  app.http(name, { route, methods: [...methods], authLevel: 'anonymous',
    handler: request => handle(request, operation) });
}
