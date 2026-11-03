import { randomBytes, randomUUID, createCipheriv } from 'node:crypto';
import { AuthenticationService } from '../dist/api/src/auth.js';
import { BudgetService } from '../dist/api/src/service.js';
import { MemoryRepository } from '../dist/api/src/repository.js';
import { ApiError } from '../dist/api/src/types.js';

export const now = Date.UTC(2026, 0, 15, 12);
export const config = { lookupKey: Buffer.alloc(32, 3).toString('base64url'), pepper: Buffer.alloc(32, 9).toString('base64url') };
export const pin = '2048';
export const proof = () => randomBytes(32).toString('base64url');
export const wrapped = () => ({ v: 1, iv: randomBytes(12).toString('base64url'), data: randomBytes(48).toString('base64url') });
export function encrypted(text = 'Synthetic private budget payroll 1234.56') {
  const iv = randomBytes(12), key = randomBytes(32), cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, iv: iv.toString('base64url'), data: data.toString('base64url') };
}
export const errorIs = (status, code) => error => error instanceof ApiError && error.status === status && error.code === code;
export const unlockInput = (value = '4096', attemptId = randomUUID()) => ({ pin: value, attemptId });
export async function fixture(repository = new MemoryRepository(), options = {}) {
  let time = now;
  const auth = new AuthenticationService(repository, config, () => time), service = new BudgetService(repository, () => time, config.pepper);
  const credentials = { username: options.username ?? 'synthetic-owner', proof: proof(), salt: proof(), wrappedKey: wrapped() };
  const session = await auth.register(credentials);
  const identity = await auth.authenticate(new Headers({ Authorization: 'Bearer ' + session.token }));
  let grant;
  if (options.setup !== false) {
    grant = await service.setup(identity, { pin, expectedEpoch: 1, startEmpty: true, payload: encrypted() });
  }
  return { repository, auth, service, identity, session, credentials, grant, setTime(value) { time = value; } };
}
