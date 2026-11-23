import type { NextFunction, Request, Response } from 'express';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSec: number;
}

/**
 * Pure sliding-window rate limiter store (per IP or authenticated UID).
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(options: { windowMs: number; maxRequests: number }) {
    this.windowMs = options.windowMs;
    this.maxRequests = options.maxRequests;
  }

  check(key: string, nowMs: number = Date.now()): RateLimitResult {
    const cutoff = nowMs - this.windowMs;
    const timestamps = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= this.maxRequests) {
      const oldest = timestamps[0] ?? nowMs;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + this.windowMs - nowMs) / 1000));
      this.hits.set(key, timestamps);
      return {
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        retryAfterSec,
      };
    }

    timestamps.push(nowMs);
    this.hits.set(key, timestamps);
    return {
      allowed: true,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - timestamps.length),
      retryAfterSec: 0,
    };
  }
}

export function createRateLimitMiddleware(options: {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
}) {
  const limiter = new SlidingWindowRateLimiter({
    windowMs: options.windowMs,
    maxRequests: options.maxRequests,
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip =
      (typeof req.headers['x-forwarded-for'] === 'string'
        ? req.headers['x-forwarded-for'].split(',')[0]?.trim()
        : undefined) ||
      req.ip ||
      'unknown';
    const key = `${options.keyPrefix}:${ip}`;
    const result = limiter.check(key);

    res.setHeader('X-RateLimit-Limit', String(result.limit));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSec));
      res.status(429).json({
        error: `Rate limit exceeded. Please retry in ${result.retryAfterSec}s.`,
      });
      return;
    }

    next();
  };
}

/**
 * Sets hardened HTTP security headers compatible with iframe embedding.
 */
export function securityHeadersMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('X-XSS-Protection', '0');
  next();
}

/**
 * Least-privilege RBAC owner check for workspace resources.
 */
export function canAccessWorkspaceResource(params: {
  resourceOwnerUid: string;
  actorUid?: string;
  actorRole?: 'creator' | 'admin';
  isDemo?: boolean;
}): boolean {
  if (params.isDemo) return true;
  if (!params.actorUid) return false;
  if (params.actorRole === 'admin') return true;
  return params.resourceOwnerUid === params.actorUid;
}
