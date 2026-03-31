import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { Env } from '../env.js';
import { generateApiKey, getKeyPrefix, hashApiKey } from '../lib/api-key.js';
import { timingSafeEqual } from '../lib/stripe.js';

interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
}

interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function signState(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${payload}.${sigHex}`;
}

async function verifyState(signed: string, secret: string): Promise<string | null> {
  const dotIdx = signed.lastIndexOf('.');
  if (dotIdx < 0) return null;
  const payload = signed.slice(0, dotIdx);
  const sig = signed.slice(dotIdx + 1);
  const expected = await signState(payload, secret);
  const expectedSig = expected.slice(expected.lastIndexOf('.') + 1);
  if (!timingSafeEqual(sig, expectedSig)) return null;
  return payload;
}

const auth = new Hono<{ Bindings: Env }>();

/**
 * GET /auth/github — Start GitHub OAuth flow.
 * Query params:
 *   - session: CLI session ID for polling (optional, for CLI flow)
 *   - redirect: URL to redirect to after auth (optional, for web flow)
 */
auth.get('/auth/github', async (c) => {
  const clientId = c.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return c.json({ error: 'GitHub OAuth not configured' }, 503);
  }

  const session = c.req.query('session') || '';
  const redirect = c.req.query('redirect') || '';

  const payload = btoa(JSON.stringify({ session, redirect }));
  const state = await signState(payload, c.env.GITHUB_CLIENT_SECRET);

  const githubAuthUrl = new URL('https://github.com/login/oauth/authorize');
  githubAuthUrl.searchParams.set('client_id', clientId);
  githubAuthUrl.searchParams.set('scope', 'read:user user:email');
  githubAuthUrl.searchParams.set('state', state);
  githubAuthUrl.searchParams.set('redirect_uri', `${c.env.BASE_URL}/auth/callback`);

  return c.redirect(githubAuthUrl.toString());
});

/**
 * GET /auth/callback — GitHub OAuth callback.
 * Exchanges code for token, creates/updates user, generates API key.
 */
auth.get('/auth/callback', async (c) => {
  const code = c.req.query('code');
  const stateParam = c.req.query('state') || '';

  if (!code) {
    return c.json({ error: 'Missing authorization code' }, 400);
  }

  let session = '';
  let redirect = '';

  const verifiedPayload = await verifyState(stateParam, c.env.GITHUB_CLIENT_SECRET);
  if (!verifiedPayload) {
    return c.json({ error: 'Invalid or tampered state parameter' }, 400);
  }

  try {
    const parsed = JSON.parse(atob(verifiedPayload));
    session = parsed.session || '';
    redirect = parsed.redirect || '';
  } catch {
    // Invalid state payload, continue without session/redirect
  }

  // Exchange code for access token
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const tokenData = (await tokenResponse.json()) as GitHubTokenResponse;
  if (!tokenData.access_token) {
    return c.json({ error: 'Failed to exchange code for token' }, 400);
  }

  // Fetch GitHub user info
  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `Bearer ${tokenData.access_token}`,
      'User-Agent': 'granite-cloud',
      'Accept': 'application/vnd.github+json',
    },
  });

  if (!userResponse.ok) {
    return c.json({ error: 'Failed to fetch GitHub user info' }, 500);
  }

  const ghUser = (await userResponse.json()) as GitHubUser;

  // If no public email, fetch from emails endpoint
  let email = ghUser.email;
  if (!email) {
    try {
      const emailsResponse = await fetch('https://api.github.com/user/emails', {
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'User-Agent': 'granite-cloud',
          'Accept': 'application/vnd.github+json',
        },
      });
      if (emailsResponse.ok) {
        const emails = (await emailsResponse.json()) as Array<{ email: string; primary: boolean }>;
        const primary = emails.find(e => e.primary);
        email = primary?.email || emails[0]?.email || null;
      }
    } catch {
      // Non-critical, continue without email
    }
  }

  // Upsert user
  const existingUser = await c.env.DB.prepare(
    'SELECT id, tier FROM users WHERE github_id = ?',
  ).bind(ghUser.id).first<{ id: string; tier: string }>();

  let userId: string;
  let tier: string;

  if (existingUser) {
    userId = existingUser.id;
    tier = existingUser.tier;
    await c.env.DB.prepare(`
      UPDATE users SET github_username = ?, email = COALESCE(?, email), updated_at = datetime('now')
      WHERE id = ?
    `).bind(ghUser.login, email, userId).run();
  } else {
    userId = nanoid(16);
    tier = 'free';
    await c.env.DB.prepare(`
      INSERT INTO users (id, github_id, github_username, email, tier)
      VALUES (?, ?, ?, ?, ?)
    `).bind(userId, ghUser.id, ghUser.login, email, tier).run();

    // Create a default vault for new users
    const vaultId = `v_${nanoid(12)}`;
    await c.env.DB.prepare(`
      INSERT INTO vaults (vault_id, user_id, vault_name)
      VALUES (?, ?, ?)
    `).bind(vaultId, userId, `${ghUser.login}'s vault`).run();
  }

  // Generate API key
  const apiKey = generateApiKey();
  const keyHash = await hashApiKey(apiKey);
  const keyPrefix = getKeyPrefix(apiKey);

  await c.env.DB.prepare(`
    INSERT INTO api_keys (key_hash, user_id, key_prefix, name)
    VALUES (?, ?, ?, 'default')
  `).bind(keyHash, userId, keyPrefix).run();

  // If CLI session, store API key for polling
  if (session) {
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await c.env.DB.prepare(`
      INSERT OR REPLACE INTO auth_sessions (session_id, api_key, username, expires_at)
      VALUES (?, ?, ?, ?)
    `).bind(session, apiKey, ghUser.login, expiresAt).run();
  }

  // If web redirect (only allow same-origin redirects)
  if (redirect) {
    try {
      const url = new URL(redirect, c.env.BASE_URL);
      if (url.origin === new URL(c.env.BASE_URL).origin) {
        url.searchParams.set('key', apiKey);
        return c.redirect(url.pathname + url.search);
      }
    } catch {
      // Invalid URL, fall through to success page
    }
  }

  // Default: show success page with API key
  const safeLogin = escapeHtml(ghUser.login);
  const safeKey = escapeHtml(apiKey);
  const safeTier = escapeHtml(tier);
  const safeBaseUrl = escapeHtml(c.env.BASE_URL);

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Granite Cloud - Logged in</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 80px auto; padding: 0 20px; color: #1a1a1a; }
  .key { background: #f5f5f5; padding: 12px 16px; border-radius: 8px; font-family: monospace; font-size: 14px; word-break: break-all; }
  .copy-btn { margin-top: 12px; padding: 8px 16px; background: #1a1a1a; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
  .copy-btn:hover { background: #333; }
  .copy-btn:focus-visible { outline: 2px solid #005fcc; outline-offset: 2px; }
  .warning { color: #555; font-size: 13px; margin-top: 8px; }
  pre { background: #f5f5f5; padding: 12px; border-radius: 8px; font-size: 13px; overflow-x: auto; }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #e5e5e5; }
    .key, pre { background: #2a2a2a; }
    .copy-btn { background: #e5e5e5; color: #1a1a1a; }
    .copy-btn:hover { background: #ccc; }
    .warning { color: #999; }
    code { color: #e5e5e5; }
  }
</style></head>
<body>
  <main>
    <h1>Welcome, @${safeLogin}!</h1>
    <p>Your Granite Cloud account is set up (${safeTier} tier). Here's your API key:</p>
    <div class="key" id="key" role="status">${safeKey}</div>
    <button class="copy-btn" id="copy-btn">Copy to clipboard</button>
    <script>document.getElementById('copy-btn').addEventListener('click',function(){navigator.clipboard.writeText(document.getElementById('key').textContent);this.textContent='Copied!'});</script>
    <p class="warning">This key is shown only once. Save it now.</p>
    <p>If you used <code>mem cloud login</code>, the CLI has already picked it up. You can close this tab.</p>
    <p>Add to your <code>granite.yml</code>:</p>
    <pre>sync:
  server: ${safeBaseUrl}
  api_key: ${safeKey}</pre>
  </main>
</body></html>`;

  return c.html(html);
});

/**
 * GET /auth/poll — CLI polls this to retrieve the API key after OAuth.
 */
auth.get('/auth/poll', async (c) => {
  const session = c.req.query('session');
  if (!session) {
    return c.json({ error: 'Missing session parameter' }, 400);
  }

  const result = await c.env.DB.prepare(
    "SELECT api_key, username FROM auth_sessions WHERE session_id = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
  ).bind(session).first<{ api_key: string; username: string }>();

  if (!result || !result.api_key) {
    return c.json({ status: 'waiting' }, 202);
  }

  // Delete session after retrieval
  c.executionCtx.waitUntil(
    c.env.DB.prepare('DELETE FROM auth_sessions WHERE session_id = ?')
      .bind(session).run(),
  );

  return c.json({
    api_key: result.api_key,
    username: result.username,
  }, 200);
});

export default auth;
