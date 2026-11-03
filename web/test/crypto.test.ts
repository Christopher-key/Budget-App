import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyLedger } from '../../shared/model.js';
import { createDataKey, decode, decryptLedger, encode, encryptLedger, passwordKeys, randomSalt, unwrapDataKey, validateBlob } from '../src/crypto.js';

const accountId = encode(new Uint8Array(32).fill(7));
const otherAccount = encode(new Uint8Array(32).fill(8));
const password = 'a long synthetic password';

test('slow password derivation is repeatable and wrapped data keys require the correct password and account', async () => {
  const salt = randomSalt();
  const first = await passwordKeys(password, salt), second = await passwordKeys(password, salt), wrong = await passwordKeys(password + 'x', salt);
  assert.equal(first.proof, second.proof); assert.notEqual(first.proof, wrong.proof);
  assert.equal(first.wrappingKey.extractable, false);
  const created = await createDataKey(first.wrappingKey, accountId);
  assert.equal(created.dataKey.extractable, false);
  assert.equal(decode(created.wrappedKey.data).length, 48);
  const unlocked = await unwrapDataKey(second.wrappingKey, created.wrappedKey, accountId);
  assert.equal(unlocked.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', unlocked));
  await assert.rejects(unwrapDataKey(wrong.wrappingKey, created.wrappedKey, accountId));
  await assert.rejects(unwrapDataKey(first.wrappingKey, created.wrappedKey, otherAccount));
});

test('fresh AES-GCM nonces hide ledger contents and authenticated context blocks replay across accounts and versions', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const ledger = emptyLedger(); ledger.months[0].periods[0].realistic.payroll = '5432.10';
  const first = await encryptLedger(key, accountId, 2, 4, ledger), second = await encryptLedger(key, accountId, 2, 4, ledger);
  assert.notEqual(first.iv, second.iv); assert.notEqual(first.data, second.data);
  assert.ok(!JSON.stringify(first).includes('5432.10')); assert.ok(!JSON.stringify(first).includes('payroll'));
  assert.deepEqual(await decryptLedger(key, accountId, 2, 4, first), ledger);
  await assert.rejects(decryptLedger(key, otherAccount, 2, 4, first));
  await assert.rejects(decryptLedger(key, accountId, 3, 4, first));
  await assert.rejects(decryptLedger(key, accountId, 2, 5, first));
  const tampered = { ...first, data: encode(Uint8Array.from(decode(first.data), (byte, i) => i === 0 ? byte ^ 1 : byte)) };
  await assert.rejects(decryptLedger(key, accountId, 2, 4, tampered));
});

test('invalid encryption schemas, noncanonical base64, oversized and short fields fail closed', () => {
  for (const invalid of ['', 'AA=', 'Zh', '!', 'A']) assert.throws(() => decode(invalid));
  const blob = { v: 1, iv: encode(new Uint8Array(12)), data: encode(new Uint8Array(16)) };
  assert.deepEqual(validateBlob(blob), blob);
  for (const invalid of [null, {}, { ...blob, v: 2 }, { ...blob, iv: encode(new Uint8Array(11)) }, { ...blob, data: encode(new Uint8Array(15)) }, { ...blob, plaintext: 'sensitive' }, { ...blob, data: 'A'.repeat(1_500_001) }]) assert.throws(() => validateBlob(invalid));
});
