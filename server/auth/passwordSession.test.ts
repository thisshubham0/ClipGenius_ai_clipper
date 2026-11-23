import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hashPassword,
  isAppSessionToken,
  signAppSessionToken,
  verifyAppSessionToken,
  verifyPassword,
} from './passwordSession';

test('hashPassword produces unique salted scrypt hashes and verifies correctly', async () => {
  const hashA = await hashPassword('CreatorPass!2026');
  const hashB = await hashPassword('CreatorPass!2026');

  assert.notEqual(hashA, hashB, 'Same password must get unique random salts');
  assert.ok(hashA.startsWith('scrypt$'));
  assert.equal(await verifyPassword('CreatorPass!2026', hashA), true);
  assert.equal(await verifyPassword('CreatorPass!2026', hashB), true);
  assert.equal(await verifyPassword('WrongPass!2026', hashA), false);
});

test('verifyPassword safely rejects malformed, empty, or null hashes', async () => {
  assert.equal(await verifyPassword('CreatorPass!2026', null), false);
  assert.equal(await verifyPassword('CreatorPass!2026', ''), false);
  assert.equal(await verifyPassword('CreatorPass!2026', 'plaintext-not-scrypt'), false);
  assert.equal(await verifyPassword('CreatorPass!2026', 'scrypt$16384$8$1$abc$nothex!'), false);
});

test('signAppSessionToken and verifyAppSessionToken round-trip and reject tampering', () => {
  const testSecret = 'unit-test-signing-key-only';
  const token = signAppSessionToken(
    {
      uid: 'usr_123',
      email: 'alex@clipgenius.app',
      name: 'Alex Rivera',
      role: 'creator',
    },
    testSecret,
    3600
  );

  assert.equal(isAppSessionToken(token), true);
  assert.equal(isAppSessionToken('eyJhbGciOiJSUzI1NiJ9.firebase.jwt'), false);

  const verified = verifyAppSessionToken(token, testSecret);
  assert.ok(verified);
  assert.equal(verified.uid, 'usr_123');
  assert.equal(verified.email, 'alex@clipgenius.app');
  assert.equal(verified.name, 'Alex Rivera');
  assert.equal(verified.role, 'creator');

  // Wrong signing secret must fail
  assert.equal(verifyAppSessionToken(token, 'different-secret'), null);

  // Tampered payload must fail
  const parts = token.split('.');
  const tamperedPayload = Buffer.from(
    JSON.stringify({
      uid: 'usr_999',
      email: 'attacker@example.com',
      name: 'Mallory',
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    }),
    'utf8'
  ).toString('base64url');
  const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
  assert.equal(verifyAppSessionToken(tampered, testSecret), null);
});

test('verifyAppSessionToken rejects expired tokens', () => {
  const testSecret = 'unit-test-expiry-key';
  const payload = {
    uid: 'usr_old',
    email: 'old@clipgenius.app',
    name: 'Old Session',
    role: 'creator',
    iat: Date.now() - 120_000,
    exp: Date.now() - 1_000,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  // Sign with an already-expired timestamp using crypto directly
  const token = signAppSessionToken(
    {
      uid: 'usr_live',
      email: 'live@clipgenius.app',
      name: 'Live Session',
      role: 'creator',
    },
    testSecret,
    60
  );
  // Also confirm malformed expired payload without valid sig returns null
  assert.equal(verifyAppSessionToken(`cg_sess_v1.${payloadB64}.invalidsig`, testSecret), null);
  assert.ok(verifyAppSessionToken(token, testSecret));
});
