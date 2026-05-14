import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { AppVariables, Env, VaultRow } from '../env.js';
import { database } from '../db.js';
import { currentWebUser } from '../neon-auth.js';
import { ensureStripeCustomer, stripeBilling } from '../billing.js';
import { generateApiKey, getKeyPrefix, hashApiKey } from '../lib/api-key.js';

type Bindings = { Bindings: Env; Variables: AppVariables };

const dashboard = new Hono<Bindings>();

dashboard.get('/app/login', async (c) => {
  return c.html(page('Login', loginPage(c.req.query('cli_session') ?? '', c.env.NEON_AUTH_BASE_URL ?? '')));
});

dashboard.get('/app', async (c) => {
  const user = await currentWebUser(c);
  if (!user) return c.redirect('/app/login');
  const checkout = c.req.query('checkout') ?? '';
  const checkoutVaultId = c.req.query('vault_id') ?? '';
  const checkoutSync = checkout === 'success' && checkoutVaultId
    ? await syncCheckoutReturn(c.env, user.id, checkoutVaultId)
    : null;
  const vaults = await database(c.env).query<VaultRow>(`
    SELECT vault_id, user_id, vault_name, billing_status, stripe_subscription_id,
      stripe_checkout_session_id, stripe_price_id, current_period_end, cancel_at_period_end,
      storage_limit_bytes, storage_used_bytes, activated_at, created_at, updated_at
    FROM vaults
    WHERE user_id = $1
    ORDER BY created_at DESC
  `, [user.id]);
  const apiKeys = await database(c.env).query<{
    key_prefix: string;
    name: string;
    created_at: string | Date;
    last_used_at: string | Date | null;
    revoked_at: string | Date | null;
  }>(`
    SELECT key_prefix, name, created_at, last_used_at, revoked_at
    FROM api_keys
    WHERE user_id = $1
    ORDER BY created_at DESC
  `, [user.id]);
  const checkoutMessage = checkout === 'success'
    ? checkoutSync === 'active'
      ? '<p class="notice success" role="status">Checkout complete. Your vault is active.</p>'
      : checkoutSync === 'error'
        ? '<p class="notice warning" role="alert">Checkout complete, but Granite could not refresh billing yet. Refresh this page in a moment.</p>'
        : '<p class="notice success" role="status">Checkout complete. Your vault will become writable as soon as Stripe confirms the subscription.</p>'
    : checkout === 'canceled'
      ? '<p class="notice warning" role="alert">Checkout was canceled. Create a vault again when you are ready.</p>'
      : '';
  return c.html(page('Granite Cloud', `
    <main>
      <h1>Granite Cloud</h1>
      ${checkoutMessage}
      <form method="post" action="/app/vaults">
        <label>Vault name <input name="name" value="Cloud Vault" maxlength="100"></label>
        <button type="submit">Create paid vault</button>
      </form>
      <section>
        <h2>Vaults</h2>
        ${vaults.length ? vaults.map(vault => vaultCard(vault, c.env.BASE_URL)).join('') : '<p>No vaults yet.</p>'}
      </section>
      <section>
        <h2>API keys</h2>
        <form method="post" action="/app/keys">
          <label>Key name <input name="name" value="mcp-client" maxlength="80"></label>
          <button type="submit">Create API key</button>
        </form>
        ${apiKeys.length ? apiKeys.map(key => apiKeyCard(key)).join('') : '<p>No API keys yet.</p>'}
      </section>
    </main>
  `));
});

