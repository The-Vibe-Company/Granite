import { createMiddleware } from 'hono/factory';
import type { Env, Tier, User } from './env.js';
import { hashApiKey } from './lib/api-key.js';

declare module 'hono' {
  interface ContextVariableMap {
    user: User | null;
    tier: Tier;
    vaultId: string;
  }
}

/**
 * Auth middleware for protected routes.
 * Extracts Bearer gsk_ token, looks up user via api_keys + users join.
 * Rejects unauthenticated requests with 401.
 */
export const authMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const authHeader = c.req.header('Authorization');

  // Also accept ?key= on billing routes (browser redirect flow)
  const path = new URL(c.req.url).pathname;
  const queryKey = path.startsWith('/billing/') ? c.req.query('key') : undefined;

  const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (queryKey || '');

  if (!apiKey || !apiKey.startsWith('gsk_')) {
    return c.json({ error: 'Missing or invalid API key. Run: mem cloud login' }, 401);
  }

  const keyHash = await hashApiKey(apiKey);

  const result = await c.env.DB.prepare(`
    SELECT u.id, u.github_id, u.email, u.github_username, u.tier,
           u.stripe_customer_id, u.stripe_subscription_id, u.created_at, u.updated_at
    FROM api_keys ak
    JOIN users u ON ak.user_id = u.id
    WHERE ak.key_hash = ? AND ak.revoked_at IS NULL
  `).bind(keyHash).first<User>();

  if (!result) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  // Update last_used_at fire-and-forget
  c.executionCtx.waitUntil(
    c.env.DB.prepare("UPDATE api_keys SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE key_hash = ?")
      .bind(keyHash).run(),
  );

  c.set('user', result);
  c.set('tier', result.tier as Tier);
  await next();
});
