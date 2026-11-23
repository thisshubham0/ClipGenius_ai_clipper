import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canAccessWorkspaceResource,
  SlidingWindowRateLimiter,
} from './security';

test('SlidingWindowRateLimiter allows up to maxRequests and blocks excess until window expires', () => {
  const limiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 3 });

  const r1 = limiter.check('ip:1', 1000);
  const r2 = limiter.check('ip:1', 2000);
  const r3 = limiter.check('ip:1', 3000);
  const r4 = limiter.check('ip:1', 4000);

  assert.equal(r1.allowed, true);
  assert.equal(r1.remaining, 2);
  assert.equal(r2.allowed, true);
  assert.equal(r3.allowed, true);
  assert.equal(r3.remaining, 0);

  assert.equal(r4.allowed, false);
  assert.equal(r4.remaining, 0);
  assert.ok(r4.retryAfterSec >= 56 && r4.retryAfterSec <= 58);

  // Different key is unaffected
  const other = limiter.check('ip:2', 4000);
  assert.equal(other.allowed, true);

  // After window elapses, requests are allowed again
  const r5 = limiter.check('ip:1', 62_000);
  assert.equal(r5.allowed, true);
});

test('canAccessWorkspaceResource enforces owner isolation, admin override, and public demo access', () => {
  assert.equal(
    canAccessWorkspaceResource({ resourceOwnerUid: 'demo', isDemo: true }),
    true
  );
  assert.equal(
    canAccessWorkspaceResource({ resourceOwnerUid: 'uid_a', actorUid: undefined }),
    false
  );
  assert.equal(
    canAccessWorkspaceResource({ resourceOwnerUid: 'uid_a', actorUid: 'uid_a' }),
    true
  );
  assert.equal(
    canAccessWorkspaceResource({
      resourceOwnerUid: 'uid_a',
      actorUid: 'uid_b',
      actorRole: 'creator',
    }),
    false
  );
  assert.equal(
    canAccessWorkspaceResource({
      resourceOwnerUid: 'uid_a',
      actorUid: 'uid_admin',
      actorRole: 'admin',
    }),
    true
  );
});
