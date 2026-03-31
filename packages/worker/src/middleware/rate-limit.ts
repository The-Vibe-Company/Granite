import { createMiddleware } from 'hono/factory';
import type { Env, Tier } from '../env.js';
import { TIER_LIMITS } from '../env.js';
import { getRateLimitIdentifier } from '../lib/rate-limit.js';

export const rateLimitMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const tier: Tier = c.get('tier');
  const user = c.get('user');
  const limits = TIER_LIMITS[tier];

  const identifier = getRateLimitIdentifier(
    user,
    c.req.header('CF-Connecting-IP') || null,
    c.req.header('X-Forwarded-For') || null,
  );

  const action = 'sync';

  const result = await c.env.DB.prepare(`
    SELECT COUNT(*) as count FROM rate_limits
    WHERE identifier = ? AND action = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')
  `).bind(identifier, action).first<{ count: number }>();

  const count = result?.count ?? 0;

  if (count >= limits.rateLimit) {
    return c.json({
      error: 'Rate limit exceeded',
      limit: limits.rateLimit,
      window: '1 hour',
      tier,
    }, 429);
  }

  // Insert before next() to prevent race conditions
  await c.env.DB.prepare(`
    INSERT INTO rate_limits (identifier, action) VALUES (?, ?)
  `).bind(identifier, action).run();

  c.header('X-RateLimit-Limit', String(limits.rateLimit));
  c.header('X-RateLimit-Remaining', String(limits.rateLimit - count - 1));

  return next();
});
