import { PASSWORD_ITERATIONS, type AuthParameters, type AuthResponse } from '../../shared/cloud.js';
import { ApiError, type AccessRecord, type Identity, type Repository } from './types.js';
import { base64url, cipher, constantEqual, derive, digest, keyedHash, random,
  requireSession, serverSecret, verifier } from './security.js';

export interface AuthenticationConfig { lookupKey: string; pepper: string }
export function authenticationConfig(environment: NodeJS.ProcessEnv = process.env): AuthenticationConfig {
  return { lookupKey: serverSecret(environment.AUTH_LOOKUP_KEY), pepper: serverSecret(environment.AUTH_PEPPER) };
}
function username(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_DATA');
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized)) throw new ApiError(400, 'INVALID_DATA');
  return normalized;
}
function proof(value: unknown): asserts value is string {
  if (!base64url(value, 32)) throw new ApiError(400, 'INVALID_DATA');
}

/** App-owned identity. Never receives passwords or budget decryption keys. */
export class AuthenticationService {
  constructor(private readonly repository: Repository, private readonly config: AuthenticationConfig,
    private readonly now: () => number = Date.now) {}
  private owner(name: string) { return keyedHash(this.config.lookupKey, 'account', name); }
  private secret(value: string) { return keyedHash(this.config.pepper, 'proof', value); }
  private async rate(operation: 'parameters' | 'register' | 'login', name: string, source: string) {
    const policies = { parameters: [60, 60_000, 120], register: [5, 3_600_000, 10], login: [12, 900_000, 36] };
    const [accountLimit, window, networkLimit] = policies[operation];
    const sourceBucket = keyedHash(this.config.lookupKey, 'rate-source-' + operation, source);
    const accountBucket = keyedHash(this.config.lookupKey, 'rate-account-' + operation, name);
    if (!await this.repository.consumeRate(sourceBucket, networkLimit, window, this.now()) ||
        !await this.repository.consumeRate(accountBucket, accountLimit, window, this.now())) throw new ApiError(429, 'RATE_LIMITED');
    // Also bounds distributed requests with different usernames and source addresses.
    if (operation !== 'parameters' && !await this.repository.consumeRate('global-auth-work', 120, 60_000, this.now())) {
      throw new ApiError(429, 'RATE_LIMITED');
    }
  }
  async parameters(input: { username?: unknown }, source = 'unavailable'): Promise<AuthParameters> {
    const name = username(input.username); await this.rate('parameters', name, source);
    const ownerId = this.owner(name), snapshot = await this.repository.read(ownerId, false);
    return { accountId: ownerId, salt: snapshot.access?.credentials?.salt
      ?? keyedHash(this.config.lookupKey, 'unused-salt', name), iterations: PASSWORD_ITERATIONS };
  }
  private issue(access: AccessRecord): { access: AccessRecord; response: AuthResponse } {
    const secret = random(), token = access.ownerId + '.' + secret;
    const issuedAt = this.now(), expiresAt = issuedAt + 30 * 60_000;
    const sessions = (access.sessions ?? []).filter(session => session.expiresAt > issuedAt).slice(-15);
    sessions.push({ hash: digest(token), issuedAt, expiresAt });
    return { access: { ...access, sessions, version: access.version + 1 }, response: {
      token, expiresAt: new Date(expiresAt).toISOString(), accountId: access.ownerId,
      salt: access.credentials!.salt, wrappedKey: structuredClone(access.credentials!.wrappedKey),
    } };
  }
  async register(input: { username?: unknown; proof?: unknown; salt?: unknown; wrappedKey?: unknown },
    source = 'unavailable'): Promise<AuthResponse> {
    const name = username(input.username); proof(input.proof);
    if (!base64url(input.salt, 32)) throw new ApiError(400, 'INVALID_DATA');
    const wrappedKey = cipher(input.wrappedKey, true);
    await this.rate('register', name, source);
    const ownerId = this.owner(name), saved = await verifier(this.secret(input.proof));
    for (let retry = 0; retry < 32; retry++) {
      const snapshot = await this.repository.read(ownerId, false);
      if (snapshot.access && snapshot.access.state !== 'erased') throw new ApiError(409, 'ACCOUNT_UNAVAILABLE');
      const access: AccessRecord = { id: 'access', ownerId, state: 'new', epoch: (snapshot.access?.epoch ?? 0) + 1,
        version: (snapshot.access?.version ?? 0) + 1, revision: 0,
        credentials: { salt: input.salt, wrappedKey, verifier: saved }, sessions: [] };
      const issued = this.issue(access);
      if (await this.repository.commit(ownerId, snapshot.etag, issued.access, undefined)) return issued.response;
    }
    throw new ApiError(503, 'UNAVAILABLE');
  }
  async login(input: { username?: unknown; proof?: unknown }, source = 'unavailable'): Promise<AuthResponse> {
    const name = username(input.username); proof(input.proof); await this.rate('login', name, source);
    const ownerId = this.owner(name), original = await this.repository.read(ownerId, false);
    // Unknown accounts perform the same memory-hard operation; no fake auth succeeds.
    const saved = original.access?.credentials?.verifier;
    const candidate = await derive(this.secret(input.proof), saved?.salt ?? keyedHash(this.config.lookupKey, 'unused-verifier', name));
    if (!saved || !constantEqual(candidate, saved.hash) || original.access?.state === 'erased') throw new ApiError(401, 'INVALID_LOGIN');
    for (let retry = 0; retry < 32; retry++) {
      const snapshot = retry ? await this.repository.read(ownerId, false) : original;
      const access = snapshot.access;
      if (!access?.credentials || access.state === 'erased' ||
          !constantEqual(saved.hash, access.credentials.verifier.hash) ||
          !constantEqual(saved.salt, access.credentials.verifier.salt)) throw new ApiError(401, 'INVALID_LOGIN');
      const issued = this.issue(access);
      if (await this.repository.commit(ownerId, snapshot.etag, issued.access, undefined)) return issued.response;
    }
    throw new ApiError(503, 'UNAVAILABLE');
  }
  async authenticate(headers: Pick<Headers, 'get'>): Promise<Identity> {
    const match = /^Bearer ([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(headers.get('authorization') ?? '');
    if (!match || !base64url(match[1], 32) || !base64url(match[2], 32)) throw new ApiError(401, 'AUTH_REQUIRED');
    const ownerId = match[1], sessionHash = digest(match[1] + '.' + match[2]);
    const { access } = await this.repository.read(ownerId, false);
    requireSession(access, { ownerId, sessionHash }, this.now());
    return { ownerId, sessionHash };
  }
  async logout(identity: Identity): Promise<void> {
    for (let retry = 0; retry < 32; retry++) {
      const snapshot = await this.repository.read(identity.ownerId, false);
      const access = requireSession(snapshot.access, identity, this.now());
      const updated = { ...access, version: access.version + 1,
        sessions: access.sessions!.filter(session => !constantEqual(session.hash, identity.sessionHash)),
        grants: (access.grants ?? []).filter(grant => !constantEqual(grant.sessionHash, identity.sessionHash)) };
      if (await this.repository.commit(identity.ownerId, snapshot.etag, updated, undefined)) return;
    }
    throw new ApiError(503, 'UNAVAILABLE');
  }
}
