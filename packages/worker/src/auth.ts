import type { Context, Next } from 'hono';
import type { Env } from './env.js';

async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const apiKey = authHeader.slice(7);
  if (!apiKey) {
    return c.json({ error: 'Empty API key' }, 401);
  }

  const keyHash = await hashApiKey(apiKey);

  const vault = await c.env.DB.prepare(
    'SELECT vault_id, vault_name FROM vaults WHERE api_key_hash = ?'
  ).bind(keyHash).first<{ vault_id: string; vault_name: string }>();

  if (!vault) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  c.set('vaultId', vault.vault_id);
  c.set('vaultName', vault.vault_name);
  await next();
}

export { hashApiKey };
