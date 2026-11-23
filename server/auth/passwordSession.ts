import crypto from 'node:crypto';

export const APP_SESSION_TOKEN_PREFIX = 'cg_sess_v1.';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const DEFAULT_SESSION_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

const EPHEMERAL_RUNTIME_SECRET = crypto.randomBytes(32);

export interface AppSessionClaims {
  uid: string;
  email: string;
  name: string;
  role: 'creator' | 'admin';
}

export interface VerifiedAppSession extends AppSessionClaims {
  iat: number;
  exp: number;
}

function resolveSigningSecret(overrideSecret?: string): Buffer {
  const configured =
    overrideSecret ??
    process.env.SESSION_SIGNING_SECRET ??
    process.env.MEDIA_SIGNING_SECRET;
  if (configured && configured.trim().length > 0) {
    return crypto.createHash('sha256').update(configured.trim()).digest();
  }
  return EPHEMERAL_RUNTIME_SECRET;
}

function deriveScryptKey(
  password: string,
  saltHex: string,
  keyLen: number,
  N: number,
  r: number,
  p: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      saltHex,
      keyLen,
      { N, r, p, maxmem: 64 * 1024 * 1024 },
      (err, derivedKey) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(derivedKey);
      }
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  const saltHex = crypto.randomBytes(16).toString('hex');
  const derived = await deriveScryptKey(
    password,
    saltHex,
    SCRYPT_KEYLEN,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P
  );
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${saltHex}$${derived.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  storedHash: string | null | undefined
): Promise<boolean> {
  if (!password || !storedHash) {
    return false;
  }

  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4];
  const expectedHex = parts[5];

  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N < 1024 ||
    r < 1 ||
    p < 1 ||
    !saltHex ||
    !expectedHex ||
    expectedHex.length % 2 !== 0
  ) {
    return false;
  }

  let expectedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expectedHex, 'hex');
  } catch {
    return false;
  }

  if (expectedBuf.length === 0) {
    return false;
  }

  try {
    const derived = await deriveScryptKey(password, saltHex, expectedBuf.length, N, r, p);
    if (derived.length !== expectedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(derived, expectedBuf);
  } catch {
    return false;
  }
}

export function isAppSessionToken(token: string): boolean {
  return token.startsWith(APP_SESSION_TOKEN_PREFIX);
}

export function signAppSessionToken(
  claims: AppSessionClaims,
  secret?: string,
  ttlSec: number = DEFAULT_SESSION_TTL_SEC
): string {
  const now = Date.now();
  const payload: VerifiedAppSession = {
    uid: claims.uid,
    email: claims.email,
    name: claims.name,
    role: claims.role === 'admin' ? 'admin' : 'creator',
    iat: now,
    exp: now + Math.max(60, ttlSec) * 1000,
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `${APP_SESSION_TOKEN_PREFIX}${payloadB64}`;
  const sigB64 = crypto
    .createHmac('sha256', resolveSigningSecret(secret))
    .update(signingInput)
    .digest('base64url');

  return `${signingInput}.${sigB64}`;
}

export function verifyAppSessionToken(
  token: string,
  secret?: string
): VerifiedAppSession | null {
  if (!token || !isAppSessionToken(token)) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'cg_sess_v1') {
    return null;
  }

  const payloadB64 = parts[1];
  const providedSigB64 = parts[2];
  if (!payloadB64 || !providedSigB64) {
    return null;
  }

  const signingInput = `${APP_SESSION_TOKEN_PREFIX}${payloadB64}`;
  const expectedSig = crypto
    .createHmac('sha256', resolveSigningSecret(secret))
    .update(signingInput)
    .digest();

  let providedSig: Buffer;
  try {
    providedSig = Buffer.from(providedSigB64, 'base64url');
  } catch {
    return null;
  }

  if (providedSig.length !== expectedSig.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(providedSig, expectedSig)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    ) as Partial<VerifiedAppSession>;

    if (
      typeof parsed.uid !== 'string' ||
      parsed.uid.length === 0 ||
      typeof parsed.email !== 'string' ||
      parsed.email.length === 0 ||
      typeof parsed.name !== 'string' ||
      typeof parsed.exp !== 'number' ||
      typeof parsed.iat !== 'number'
    ) {
      return null;
    }

    if (parsed.exp <= Date.now()) {
      return null;
    }

    return {
      uid: parsed.uid,
      email: parsed.email,
      name: parsed.name,
      role: parsed.role === 'admin' ? 'admin' : 'creator',
      iat: parsed.iat,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}
