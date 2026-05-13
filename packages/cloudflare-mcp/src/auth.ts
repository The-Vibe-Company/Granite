import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type { AppVariables, Env, User } from './env.js';
import { hashApiKey } from './lib/api-key.js';

type Bindings = { Bindings: Env; Variables: AppVariables };

export const authMiddleware = createMiddleware<Bindings>(async (c, next) => {
  const authHeader = c.req.header('Authorization') ?? '';
  const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';

  if (!apiKey || !apiKey.startsWith('gsk_')) {
    return c.json({ error: 'Missing or invalid API key.' }, 401);
  }

  const keyHash = await hashApiKey(apiKey);
  const result = await c.env.ACCOUNTS_DB.prepare(`
    SELECT u.id, u.github_id, u.email, u.github_username, u.created_at, u.updated_at
    FROM api_keys k
    JOIN users u ON u.id = k.user_id
    WHERE k.key_hash = ? AND k.revoked_at IS NULL
  `).bind(keyHash).first<User>();

  if (!result) {
    return c.json({ error: 'Invalid API key.' }, 401);
  }

  c.executionCtx.waitUntil(c.env.ACCOUNTS_DB.prepare(
    "UPDATE api_keys SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE key_hash = ?",
  ).bind(keyHash).run());

  c.set('user', result);
  await next();
});

export async function resolveVaultId(c: Context<Bindings>): Promise<string | Response> {
  const user = c.get('user');
  const requested = c.req.query('vault_id') || c.req.header('X-Vault-Id') || '';

  if (requested) {
    const owned = await c.env.ACCOUNTS_DB.prepare(
      'SELECT vault_id FROM vaults WHERE vault_id = ? AND user_id = ?',
    ).bind(requested, user.id).first<{ vault_id: string }>();
    if (!owned) return c.json({ error: 'Vault not found or access denied.' }, 404);
    return requested;
  }

  const first = await c.env.ACCOUNTS_DB.prepare(
    'SELECT vault_id FROM vaults WHERE user_id = ? ORDER BY created_at LIMIT 1',
  ).bind(user.id).first<{ vault_id: string }>();

  if (!first) return c.json({ error: 'No vaults found. Create one first.' }, 404);
  return first.vault_id;
}
