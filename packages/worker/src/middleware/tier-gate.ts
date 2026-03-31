import { createMiddleware } from 'hono/factory';
import type { Env, Tier } from '../env.js';
import { TIER_LIMITS } from '../env.js';

/**
 * Middleware that blocks free-tier users from sync/MCP endpoints.
 * Must be registered after authMiddleware (which sets `tier`).
 */
export const requirePaidTier = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const tier: Tier = c.get('tier');

  if (!TIER_LIMITS[tier].syncEnabled) {
    return c.json({
      error: 'Sync requires a Pro subscription. Run: mem cloud upgrade',
      tier,
      upgrade_url: `${c.env.BASE_URL}/billing/checkout`,
    }, 403);
  }

  return next();
});
