import { Hono } from 'hono';
import type { Env } from '../env.js';
import { generateApiKey, getKeyPrefix, hashApiKey } from '../lib/api-key.js';

interface ApiKeyRow {
  key_prefix: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const keys = new Hono<{ Bindings: Env }>();

/**
 * GET /keys — List all API keys for the authenticated user.
 */
keys.get('/keys', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const result = await c.env.DB.prepare(`
    SELECT key_prefix, name, created_at, last_used_at, revoked_at
    FROM api_keys WHERE user_id = ? ORDER BY created_at DESC
  `).bind(user.id).all<ApiKeyRow>();

  const apiKeys = (result.results || []).map(k => ({
    prefix: k.key_prefix,
    name: k.name,
    created_at: k.created_at,
    last_used_at: k.last_used_at,
    revoked: k.revoked_at !== null,
  }));

  return c.json({ keys: apiKeys });
});

/**
 * POST /keys — Create a new API key.
 */
keys.post('/keys', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  let name = 'default';
  try {
    const body = await c.req.json<{ name?: string }>();
    if (body.name) name = body.name.slice(0, 64);
  } catch {
    // No body or invalid JSON
  }

  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM api_keys WHERE user_id = ? AND revoked_at IS NULL',
  ).bind(user.id).first<{ cnt: number }>();

  if (count && count.cnt >= 10) {
    return c.json({ error: 'Maximum 10 active API keys. Revoke one first.' }, 400);
  }

  const apiKey = generateApiKey();
  const keyHash = await hashApiKey(apiKey);
  const keyPrefix = getKeyPrefix(apiKey);

  await c.env.DB.prepare(`
    INSERT INTO api_keys (key_hash, user_id, key_prefix, name) VALUES (?, ?, ?, ?)
  `).bind(keyHash, user.id, keyPrefix, name).run();

  return c.json({
    api_key: apiKey,
    prefix: keyPrefix,
    name,
    message: 'Save this key — it will not be shown again.',
  }, 201);
});

/**
 * DELETE /keys/:prefix — Revoke an API key by its prefix.
 */
keys.delete('/keys/:prefix', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const prefix = c.req.param('prefix');

  const result = await c.env.DB.prepare(`
    UPDATE api_keys SET revoked_at = datetime('now')
    WHERE user_id = ? AND key_prefix = ? AND revoked_at IS NULL
  `).bind(user.id, prefix).run();

  if (result.meta.changes === 0) {
    return c.json({ error: 'Key not found or already revoked' }, 404);
  }

  return c.json({ ok: true });
});

export default keys;
