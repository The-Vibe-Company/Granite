import { Hono } from 'hono';
import type { Env } from '../env.js';
import { TIER_LIMITS } from '../env.js';

const user = new Hono<{ Bindings: Env }>();

/**
 * GET /me — Return current user profile with vault stats.
 */
user.get('/me', async (c) => {
  const u = c.get('user');
  if (!u) return c.json({ error: 'Authentication required' }, 401);

  const tier = c.get('tier');
  const limits = TIER_LIMITS[tier];

  // Get vault count and note count
  const vaults = await c.env.DB.prepare(
    'SELECT vault_id, vault_name, created_at FROM vaults WHERE user_id = ?',
  ).bind(u.id).all<{ vault_id: string; vault_name: string; created_at: string }>();

  let totalNotes = 0;
  const vaultStats = [];
  for (const v of vaults.results || []) {
    const noteCount = await c.env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM notes WHERE vault_id = ?',
    ).bind(v.vault_id).first<{ cnt: number }>();
    const cnt = noteCount?.cnt ?? 0;
    totalNotes += cnt;
    vaultStats.push({
      vault_id: v.vault_id,
      vault_name: v.vault_name,
      note_count: cnt,
      created_at: v.created_at,
    });
  }

  return c.json({
    user: {
      id: u.id,
      github_username: u.github_username,
      email: u.email,
      tier,
      created_at: u.created_at,
    },
    vaults: vaultStats,
    totals: {
      vaults: vaultStats.length,
      notes: totalNotes,
    },
    limits: {
      max_vaults: limits.maxVaults,
      max_notes_per_vault: limits.maxNotesPerVault,
      rate_limit_per_hour: limits.rateLimit,
    },
  });
});

/**
 * GET /vaults — List user's vaults.
 */
user.get('/vaults', async (c) => {
  const u = c.get('user');
  if (!u) return c.json({ error: 'Authentication required' }, 401);

  const result = await c.env.DB.prepare(
    'SELECT vault_id, vault_name, created_at FROM vaults WHERE user_id = ? ORDER BY created_at',
  ).bind(u.id).all<{ vault_id: string; vault_name: string; created_at: string }>();

  return c.json({ vaults: result.results || [] });
});

/**
 * POST /vaults — Create a new vault.
 */
user.post('/vaults', async (c) => {
  const u = c.get('user');
  if (!u) return c.json({ error: 'Authentication required' }, 401);

  const tier = c.get('tier');
  const limits = TIER_LIMITS[tier];

  const vaultCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM vaults WHERE user_id = ?',
  ).bind(u.id).first<{ cnt: number }>();

  if (vaultCount && vaultCount.cnt >= limits.maxVaults) {
    return c.json({
      error: `Maximum ${limits.maxVaults} vault(s) on ${tier} tier. Upgrade to create more.`,
    }, 400);
  }

  let name = 'My Vault';
  try {
    const body = await c.req.json<{ name?: string }>();
    if (body.name) name = body.name.slice(0, 100);
  } catch {
    // No body
  }

  const { nanoid } = await import('nanoid');
  const vaultId = `v_${nanoid(12)}`;

  await c.env.DB.prepare(`
    INSERT INTO vaults (vault_id, user_id, vault_name) VALUES (?, ?, ?)
  `).bind(vaultId, u.id, name).run();

  return c.json({ vault_id: vaultId, vault_name: name }, 201);
});

export default user;
