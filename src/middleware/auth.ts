import type { NextFunction, Request, Response } from 'express';
import {
  isAppSessionToken,
  verifyAppSessionToken,
} from '../../server/auth/passwordSession.ts';
import { getOrCreateUser, getUserByUid } from '../db/repository.ts';
import { adminAuth } from '../lib/firebase-admin.ts';
import type { User } from '../types/clipgenius.ts';

export interface AuthenticatedPrincipal {
  uid: string;
  email?: string;
  name?: string;
}

export interface AuthRequest extends Request {
  user?: AuthenticatedPrincipal;
  dbUser?: User;
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

async function resolveAuthenticatedIdentity(
  token: string
): Promise<{ user: AuthenticatedPrincipal; dbUser: User }> {
  if (isAppSessionToken(token)) {
    const verified = verifyAppSessionToken(token);
    if (!verified) {
      throw new Error('Invalid or expired session token.');
    }
    const dbUser = await getUserByUid(verified.uid);
    if (!dbUser) {
      throw new Error('Account not found.');
    }
    return {
      user: {
        uid: dbUser.id,
        email: dbUser.email,
        name: dbUser.name,
      },
      dbUser,
    };
  }

  const decoded = await adminAuth.verifyIdToken(token);
  const dbUser = await getOrCreateUser(
    decoded.uid,
    decoded.email || `${decoded.uid}@users.clipgenius.local`,
    decoded.name
  );
  return {
    user: {
      uid: decoded.uid,
      email: decoded.email,
      name: decoded.name,
    },
    dbUser,
  };
}

export async function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized: Please sign in to continue.' });
    return;
  }

  try {
    const resolved = await resolveAuthenticatedIdentity(token);
    req.user = resolved.user;
    req.dbUser = resolved.dbUser;
    next();
  } catch (error) {
    console.error('Error verifying session token:', error);
    res.status(401).json({ error: 'Unauthorized: Invalid or expired session token.' });
  }
}

export async function optionalAuth(
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractBearerToken(req);
  if (!token) {
    next();
    return;
  }

  try {
    const resolved = await resolveAuthenticatedIdentity(token);
    req.user = resolved.user;
    req.dbUser = resolved.dbUser;
  } catch (error) {
    console.error('Optional auth token verification failed:', error);
  }
  next();
}
