import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { MAX_CIPHERTEXT_LENGTH, type CipherBlob } from '../../shared/cloud.js';
import { ApiError, type AccessRecord, type Identity, type Verifier } from './types.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
export const random = () => randomBytes(32).toString('base64url');
export function constantEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function base64url(value: unknown, size?: number): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value && (size === undefined || bytes.length === size);
}
export function cipher(value: unknown, wrapped = false): CipherBlob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'INVALID_DATA');
  const blob = value as Partial<CipherBlob>;
  if (Object.keys(blob).sort().join(',') !== 'data,iv,v' || blob.v !== 1 || !base64url(blob.iv, 12)
      || typeof blob.data !== 'string' || blob.data.length > (wrapped ? 64 : MAX_CIPHERTEXT_LENGTH)
      || !base64url(blob.data, wrapped ? 48 : undefined) || Buffer.from(blob.data, 'base64url').length < 16) {
    throw new ApiError(400, 'INVALID_DATA');
  }
  return { v: 1, iv: blob.iv, data: blob.data };
}
export function counter(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ApiError(400, 'INVALID_DATA');
}
export function requireSession(access: AccessRecord | null, identity: Identity, now: number): AccessRecord {
  if (!access || access.ownerId !== identity.ownerId || access.state === 'erased' ||
      !access.credentials || !access.sessions?.some(session => constantEqual(session.hash, identity.sessionHash)
        && session.expiresAt > now && session.issuedAt <= now + 30_000
        && (session.securityGeneration ?? 0) === (identity.securityGeneration ?? 0))) throw new ApiError(401, 'AUTH_REQUIRED');
  return access;
}
export function serverSecret(value: string | undefined): string {
  if (!base64url(value, 32)) throw new Error('Missing server credential configuration');
  return value;
}
export const keyedHash = (key: string, purpose: string, value: string) =>
  createHmac('sha256', Buffer.from(key, 'base64url')).update(purpose + '\0' + value).digest('base64url');

// Memory-hard proof hashing and a small per-process work cap bound expensive work.
// Persistent account/network buckets provide the cross-instance limit.
let expensive = 0;
export async function derive(value: string, salt: string): Promise<string> {
  if (expensive >= 2) throw new ApiError(429, 'RATE_LIMITED');
  expensive++;
  try {
    return await new Promise<string>((resolve, reject) => scrypt(value, Buffer.from(salt, 'base64url'), 32,
      { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }, (error, result) =>
        error ? reject(error) : resolve(result.toString('base64url'))));
  } finally { expensive--; }
}
export async function verifier(value: string): Promise<Verifier> {
  const salt = random();
  return { salt, hash: await derive(value, salt) };
}
