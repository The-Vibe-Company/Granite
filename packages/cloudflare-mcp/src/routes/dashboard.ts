import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { AppVariables, Env, User, VaultRow } from '../env.js';
import { database } from '../db.js';
import { createWebSession, currentWebUser, verifyNeonJwt } from '../neon-auth.js';
import { upsertNeonUser } from '../db.js';
import { ensureStripeCustomer, stripeBilling } from '../billing.js';

type Bindings = { Bindings: Env; Variables: AppVariables };

const dashboard = new Hono<Bindings>();

dashboard.get('/app/login', async (c) => {
  return c.html(page('Login', `
    <main>
      <h1>Granite Cloud</h1>
      <p>Sign in with Neon Auth, then paste the issued Neon JWT below to create a Granite web session.</p>
      <form method="post" action="/app/session">
        <input type="hidden" name="cli_session" value="${escapeHtml(c.req.query('cli_session') ?? '')}">
        <label>Neon Auth JWT <textarea name="token" rows="6" required></textarea></label>
        <button type="submit">Continue</button>
      </form>
      ${c.env.NEON_AUTH_BASE_URL ? `<p><a href="${escapeHtml(c.env.NEON_AUTH_BASE_URL)}">Open Neon Auth</a></p>` : ''}
    </main>
  `));
});

dashboard.post('/app/session', async (c) => {
  const form = await c.req.parseBody();
  const token = typeof form.token === 'string' ? form.token : '';
  const cliSession = typeof form.cli_session === 'string' ? form.cli_session : '';
  const user = await upsertNeonUser(database(c.env), await verifyNeonJwt(c.env, token));
  if (cliSession) {
    const code = await completeCliLogin(c.env, cliSession, user.id);
    return c.html(page('CLI login', `<main><h1>Granite Cloud</h1><p>Enter this verification code in the CLI:</p><code>${code}</code></main>`), 200, {
      'Set-Cookie': await createWebSession(c, user),
    });
  }
  return new Response(null, { status: 303, headers: { Location: '/app', 'Set-Cookie': await createWebSession(c, user) } });
});

dashboard.get('/app', async (c) => {
  const user = await currentWebUser(c);
  if (!user) return c.redirect('/app/login');
  const vaults = await database(c.env).query<VaultRow>(`
    SELECT vault_id, user_id, vault_name, billing_status, stripe_subscription_id,
      stripe_checkout_session_id, stripe_price_id, current_period_end, cancel_at_period_end,
      storage_limit_bytes, storage_used_bytes, activated_at, created_at, updated_at
    FROM vaults
    WHERE user_id = $1
    ORDER BY created_at DESC
  `, [user.id]);
  return c.html(page('Granite Cloud', `
    <main>
      <h1>Granite Cloud</h1>
      <form method="post" action="/app/vaults">
        <label>Vault name <input name="name" value="Cloud Vault" maxlength="100"></label>
        <button type="submit">Create paid vault</button>
      </form>
      <section>
        <h2>Vaults</h2>
        ${vaults.length ? vaults.map(vaultCard).join('') : '<p>No vaults yet.</p>'}
      </section>
    </main>
  `));
});

dashboard.post('/app/vaults', async (c) => {
  const user = await currentWebUser(c);
  if (!user) return c.redirect('/app/login');
  const form = await c.req.parseBody();
  const name = safeName(typeof form.name === 'string' ? form.name : undefined);
  const vaultId = `v_${nanoid(12)}`;
  const db = database(c.env);
  const billing = stripeBilling(c.env);
  const customerId = await ensureStripeCustomer(db, billing, user);
  const checkout = await billing.createVaultCheckout({ customerId, vaultId, userId: user.id, name });
  await db.execute(`
    INSERT INTO vaults (
      vault_id, user_id, vault_name, billing_status, stripe_checkout_session_id,
      stripe_price_id, storage_limit_bytes, storage_used_bytes
    )
    VALUES ($1, $2, $3, 'pending_checkout', $4, $5, 1000000000, 0)
  `, [vaultId, user.id, name, checkout.id, c.env.STRIPE_VAULT_1GB_PRICE_ID ?? 'test_price']);
  return c.redirect(checkout.url, 303);
});

function vaultCard(vault: VaultRow): string {
  const used = `${Math.round((vault.storage_used_bytes / vault.storage_limit_bytes) * 100)}%`;
  return `
    <article>
      <h3>${escapeHtml(vault.vault_name)}</h3>
      <p>${escapeHtml(vault.vault_id)} · ${escapeHtml(vault.billing_status)} · ${used}</p>
      <code>https://granite.thevibecompany.co/mcp?vault_id=${escapeHtml(vault.vault_id)}</code>
    </article>
  `;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; color: #151515; background: #f7f7f4; }
    main { max-width: 840px; margin: 0 auto; padding: 40px 20px; }
    form, article { background: white; border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin: 16px 0; }
    input, textarea, button { display: block; width: 100%; box-sizing: border-box; margin-top: 8px; padding: 10px; font: inherit; }
    button { width: auto; background: #111; color: white; border: 0; border-radius: 6px; cursor: pointer; }
    code { display: block; overflow-wrap: anywhere; background: #f1f1ec; padding: 8px; border-radius: 6px; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

async function completeCliLogin(env: Env, session: string, userId: string): Promise<string> {
  const { generateApiKey, getKeyPrefix, hashApiKey } = await import('../lib/api-key.js');
  const apiKey = generateApiKey();
  const code = nanoid(8).toUpperCase();
  await database(env).execute(`
    UPDATE cli_login_sessions
    SET user_id = $2,
      verification_code_hash = $3,
      api_key_value = $4,
      api_key_prefix = $5
    WHERE session_id = $1 AND expires_at > now()
  `, [session, userId, await hashApiKey(code), apiKey, getKeyPrefix(apiKey)]);
  return code;
}

function safeName(value: string | undefined): string {
  return (value?.trim() || 'Cloud Vault').slice(0, 100);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]!));
}

export default dashboard;
