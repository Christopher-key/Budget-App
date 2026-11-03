import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { ApiError, type Identity } from './types.js';

export interface AuthenticationConfig {
  issuer: string; audience: string; tenantId: string; allowedClientIds: string[];
}
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function authenticationConfig(environment: NodeJS.ProcessEnv = process.env): AuthenticationConfig {
  const issuer = environment.AUTH_ISSUER?.replace(/\/$/, '');
  const audience = environment.AUTH_AUDIENCE;
  const tenantId = environment.AUTH_TENANT_ID?.toLowerCase();
  const allowedClientIds = (environment.AUTH_ALLOWED_CLIENT_IDS ?? '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  if (!issuer || !audience || !tenantId || !guid.test(audience) || !guid.test(tenantId)
      || !allowedClientIds.length || allowedClientIds.some(v => !guid.test(v))) throw new Error('Invalid authentication configuration');
  const url = new URL(issuer);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || !(url.hostname === 'login.microsoftonline.com' || url.hostname.endsWith('.ciamlogin.com'))
      || url.pathname.toLowerCase() !== `/${tenantId}/v2.0`) throw new Error('Invalid issuer');
  return { issuer, audience, tenantId, allowedClientIds };
}

/** Entra validates the owner. No client-selected account IDs or gateway-header trust. */
export function authenticator(config: AuthenticationConfig, keyResolver?: JWTVerifyGetKey) {
  const keys = keyResolver ?? createRemoteJWKSet(new URL(
    config.issuer.replace(/\/v2\.0$/, '') + '/discovery/v2.0/keys'), { timeoutDuration: 5000 });
  return async (headers: Pick<Headers, 'get'>): Promise<Identity> => {
    const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(headers.get('authorization') ?? '');
    if (!match) throw new ApiError(401, 'AUTH_REQUIRED');
    try {
      const { payload } = await jwtVerify(match[1], keys, {
        issuer: config.issuer, audience: config.audience, algorithms: ['RS256'], clockTolerance: 5,
        requiredClaims: ['exp', 'iat', 'oid', 'tid', 'azp', 'scp'], maxTokenAge: '2h',
      });
      if (payload.ver !== '2.0' || typeof payload.oid !== 'string' || !guid.test(payload.oid)
          || typeof payload.tid !== 'string' || payload.tid.toLowerCase() !== config.tenantId
          || typeof payload.azp !== 'string' || !config.allowedClientIds.includes(payload.azp.toLowerCase())
          || typeof payload.scp !== 'string' || !payload.scp.split(' ').includes('Budget.Access')) throw new Error('Invalid access');
      return { ownerId: createHash('sha256')
        .update(config.issuer + '\0' + payload.tid.toLowerCase() + '\0' + payload.oid.toLowerCase()).digest('base64url') };
    } catch { throw new ApiError(401, 'AUTH_REQUIRED'); }
  };
}
