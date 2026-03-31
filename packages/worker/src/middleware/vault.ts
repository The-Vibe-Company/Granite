import { createMiddleware } from 'hono/factory';
import type { Env } from '../env.js';

// Must run after auth middleware
export const vaultMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  // Allow explicit vault_id via query param or header
  let vaultId = c.req.query('vault_id') || c.req.header('X-Vault-Id') || '';

  if (vaultId) {
    // Verify user owns this vault
    const vault = await c.env.DB.prepare(
      'SELECT vault_id FROM vaults WHERE vault_id = ? AND user_id = ?',
    ).bind(vaultId, user.id).first<{ vault_id: string }>();

    if (!vault) {
      return c.json({ error: 'Vault not found or access denied' }, 404);
    }
  } else {
    // Default to user's first vault
    const vault = await c.env.DB.prepare(
      'SELECT vault_id FROM vaults WHERE user_id = ? ORDER BY created_at LIMIT 1',
    ).bind(user.id).first<{ vault_id: string }>();

    if (!vault) {
      return c.json({ error: 'No vaults found. Create one first.' }, 404);
    }
    vaultId = vault.vault_id;
  }

  c.set('vaultId', vaultId);
  await next();
});
