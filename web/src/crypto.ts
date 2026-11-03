import type { Ledger } from '../../shared/contracts.js';
import { PASSWORD_ITERATIONS, keyContext, ledgerContext, type CipherBlob } from '../../shared/cloud.js';
export { PASSWORD_ITERATIONS, type CipherBlob } from '../../shared/cloud.js';
import { validateLedger } from '../../shared/model.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_CIPHERTEXT_BYTES = 1_048_592;

export function encode(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decode(value: string, maximum = MAX_CIPHERTEXT_BYTES): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(maximum * 4 / 3)) throw new Error('Invalid encrypted data.');
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
  if (bytes.length > maximum || encode(bytes) !== value) throw new Error('Invalid encrypted data.');
  return bytes;
}
export function validateBlob(value: unknown, maximum = MAX_CIPHERTEXT_BYTES): CipherBlob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid encrypted data.');
  const blob = value as Partial<CipherBlob>;
  if (Object.keys(blob).sort().join(',') !== 'data,iv,v' || blob.v !== 1 || typeof blob.iv !== 'string' || typeof blob.data !== 'string') throw new Error('Invalid encrypted data.');
  if (decode(blob.iv, 12).length !== 12 || decode(blob.data, maximum).length < 16) throw new Error('Invalid encrypted data.');
  return { v: 1, iv: blob.iv, data: blob.data };
}
function secureCrypto(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) throw new Error('Use this app over HTTPS in a supported browser.');
  return globalThis.crypto;
}
export function randomSalt(): string { return encode(secureCrypto().getRandomValues(new Uint8Array(32))); }
export function normalizeUsername(value: string): string {
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) throw new Error('Use 3–64 letters, numbers, dots, underscores, or hyphens for your username.');
  return username;
}
export function validatePassword(value: string): void {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128 || encoder.encode(value).length > 512) throw new Error('Use a password between 12 and 128 characters.');
}
export async function passwordKeys(password: string, salt: string): Promise<{ proof: string; wrappingKey: CryptoKey }> {
  validatePassword(password);
  const saltBytes = decode(salt, 32);
  if (saltBytes.length !== 32) throw new Error('Invalid account encryption settings.');
  const api = secureCrypto();
  const passwordBytes = encoder.encode(password);
  let root: Uint8Array<ArrayBuffer> | undefined;
  let proofBytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    const material = await api.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveBits']);
    root = new Uint8Array(await api.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: PASSWORD_ITERATIONS }, material, 256));
    const hkdf = await api.subtle.importKey('raw', root, 'HKDF', false, ['deriveBits', 'deriveKey']);
    const empty = new Uint8Array(0);
    proofBytes = new Uint8Array(await api.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: empty, info: encoder.encode('budget-auth-proof:v1') }, hkdf, 256));
    const wrappingKey = await api.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: empty, info: encoder.encode('budget-key-wrapping:v1') }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return { proof: encode(proofBytes), wrappingKey };
  } finally { passwordBytes.fill(0); root?.fill(0); proofBytes?.fill(0); saltBytes.fill(0); }
}
function context(accountId: string, purpose: 'key' | 'ledger', epoch?: number, revision?: number): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(accountId)) throw new Error('Invalid account identity.');
  if (purpose === 'key') return encoder.encode(keyContext(accountId));
  if (!Number.isSafeInteger(epoch) || Number(epoch) < 0 || !Number.isSafeInteger(revision) || Number(revision) < 0) throw new Error('Invalid budget version.');
  return encoder.encode(ledgerContext(accountId, epoch!, revision!));
}
function seal(key: CryptoKey, plaintext: Uint8Array<ArrayBuffer>, aad: Uint8Array<ArrayBuffer>): Promise<CipherBlob> {
  const api = secureCrypto(), iv = api.getRandomValues(new Uint8Array(12));
  // Web Crypto copies BufferSource inputs when encrypt() is called. Drop our
  // mutable plaintext immediately; only the native operation retains its copy.
  const encryption = api.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext);
  return encryption.then(encrypted => ({ v: 1, iv: encode(iv), data: encode(new Uint8Array(encrypted)) }));
}
async function unseal(key: CryptoKey, value: unknown, aad: Uint8Array<ArrayBuffer>, maximum = MAX_CIPHERTEXT_BYTES): Promise<Uint8Array<ArrayBuffer>> {
  const blob = validateBlob(value, maximum);
  return new Uint8Array(await secureCrypto().subtle.decrypt({ name: 'AES-GCM', iv: decode(blob.iv, 12), additionalData: aad, tagLength: 128 }, key, decode(blob.data, maximum)));
}
export async function createDataKey(wrappingKey: CryptoKey, accountId: string): Promise<{ dataKey: CryptoKey; wrappedKey: CipherBlob }> {
  const api = secureCrypto(), raw = api.getRandomValues(new Uint8Array(32));
  try {
    const dataKey = await api.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const wrappedKey = await seal(wrappingKey, raw, context(accountId, 'key'));
    return { dataKey, wrappedKey };
  } finally { raw.fill(0); }
}
export async function unwrapDataKey(wrappingKey: CryptoKey, value: unknown, accountId: string): Promise<CryptoKey> {
  const raw = await unseal(wrappingKey, value, context(accountId, 'key'), 48);
  try {
    if (raw.length !== 32) throw new Error('Invalid encrypted account key.');
    return await secureCrypto().subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } finally { raw.fill(0); }
}
export function encryptLedger(key: CryptoKey, accountId: string, epoch: number, revision: number, ledger: Ledger): Promise<CipherBlob> {
  const bytes = encoder.encode(JSON.stringify(validateLedger(ledger)));
  try {
    if (bytes.length > 1_048_576) throw new Error('This budget is too large to sync.');
    return seal(key, bytes, context(accountId, 'ledger', epoch, revision));
  } finally { bytes.fill(0); }
}
export async function decryptLedger(key: CryptoKey, accountId: string, epoch: number, revision: number, value: unknown): Promise<Ledger> {
  const raw = await unseal(key, value, context(accountId, 'ledger', epoch, revision));
  try { return validateLedger(JSON.parse(decoder.decode(raw))); }
  finally { raw.fill(0); }
}