dashboard.post('/app/keys', async (c) => {
  const user = await currentWebUser(c);
  if (!user) return c.redirect('/app/login');
  const form = await c.req.parseBody();
  const name = safeKeyName(typeof form.name === 'string' ? form.name : undefined);
  const apiKey = generateApiKey();
  const keyPrefix = getKeyPrefix(apiKey);
  await database(c.env).execute(`
    INSERT INTO api_keys (key_hash, user_id, key_prefix, name)
    VALUES ($1, $2, $3, $4)
  `, [await hashApiKey(apiKey), user.id, keyPrefix, name]);
  return c.html(page('API key created', `
    <main>
      <h1>API key created</h1>
      ${apiKeyCreatedNotice(apiKey, name)}
      <p><a href="/app">Back to dashboard</a></p>
    </main>
  `), 201, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
});

dashboard.post('/app/keys/:prefix/revoke', async (c) => {
  const user = await currentWebUser(c);
  if (!user) return c.redirect('/app/login');
  await database(c.env).execute(`
    UPDATE api_keys
    SET revoked_at = now()
    WHERE user_id = $1 AND key_prefix = $2 AND revoked_at IS NULL
  `, [user.id, c.req.param('prefix')]);
  return c.redirect('/app', 303);
});

async function syncCheckoutReturn(env: Env, userId: string, vaultId: string): Promise<'active' | 'pending' | 'error'> {
  const db = database(env);
  const vault = await db.first<VaultRow>(`
    SELECT vault_id, user_id, vault_name, billing_status, stripe_subscription_id,
      stripe_checkout_session_id, stripe_price_id, current_period_end, cancel_at_period_end,
      storage_limit_bytes, storage_used_bytes, activated_at, created_at, updated_at
    FROM vaults
    WHERE vault_id = $1 AND user_id = $2
  `, [vaultId, userId]);
  if (!vault?.stripe_checkout_session_id || vault.billing_status === 'active') {
    return vault?.billing_status === 'active' ? 'active' : 'pending';
  }

  try {
    const billing = await stripeBilling(env).syncCheckoutSession(vault.stripe_checkout_session_id);
    const updated = await db.first<{ billing_status: VaultRow['billing_status'] }>(`
      UPDATE vaults
      SET billing_status = $3,
        stripe_subscription_id = COALESCE($4, stripe_subscription_id),
        current_period_end = CASE WHEN $5::bigint IS NULL THEN current_period_end ELSE to_timestamp($5::bigint) END,
        cancel_at_period_end = $6,
        activated_at = CASE WHEN $3 = 'active' THEN COALESCE(activated_at, now()) ELSE activated_at END,
        updated_at = now()
      WHERE vault_id = $1
        AND user_id = $2
        AND stripe_checkout_session_id = $7
      RETURNING billing_status
    `, [
      vaultId,
      userId,
      billing.billingStatus,
      billing.subscriptionId,
      billing.currentPeriodEnd,
      billing.cancelAtPeriodEnd,
      vault.stripe_checkout_session_id,
    ]);
    return updated?.billing_status === 'active' ? 'active' : 'pending';
  } catch (error) {
    console.error('Failed to sync Stripe checkout return', error);
    return 'error';
  }
}

dashboard.post('/app/vaults', async (c) => {
  const user = await currentWebUser(c);
  if (!user) return c.redirect('/app/login');
  const form = await c.req.parseBody();
  const name = safeName(typeof form.name === 'string' ? form.name : undefined);
  if (!c.env.STRIPE_VAULT_1GB_PRICE_ID) {
    return c.html(page('Granite Cloud', `
      <main>
        <h1>Granite Cloud</h1>
        <p class="notice warning" role="alert">Stripe price is not configured.</p>
      </main>
    `), 500);
  }
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
  `, [vaultId, user.id, name, checkout.id, c.env.STRIPE_VAULT_1GB_PRICE_ID]);
  return c.redirect(checkout.url, 303);
});

function vaultCard(vault: VaultRow, baseUrl: string): string {
  const used = `${Math.round((vault.storage_used_bytes / vault.storage_limit_bytes) * 100)}%`;
  const mcpUrl = `${baseUrl.replace(/\/+$/, '')}/mcp?vault_id=${encodeURIComponent(vault.vault_id)}`;
  return `
    <article>
      <h3>${escapeHtml(vault.vault_name)}</h3>
      <p>${escapeHtml(vault.vault_id)} · ${escapeHtml(vault.billing_status)} · ${used}</p>
      <code>${escapeHtml(mcpUrl)}</code>
    </article>
  `;
}

function apiKeyCreatedNotice(apiKey: string, name: string): string {
  return `
    <p class="notice success" role="status">API key created${name ? ` for ${escapeHtml(name)}` : ''}. Copy it now; it will not be shown again.</p>
    <code>${escapeHtml(apiKey)}</code>
  `;
}

function apiKeyCard(key: {
  key_prefix: string;
  name: string;
  created_at: string | Date;
  last_used_at: string | Date | null;
  revoked_at: string | Date | null;
}): string {
  const status = key.revoked_at ? 'revoked' : 'active';
  const lastUsed = key.last_used_at ? ` · last used ${escapeHtml(shortDate(key.last_used_at))}` : '';
  const revoke = key.revoked_at
    ? ''
    : `<form method="post" action="/app/keys/${encodeURIComponent(key.key_prefix)}/revoke" onsubmit="return confirm('Revoke this API key? Existing MCP clients using it will stop working.');"><button class="secondary" type="submit">Revoke</button></form>`;
  return `
    <article>
      <h3>${escapeHtml(key.name || key.key_prefix)}</h3>
      <p>${escapeHtml(key.key_prefix)} · ${status} · created ${escapeHtml(shortDate(key.created_at))}${lastUsed}</p>
      ${revoke}
    </article>
  `;
}

function shortDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body { font-family: Charter, "Iowan Old Style", Georgia, serif; margin: 0; color: #1d211b; background: #f4f1ea; }
    main { max-width: 840px; margin: 0 auto; padding: 40px 20px; }
    form, article, .auth-panel { background: white; border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin: 16px 0; }
    input, button { display: block; width: 100%; margin-top: 8px; padding: 10px; font: inherit; }
    button { width: auto; background: #111; color: white; border: 0; border-radius: 6px; cursor: pointer; }
    button.secondary { background: #eef0ea; color: #151515; }
    button:disabled { cursor: wait; opacity: 0.65; }
    label { display: block; margin-top: 14px; font-weight: 600; }
    input { border: 1px solid #bdbdb8; border-radius: 6px; background: #fff; }
    code { display: block; overflow-wrap: anywhere; background: #f1f1ec; padding: 8px; border-radius: 6px; }
    .auth-page {
      min-height: 100vh;
      max-width: none;
      padding: clamp(18px, 4vw, 48px);
      display: grid;
      place-items: center;
      background:
        linear-gradient(90deg, rgba(29,33,27,.045) 1px, transparent 1px) 0 0 / 28px 28px,
        linear-gradient(180deg, rgba(29,33,27,.035) 1px, transparent 1px) 0 0 / 28px 28px,
        radial-gradient(circle at 18% 14%, rgba(34,78,91,.16), transparent 28%),
        radial-gradient(circle at 90% 82%, rgba(174,80,42,.12), transparent 30%),
        #f4f1ea;
    }
    .auth-layout {
      width: min(1040px, 100%);
      min-height: min(720px, calc(100vh - 48px));
      display: grid;
      grid-template-columns: minmax(0, 1.08fr) minmax(360px, .92fr);
      border: 1px solid rgba(29,33,27,.16);
      border-radius: 8px;
      overflow: hidden;
      background: rgba(253,252,247,.9);
      box-shadow: 0 28px 80px rgba(29,33,27,.18);
    }
    .auth-story {
      position: relative;
      padding: clamp(28px, 5vw, 64px);
      color: #f8f2e5;
      background:
        linear-gradient(145deg, rgba(8,13,12,.86), rgba(20,45,45,.76)),
        linear-gradient(90deg, rgba(231,168,74,.28) 0 1px, transparent 1px 24px),
        #162a2a;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      isolation: isolate;
    }
    .auth-story::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        linear-gradient(120deg, transparent 0 18%, rgba(238,219,174,.15) 18% 18.4%, transparent 18.4% 100%),
        repeating-linear-gradient(0deg, rgba(255,255,255,.055) 0 1px, transparent 1px 12px);
      mix-blend-mode: screen;
      pointer-events: none;
      z-index: -1;
    }
    .brand { display: flex; align-items: center; gap: 12px; margin: 0; }
    .mark {
      width: 38px;
      height: 38px;
      border-radius: 8px;
      background: #e5b657;
      color: #142126;
      display: grid;
      place-items: center;
      font: 900 20px/1 ui-serif, Georgia, serif;
      box-shadow: inset 0 -2px 0 rgba(20,33,38,.18);
    }
    .brand-word { margin: 0; font: 700 17px/1.1 ui-serif, Georgia, serif; letter-spacing: 0; }
    .story-kicker, .eyebrow { margin: 0; color: #6d766c; font: 700 12px/1.4 ui-sans-serif, system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; }
    .auth-story .story-kicker { color: rgba(248,242,229,.7); }
    .story-title {
      max-width: 9ch;
      margin: 68px 0 0;
      font-size: clamp(44px, 7vw, 78px);
      line-height: .9;
      letter-spacing: 0;
    }
    .story-copy { max-width: 440px; margin: 24px 0 0; color: rgba(248,242,229,.78); font: 18px/1.55 ui-sans-serif, system-ui, sans-serif; }
    .auth-proof { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 44px; }
    .proof-item { border-top: 1px solid rgba(248,242,229,.28); padding-top: 12px; }
    .proof-value { display: block; font: 700 20px/1.1 ui-serif, Georgia, serif; }
    .proof-label { display: block; margin-top: 4px; color: rgba(248,242,229,.66); font: 12px/1.35 ui-sans-serif, system-ui, sans-serif; }
    .auth-form-panel { padding: clamp(26px, 5vw, 58px); display: flex; flex-direction: column; justify-content: center; background: #fbfaf6; }
    .title { margin: 8px 0 0; font-size: clamp(32px, 4vw, 48px); line-height: .98; letter-spacing: 0; }
    .subtitle { margin: 14px 0 0; color: #596154; font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; }
    .auth-panel { margin: 28px 0 0; padding: 0; border: 0; background: transparent; }
    .tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 4px; background: #e7e2d5; border-radius: 8px; margin: 0 0 22px; }
    .tabs button { width: 100%; margin: 0; min-height: 42px; background: transparent; color: #4c554b; font: 700 14px/1 ui-sans-serif, system-ui, sans-serif; }
    .tabs button.active { background: #fbfaf6; color: #162a2a; box-shadow: 0 1px 4px rgba(29,33,27,.14); }
    .social-action {
      width: 100%;
      min-height: 48px;
      margin: 0 0 16px;
      border: 1px solid #c8c1b4;
      border-radius: 8px;
      background: #fffefb;
      color: #1d211b;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      font: 800 14px/1 ui-sans-serif, system-ui, sans-serif;
      box-shadow: 0 8px 18px rgba(29,33,27,.08);
      transition: border-color .18s ease, transform .18s ease, box-shadow .18s ease;
    }
    .social-action:hover { transform: translateY(-1px); border-color: #245c63; box-shadow: 0 12px 24px rgba(29,33,27,.12); }
    .google-mark { width: 18px; height: 18px; display: inline-block; }
    .auth-divider { display: flex; align-items: center; gap: 10px; margin: 0 0 16px; color: #858a80; font: 700 11px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; }
    .auth-divider::before, .auth-divider::after { content: ""; height: 1px; flex: 1; background: #ded8cb; }
    .field { margin-top: 15px; color: #2f352d; font: 700 13px/1.35 ui-sans-serif, system-ui, sans-serif; }
    .field input {
      min-height: 48px;
      margin-top: 7px;
      padding: 12px 13px;
      border: 1px solid #c8c1b4;
      border-radius: 8px;
      background: #fffefb;
      color: #1d211b;
      font: 16px/1.3 ui-sans-serif, system-ui, sans-serif;
      outline: none;
      transition: border-color .18s ease, box-shadow .18s ease, background .18s ease;
    }
    .field input:focus { border-color: #245c63; box-shadow: 0 0 0 4px rgba(36,92,99,.14); background: #fff; }
    .field-note { margin: 7px 0 0; color: #747b70; font: 12px/1.45 ui-sans-serif, system-ui, sans-serif; }
    .actions { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 14px; margin-top: 22px; }
    .primary-action {
      width: 100%;
      min-height: 48px;
      margin: 0;
      border-radius: 8px;
      background: #162a2a;
      color: #fff8e8;
      font: 800 15px/1 ui-sans-serif, system-ui, sans-serif;
      box-shadow: 0 12px 26px rgba(22,42,42,.22);
      transition: transform .18s ease, box-shadow .18s ease, background .18s ease;
    }
    .primary-action:hover { transform: translateY(-1px); background: #224e5b; box-shadow: 0 16px 32px rgba(22,42,42,.25); }
    .primary-action:disabled { transform: none; box-shadow: none; }
    .link-button { background: transparent; color: #7a432e; padding: 0; margin: 0; border: 0; width: auto; font: 700 13px/1.2 ui-sans-serif, system-ui, sans-serif; text-align: right; }
    .alert { display: none; margin-top: 16px; padding: 12px 13px; border-radius: 8px; background: #fff1cd; color: #66450a; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; }
    .alert.error { background: #ffe9e0; color: #7a2518; }
    .cli-note {
      display: none;
      margin: 18px 0 0;
      padding: 12px 13px;
      border: 1px solid rgba(36,92,99,.22);
      border-radius: 8px;
      background: #eef6f1;
      color: #254137;
      font: 13px/1.45 ui-sans-serif, system-ui, sans-serif;
    }
    .cli-note.is-visible { display: block; }
    .auth-footnote { margin: 22px 0 0; color: #71786e; font: 12px/1.55 ui-sans-serif, system-ui, sans-serif; }
    .notice, .success { margin-top: 14px; padding: 12px; border-radius: 6px; }
    .notice.success, .success { background: #e8f5ee; color: #163f2a; }
    .notice.warning { background: #fff2d8; color: #5d3d00; }
    .success { display: none; }
    .success code { margin-top: 8px; background: #d9eee3; color: #163f2a; font: 700 20px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; text-align: center; }
    @media (max-width: 820px) {
      .auth-page { padding: 0; place-items: stretch; }
      .auth-layout { min-height: 100vh; grid-template-columns: 1fr; border: 0; border-radius: 0; }
      .auth-story { min-height: 260px; padding: 28px; }
      .story-title { max-width: 11ch; margin-top: 44px; font-size: clamp(40px, 13vw, 62px); }
      .story-copy { font-size: 15px; }
      .auth-proof { grid-template-columns: 1fr 1fr 1fr; margin-top: 28px; }
      .proof-value { font-size: 17px; }
      .auth-form-panel { padding: 28px; justify-content: start; }
    }
    @media (max-width: 480px) {
      .auth-proof { display: none; }
      .actions { grid-template-columns: 1fr; }
      .link-button { text-align: left; }
    }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function loginPage(cliSession: string, neonAuthBaseUrl: string): string {
  return `
    <main class="auth-page">
      <section class="auth-layout" aria-label="Granite Cloud authentication">
        <div class="auth-story" aria-hidden="true">
          <div class="brand">
            <div class="mark">G</div>
            <p class="brand-word">Granite Cloud</p>
          </div>
          <div>
            <p class="story-kicker">Private MCP vaults</p>
            <h1 class="story-title">Local knowledge, hosted carefully.</h1>
            <p class="story-copy">Sign in to manage paid cloud vaults, import markdown archives, and connect Granite to remote MCP clients without giving up explicit vault boundaries.</p>
          </div>
          <div class="auth-proof">
            <span class="proof-item"><span class="proof-value">R2</span><span class="proof-label">vault storage</span></span>
            <span class="proof-item"><span class="proof-value">DO</span><span class="proof-label">per-vault runtime</span></span>
            <span class="proof-item"><span class="proof-value">MCP</span><span class="proof-label">private endpoint</span></span>
          </div>
        </div>
        <div class="auth-form-panel">
          <p class="eyebrow">Granite Cloud</p>
          <h2 class="title" id="auth-title">Sign in</h2>
          <p class="subtitle">Use your email and password. Accounts are backed by Neon Auth's Better Auth email/password flow.</p>
          <div id="cli-note" class="cli-note">After signing in, paste the verification code shown here back into the Granite CLI.</div>
          <div class="auth-panel">
          <div class="tabs" role="tablist" aria-label="Auth mode">
            <button id="tab-signin" class="active" type="button" role="tab" aria-selected="true" aria-controls="auth-form">Sign in</button>
            <button id="tab-signup" type="button" role="tab" aria-selected="false" aria-controls="auth-form" tabindex="-1">Create account</button>
          </div>
          <button id="google-auth" class="social-action" type="button">
            <svg class="google-mark" viewBox="0 0 18 18" aria-hidden="true">
              <path fill="#4285f4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z"/>
              <path fill="#34a853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.8.54-1.83.86-3.05.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.33A9 9 0 0 0 9 18z"/>
              <path fill="#fbbc05" d="M3.97 10.71A5.41 5.41 0 0 1 3.69 9c0-.59.1-1.16.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.04l3.01-2.33z"/>
              <path fill="#ea4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.9 11.42 0 9 0A9 9 0 0 0 .96 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
            </svg>
            Continue with Google
          </button>
          <div class="auth-divider">or use email</div>
          <form id="auth-form" aria-labelledby="auth-title">
            <label id="name-label" class="field" hidden>Name
              <input id="name" name="name" autocomplete="name" placeholder="Ada Lovelace">
            </label>
            <label class="field">Email
              <input id="email" name="email" type="email" autocomplete="email" inputmode="email" placeholder="you@company.com" required>
            </label>
            <label class="field">Password
              <input id="password" name="password" type="password" autocomplete="current-password" placeholder="At least 8 characters" required>
            </label>
            <p id="password-note" class="field-note" hidden>Better Auth requires a password of at least 8 characters for new accounts.</p>
            <div class="actions">
              <button id="submit" class="primary-action" type="submit">Sign in</button>
              <button id="reset" class="link-button" type="button">Reset password</button>
            </div>
            <p id="alert" class="alert" role="alert"></p>
            <div id="success" class="success" role="status" aria-live="polite"></div>
          </form>
        </div>
          <p class="auth-footnote">Passwords and reset emails are handled by the configured Neon Auth project. Granite stores only the resulting web session and API-key metadata.</p>
        </div>
      </section>
    </main>
    <script>
      const cliSession = ${scriptJson(cliSession)};
      const neonAuthBaseUrl = ${scriptJson(neonAuthBaseUrl)};
      let mode = 'signin';
      const authTitle = document.getElementById('auth-title');
      const form = document.getElementById('auth-form');
      const tabSignin = document.getElementById('tab-signin');
      const tabSignup = document.getElementById('tab-signup');
      const googleAuth = document.getElementById('google-auth');
      const cliNote = document.getElementById('cli-note');
      const nameLabel = document.getElementById('name-label');
      const nameInput = document.getElementById('name');
      const emailInput = document.getElementById('email');
      const passwordInput = document.getElementById('password');
      const passwordNote = document.getElementById('password-note');
      const submit = document.getElementById('submit');
      const reset = document.getElementById('reset');
      const alertBox = document.getElementById('alert');
      const successBox = document.getElementById('success');
      const requiredNodes = [
        authTitle,
        form,
        tabSignin,
        tabSignup,
        googleAuth,
        cliNote,
        nameLabel,
        nameInput,
        emailInput,
        passwordInput,
        passwordNote,
        submit,
        reset,
        alertBox,
        successBox
      ];

      if (requiredNodes.some((node) => !node)) {
        console.error('Login form failed to initialize.');
      } else {
        tabSignin.addEventListener('click', () => setMode('signin'));
        tabSignup.addEventListener('click', () => setMode('signup'));
        tabSignin.addEventListener('keydown', handleTabKey);
        tabSignup.addEventListener('keydown', handleTabKey);
        googleAuth.addEventListener('click', signInWithGoogle);
        reset.addEventListener('click', requestReset);
        form.addEventListener('submit', submitAuth);
        cliNote.classList.toggle('is-visible', Boolean(cliSession));
        if (!showOAuthCallbackError()) completeNeonRedirectSession();
      }

      function handleTabKey(event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const next = mode === 'signin' ? 'signup' : 'signin';
        setMode(next);
        (next === 'signin' ? tabSignin : tabSignup).focus();
      }

      function setMode(next) {
        mode = next;
        const signup = mode === 'signup';
        tabSignin.classList.toggle('active', !signup);
        tabSignup.classList.toggle('active', signup);
        tabSignin.setAttribute('aria-selected', String(!signup));
        tabSignup.setAttribute('aria-selected', String(signup));
        tabSignin.tabIndex = signup ? -1 : 0;
        tabSignup.tabIndex = signup ? 0 : -1;
        nameLabel.hidden = !signup;
        nameInput.required = signup;
        passwordInput.autocomplete = signup ? 'new-password' : 'current-password';
        passwordInput.minLength = signup ? 8 : 0;
        passwordNote.hidden = !signup;
        authTitle.textContent = signup ? 'Create account' : 'Sign in';
        submit.textContent = signup ? 'Create account' : 'Sign in';
        clearMessage();
      }

      async function submitAuth(event) {
        event.preventDefault();
        clearMessage();
        submit.disabled = true;
        try {
          const endpoint = mode === 'signup' ? '/auth/neon/signup' : '/auth/neon/email';
          const payload = {
            email: emailInput.value.trim(),
            password: passwordInput.value,
            cli_session: cliSession
          };
          if (mode === 'signup') payload.name = nameInput.value.trim() || emailInput.value.trim();

          const graniteResponse = await fetch(endpoint, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (!graniteResponse.ok) throw new Error(await errorMessage(graniteResponse));

          if (cliSession) {
            const cli = await graniteResponse.json();
            if (cli.cli_expired) {
              showError('CLI login session expired. Run granite cloud login again.');
              return;
            }
            if (!cli.verification_code) {
              window.location.assign('/app');
              return;
            }
            successBox.style.display = 'block';
            successBox.innerHTML = '<strong>CLI verification code</strong><code>' + escapeHtml(cli.verification_code) + '</code>';
            return;
          }

          window.location.assign('/app');
        } catch (error) {
          showError(error instanceof Error ? error.message : String(error));
        } finally {
          submit.disabled = false;
        }
      }

      async function signInWithGoogle() {
        clearMessage();
        if (!neonAuthBaseUrl) return showError('Google sign-in is not configured.');
        googleAuth.disabled = true;
        try {
          const authUrl = trimTrailingSlash(neonAuthBaseUrl) + '/sign-in/social';
          const response = await fetch(authUrl, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              provider: 'google',
              callbackURL: cleanAuthCallbackPath(),
              errorCallbackURL: '/app/login',
              newUserCallbackURL: cleanAuthCallbackPath()
            })
          });
          if (!response.ok) throw new Error(await errorMessage(response));
          const body = await response.json();
          if (body && body.url) {
            window.location.assign(body.url);
            return;
          }
          throw new Error('Google sign-in did not return a redirect URL.');
        } catch (error) {
          googleAuth.disabled = false;
          showError(error instanceof Error ? error.message : String(error));
        }
      }

      async function completeNeonRedirectSession() {
        if (!neonAuthBaseUrl) return;
        try {
          const hasVerifier = new URLSearchParams(window.location.search).has('neon_auth_session_verifier');
          const tokenResponse = await fetch(neonSessionUrl(), {
            credentials: 'include',
            headers: { Accept: 'application/json' }
          });
          if (!tokenResponse.ok) {
            if (hasVerifier) throw new Error(await errorMessage(tokenResponse));
            return;
          }
          const token = tokenResponse.headers.get('set-auth-jwt') || await tokenFromJson(tokenResponse.clone());
          if (!token) {
            if (hasVerifier) throw new Error('Could not establish a Google session. Please try again.');
            return;
          }
          const graniteResponse = await fetch('/auth/neon/session', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, cli_session: cliSession })
          });
          if (!graniteResponse.ok) throw new Error(await errorMessage(graniteResponse));
          if (cliSession) {
            const cli = await graniteResponse.json();
            if (cli.cli_expired) {
              showError('CLI login session expired. Run granite cloud login again.');
              return;
            }
            if (cli.verification_code) {
              successBox.style.display = 'block';
              successBox.innerHTML = '<strong>CLI verification code</strong><code>' + escapeHtml(cli.verification_code) + '</code>';
              return;
            }
          }
          clearAuthCallbackParams();
          window.location.assign('/app');
        } catch (error) {
          showError(error instanceof Error ? error.message : String(error));
        }
      }

      function showOAuthCallbackError() {
        const params = new URLSearchParams(window.location.search);
        if (!params.has('error') && !params.has('error_description')) return false;
        const description = params.get('error_description') || params.get('error') || 'Google sign-in failed.';
        showError('Google sign-in failed: ' + description);
        clearAuthCallbackParams();
        return true;
      }

      async function tokenFromJson(response) {
        try {
          const body = await response.json();
          for (const key of ['token', 'jwt', 'accessToken', 'access_token']) {
            if (body && typeof body[key] === 'string' && body[key]) return body[key];
          }
        } catch {}
        return '';
      }

      async function requestReset() {
        clearMessage();
        if (!emailInput.value.trim()) return showError('Enter your email first.');
        reset.disabled = true;
        try {
          const response = await fetch('/auth/neon/reset', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: emailInput.value.trim(),
              redirectTo: window.location.origin + '/app/login'
            })
          });
          if (!response.ok) throw new Error(await errorMessage(response));
          alertBox.className = 'alert';
          alertBox.textContent = 'Password reset email sent.';
          alertBox.style.display = 'block';
        } catch (error) {
          showError(error instanceof Error ? error.message : String(error));
        } finally {
          reset.disabled = false;
        }
      }

      async function errorMessage(response) {
        try {
          const body = await response.json();
          if (body && typeof body === 'object') {
            return body.message || body.error || response.statusText;
          }
          if (typeof body === 'string') return body || response.statusText;
          return response.statusText || 'Request failed.';
        } catch {
          return response.statusText || 'Request failed.';
        }
      }

      function clearMessage() {
        alertBox.style.display = 'none';
        successBox.style.display = 'none';
      }

      function trimTrailingSlash(value) {
        return String(value).replace(/\\/+$/, '');
      }

      function neonSessionUrl() {
        const base = trimTrailingSlash(neonAuthBaseUrl);
        const verifier = new URLSearchParams(window.location.search).get('neon_auth_session_verifier');
        if (!verifier) return base + '/token';
        return base + '/get-session?neon_auth_session_verifier=' + encodeURIComponent(verifier);
      }

      function cleanAuthCallbackPath() {
        const url = new URL(window.location.href);
        url.searchParams.delete('neon_auth_session_verifier');
        url.searchParams.delete('error');
        url.searchParams.delete('error_description');
        return url.pathname + url.search;
      }

      function clearAuthCallbackParams() {
        const url = new URL(window.location.href);
        url.searchParams.delete('neon_auth_session_verifier');
        url.searchParams.delete('error');
        url.searchParams.delete('error_description');
        window.history.replaceState({}, '', url.pathname + url.search);
      }

      function showError(message) {
        alertBox.className = 'alert error';
        alertBox.textContent = message;
        alertBox.style.display = 'block';
      }

      function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (char) => ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;'
        })[char]);
      }
    </script>
  `;
}

function safeName(value: string | undefined): string {
  return (value?.trim() || 'Cloud Vault').slice(0, 100);
}

function safeKeyName(value: string | undefined): string {
  return (value?.trim() || 'mcp-client').slice(0, 80);
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

function scriptJson(value: string): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => ({
    '<': '\\u003c',
    '>': '\\u003e',
    '&': '\\u0026',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029',
  }[char]!));
}

export default dashboard;
