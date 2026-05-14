import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type { AppVariables, Env } from './env.js';
import { hashApiKey } from './lib/api-key.js';
import { database, findUserByApiKeyHash, ownedVault, touchApiKey, vaultCanRead, vaultCanWrite } from './db.js';

type Bindings = { Bindings: Env; Variables: AppVariables };
type AccessMode = 'read' | 'write';

export const authMiddleware = createMiddleware<Bindings>(async (c, next) => {
  const authHeader = c.req.header('Authorization') ?? '';
  const [scheme, ...rest] = authHeader.split(/\s+/);
  const apiKey = scheme?.toLowerCase() === 'bearer' ? rest.join(' ').trim() : '';

  if (!apiKey || !apiKey.startsWith('gsk_')) {
    return c.json({ error: 'Missing or invalid API key.' }, 401);
  }

  const keyHash = await hashApiKey(apiKey);
  const db = database(c.env);
  const result = await findUserByApiKeyHash(db, keyHash);

  if (!result) {
    return c.json({ error: 'Invalid API key.' }, 401);
  }

  c.executionCtx.waitUntil(touchApiKey(db, keyHash));

  c.set('user', result);
  await next();
});

export async function resolveVaultId(c: Context<Bindings>, mode: AccessMode = 'read'): Promise<string | Response> {
  const user = c.get('user');
  const requested = c.req.query('vault_id') || c.req.header('X-Vault-Id') || '';

  if (requested) {
    const owned = await ownedVault(database(c.env), user.id, requested);
    if (!owned) return c.json({ error: 'Vault not found or access denied.' }, 404);
    if (mode === 'write' && !vaultCanWrite(owned)) {
      return c.json({ error: `Vault is not writable while billing status is ${owned.billing_status}.` }, 402);
    }
    if (mode === 'read' && !vaultCanRead(owned)) {
      return c.json({ error: `Vault is not active yet. Billing status is ${owned.billing_status}.` }, 402);
    }
    c.set('vault', owned);
    return requested;
  }

  return c.json({ error: 'Missing vault_id. Provide ?vault_id=<id> or X-Vault-Id.' }, 400);
}
