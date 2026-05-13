import { Hono } from 'hono';
import type { AppVariables, Env } from '../env.js';
import { generateApiKey, getKeyPrefix, hashApiKey } from '../lib/api-key.js';

type Bindings = { Bindings: Env; Variables: AppVariables };

const keys = new Hono<Bindings>();

keys.get('/keys', async (c) => {
  const user = c.get('user');
  const result = await c.env.ACCOUNTS_DB.prepare(`
    SELECT key_prefix, name, created_at, last_used_at, revoked_at
    FROM api_keys
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).bind(user.id).all<{
    key_prefix: string;
    name: string;
    created_at: string;
    last_used_at: string | null;
    revoked_at: string | null;
  }>();

  return c.json({ keys: result.results ?? [] });
});

keys.post('/keys', async (c) => {
  const user = c.get('user');
  let name = 'manual';
  try {
    const body = await c.req.json() as { name?: string };
    if (body.name) name = body.name.slice(0, 80);
  } catch {}

  const apiKey = generateApiKey();
  const keyPrefix = getKeyPrefix(apiKey);
  await c.env.ACCOUNTS_DB.prepare(`
    INSERT INTO api_keys (key_hash, user_id, key_prefix, name)
    VALUES (?, ?, ?, ?)
  `).bind(await hashApiKey(apiKey), user.id, keyPrefix, name).run();

  return c.json({ api_key: apiKey, key_prefix: keyPrefix, name }, 201);
});

keys.delete('/keys/:prefix', async (c) => {
  const user = c.get('user');
  const prefix = c.req.param('prefix');
  const result = await c.env.ACCOUNTS_DB.prepare(`
    UPDATE api_keys
    SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE user_id = ? AND key_prefix = ? AND revoked_at IS NULL
  `).bind(user.id, prefix).run() as { meta?: { changes?: number } };

  const changes = result.meta?.changes ?? 0;
  if (changes === 0) {
    return c.json({ error: 'API key not found or already revoked.' }, 404);
  }

  return c.json({ revoked: true, prefix });
});

export default keys;
