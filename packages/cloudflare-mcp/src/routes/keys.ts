import { Hono } from 'hono';
import type { AppVariables, Env } from '../env.js';
import { generateApiKey, getKeyPrefix, hashApiKey } from '../lib/api-key.js';
import { database } from '../db.js';

type Bindings = { Bindings: Env; Variables: AppVariables };

const keys = new Hono<Bindings>();

keys.get('/keys', async (c) => {
  const user = c.get('user');
  const result = await database(c.env).query<{
    key_prefix: string;
    name: string;
    created_at: string;
    last_used_at: string | null;
    revoked_at: string | null;
  }>(`
    SELECT key_prefix, name, created_at, last_used_at, revoked_at
    FROM api_keys
    WHERE user_id = $1
    ORDER BY created_at DESC
  `, [user.id]);

  return c.json({ keys: result });
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
  await database(c.env).execute(`
    INSERT INTO api_keys (key_hash, user_id, key_prefix, name)
    VALUES ($1, $2, $3, $4)
  `, [await hashApiKey(apiKey), user.id, keyPrefix, name]);

  return c.json({ api_key: apiKey, key_prefix: keyPrefix, name }, 201);
});

keys.delete('/keys/:prefix', async (c) => {
  const user = c.get('user');
  const prefix = c.req.param('prefix');
  const result = await database(c.env).execute(`
    UPDATE api_keys
    SET revoked_at = now()
    WHERE user_id = $1 AND key_prefix = $2 AND revoked_at IS NULL
  `, [user.id, prefix]);

  const changes = result.rowCount;
  if (changes === 0) {
    return c.json({ error: 'API key not found or already revoked.' }, 404);
  }

  return c.json({ revoked: true, prefix });
});

export default keys;
