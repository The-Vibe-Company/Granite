import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { AppVariables, Env, VaultRow } from '../env.js';
import { database } from '../db.js';
import { currentWebUser } from '../neon-auth.js';
import { ensureStripeCustomer, stripeBilling } from '../billing.js';

type Bindings = { Bindings: Env; Variables: AppVariables };

const dashboard = new Hono<Bindings>();

dashboard.get('/app/login', async (c) => {
  return c.html(page('Login', loginPage(c.req.query('cli_session') ?? '')));
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
  const checkout = c.req.query('checkout') ?? '';
  const checkoutMessage = checkout === 'success'
    ? '<p class="notice success" role="status">Checkout complete. Your vault will become writable as soon as Stripe confirms the subscription.</p>'
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
    </main>
  `));
});

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
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; color: #151515; background: #f7f7f4; }
    main { max-width: 840px; margin: 0 auto; padding: 40px 20px; }
    form, article, .auth-panel { background: white; border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin: 16px 0; }
    input, button { display: block; width: 100%; margin-top: 8px; padding: 10px; font: inherit; }
    button { width: auto; background: #111; color: white; border: 0; border-radius: 6px; cursor: pointer; }
    button.secondary { background: #eef0ea; color: #151515; }
    button:disabled { cursor: wait; opacity: 0.65; }
    label { display: block; margin-top: 14px; font-weight: 600; }
    input { border: 1px solid #bdbdb8; border-radius: 6px; background: #fff; }
    code { display: block; overflow-wrap: anywhere; background: #f1f1ec; padding: 8px; border-radius: 6px; }
    .auth-shell { min-height: 100vh; display: grid; place-items: center; padding: 28px; }
    .auth-card { width: min(440px, 100%); }
    .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
    .mark { width: 32px; height: 32px; border-radius: 7px; background: #111; color: white; display: grid; place-items: center; font-weight: 800; }
    .eyebrow { margin: 0; color: #696a61; font-size: 14px; }
    .title { margin: 4px 0 0; font-size: 28px; line-height: 1.1; }
    .tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 4px; background: #eef0ea; border-radius: 8px; margin: 18px 0; }
    .tabs button { width: 100%; margin: 0; background: transparent; color: #333; }
    .tabs button.active { background: white; color: #111; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
    .actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 18px; }
    .link-button { background: transparent; color: #3758c8; padding: 0; margin: 0; border: 0; width: auto; }
    .alert { display: none; margin-top: 14px; padding: 10px 12px; border-radius: 6px; background: #fff2d8; color: #5d3d00; }
    .alert.error { background: #ffe5e2; color: #7a1f13; }
    .notice, .success { margin-top: 14px; padding: 12px; border-radius: 6px; }
    .notice.success, .success { background: #e8f5ee; color: #163f2a; }
    .notice.warning { background: #fff2d8; color: #5d3d00; }
    .success { display: none; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function loginPage(cliSession: string): string {
  return `
    <main class="auth-shell">
      <section class="auth-card">
        <div class="brand">
          <div class="mark">G</div>
          <div>
            <p class="eyebrow">Granite Cloud</p>
            <h1 class="title">Sign in</h1>
          </div>
        </div>
        <div class="auth-panel">
          <div class="tabs" role="tablist" aria-label="Auth mode">
            <button id="tab-signin" class="active" type="button" role="tab" aria-selected="true" aria-controls="auth-form">Sign in</button>
            <button id="tab-signup" type="button" role="tab" aria-selected="false" aria-controls="auth-form" tabindex="-1">Create account</button>
          </div>
          <form id="auth-form">
            <label id="name-label" hidden>Name
              <input id="name" name="name" autocomplete="name">
            </label>
            <label>Email
              <input id="email" name="email" type="email" autocomplete="email" required>
            </label>
            <label>Password
              <input id="password" name="password" type="password" autocomplete="current-password" required>
            </label>
            <div class="actions">
              <button id="submit" type="submit">Sign in</button>
              <button id="reset" class="link-button" type="button">Reset password</button>
            </div>
            <p id="alert" class="alert" role="alert"></p>
            <div id="success" class="success" role="status" aria-live="polite"></div>
          </form>
        </div>
      </section>
    </main>
    <script>
      const cliSession = ${scriptJson(cliSession)};
      let mode = 'signin';
      const form = document.getElementById('auth-form');
      const tabSignin = document.getElementById('tab-signin');
      const tabSignup = document.getElementById('tab-signup');
      const nameLabel = document.getElementById('name-label');
      const nameInput = document.getElementById('name');
      const emailInput = document.getElementById('email');
      const passwordInput = document.getElementById('password');
      const submit = document.getElementById('submit');
      const reset = document.getElementById('reset');
      const alertBox = document.getElementById('alert');
      const successBox = document.getElementById('success');
      const requiredNodes = [
        form,
        tabSignin,
        tabSignup,
        nameLabel,
        nameInput,
        emailInput,
        passwordInput,
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
        reset.addEventListener('click', requestReset);
        form.addEventListener('submit', submitAuth);
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
