import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { ApiError } from './types.js';
import { budgetResourceId } from './lockdown.js';

const GUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export interface AlertConfig {
  issuer: string; audience: string; tenantId: string; callers: string[];
  rules: string[]; monitoringServices: string[]; budgetResourceId: string;
}
/** A dedicated security adapter identity is required; a shared Monitor principal is not sufficient. */
export function alertConfig(env: NodeJS.ProcessEnv = process.env): AlertConfig {
  const list = (value: string | undefined) => (value ?? '').split(',').map(v => v.trim()).filter(Boolean);
  const value: AlertConfig = { issuer: env.ALERT_AUTH_ISSUER ?? '', audience: env.ALERT_AUTH_AUDIENCE ?? '',
    tenantId: env.ALERT_AUTH_TENANT_ID ?? '', callers: list(env.ALERT_ALLOWED_CALLER_IDS),
    rules: list(env.ALERT_ALLOWED_RULE_IDS), monitoringServices: list(env.ALERT_ALLOWED_MONITORING_SERVICES),
    budgetResourceId: budgetResourceId(env.BUDGET_FUNCTION_RESOURCE_ID) };
  if (!GUID.test(value.tenantId) || !value.audience || value.audience.length > 512 ||
      ![`https://login.microsoftonline.com/${value.tenantId}/v2.0`, `https://sts.windows.net/${value.tenantId}/`].includes(value.issuer) ||
      !value.callers.length || value.callers.some(v => !GUID.test(v)) || value.callers.length > 8 ||
      !value.rules.length || value.rules.length > 16 || value.rules.some(v => v.length > 512) ||
      !value.monitoringServices.length || value.monitoringServices.length > 8 || value.monitoringServices.some(v => v.length > 128)) {
    throw new ApiError(503, 'ALERT_SOURCE_UNCONFIGURED');
  }
  return value;
}
export function alertVerifier(config: AlertConfig, keys?: JWTVerifyGetKey) {
  // Key location is constructed from the configured tenant on a fixed Microsoft host.
  // A token jku/x5u header never chooses a network destination.
  const key = keys ?? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`),
    { timeoutDuration: 5_000, cooldownDuration: 30_000 });
  return async (authorization: string | null): Promise<void> => {
    const match = /^Bearer ([A-Za-z0-9_.-]{1,16384})$/.exec(authorization ?? '');
    if (!match) throw new ApiError(401, 'ALERT_AUTH_REQUIRED');
    try {
      const { payload } = await jwtVerify(match[1], key, {
        algorithms: ['RS256'], issuer: config.issuer, audience: config.audience,
        requiredClaims: ['exp', 'iat', 'nbf', 'tid', 'oid', 'roles'], clockTolerance: 15, maxTokenAge: '1h',
      });
      if (payload.tid !== config.tenantId || typeof payload.oid !== 'string' ||
          !config.callers.map(v => v.toLowerCase()).includes(payload.oid.toLowerCase()) ||
          !Array.isArray(payload.roles) || !payload.roles.includes('Budget.Lockdown.Trigger')) throw new Error('Untrusted source');
    } catch { throw new ApiError(401, 'ALERT_AUTH_REQUIRED'); }
  };
}
export function verifiedAlert(value: unknown, config: AlertConfig, now = Date.now()): { id: string; firedAt: number } {
  const reject = (): never => { throw new ApiError(400, 'INVALID_SECURITY_ALERT'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject();
  const root = value as Record<string, unknown>;
  if (root.schemaId !== 'azureMonitorCommonAlertSchema' || !root.data || typeof root.data !== 'object' || Array.isArray(root.data)) return reject();
  const essentials = (root.data as Record<string, unknown>).essentials as Record<string, unknown> | null;
  if (!essentials || typeof essentials !== 'object' || Array.isArray(essentials)) return reject();
  const { alertId, alertRule, monitoringService, severity, monitorCondition, alertTargetIDs, firedDateTime } = essentials;
  if (typeof alertId !== 'string' || alertId.length > 2048 || !alertId.startsWith('/subscriptions/') ||
      typeof alertRule !== 'string' || !config.rules.includes(alertRule) ||
      typeof monitoringService !== 'string' || !config.monitoringServices.includes(monitoringService) ||
      !['Sev0', 'Sev1'].includes(String(severity)) || monitorCondition !== 'Fired' ||
      !Array.isArray(alertTargetIDs) || alertTargetIDs.length !== 1 || typeof alertTargetIDs[0] !== 'string' ||
      alertTargetIDs[0].toLowerCase() !== config.budgetResourceId.toLowerCase() ||
      typeof firedDateTime !== 'string' || firedDateTime.length > 40 || !firedDateTime.endsWith('Z')) return reject();
  const stamp = Date.parse(firedDateTime);
  if (!Number.isFinite(stamp) || stamp > now + 30_000 || now - stamp > 5 * 60_000) return reject();
  return { id: alertId, firedAt: stamp };
}
