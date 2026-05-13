import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { AppVariables, Env } from '../env.js';
import { generateApiKey, getKeyPrefix, hashApiKey } from '../lib/api-key.js';

interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
}

interface GitHubTokenResponse {
  access_token: string;
}

type Bindings = { Bindings: Env; Variables: AppVariables };

const auth = new Hono<Bindings>();

auth.post('/auth/start', async (c) => {
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
    return c.json({ error: 'GitHub OAuth is not configured.' }, 503);
  }

  const body = await c.req.json().catch(() => null) as { session?: string; poll_secret?: string } | null;
  const session = body?.session?.trim() ?? '';
  const pollSecret = body?.poll_secret?.trim() ?? '';
  if (!session || !pollSecret) return c.json({ error: 'Missing login session.' }, 400);

  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await c.env.ACCOUNTS_DB.prepare(`
    INSERT OR REPLACE INTO auth_sessions (session_id, poll_secret_hash, expires_at)
    VALUES (?, ?, ?)
  `).bind(session, await hashApiKey(pollSecret), expiresAt).run();

  return c.json({
    login_url: `${c.env.BASE_URL}/auth/github?session=${encodeURIComponent(session)}`,
    expires_at: expiresAt,
  });
});

auth.get('/auth/github', async (c) => {
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
    return c.json({ error: 'GitHub OAuth is not configured.' }, 503);
  }

  const session = c.req.query('session') || '';
  const existing = await c.env.ACCOUNTS_DB.prepare(`
    SELECT session_id
    FROM auth_sessions
    WHERE session_id = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).bind(session).first<{ session_id: string }>();
  if (!existing) return c.json({ error: 'Login session expired or not found.' }, 404);

  const state = await signState(session, c.env.GITHUB_CLIENT_SECRET);
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', `${c.env.BASE_URL}/auth/callback`);
  return c.redirect(url.toString());
});

auth.get('/auth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state') || '';
  if (!code) return c.json({ error: 'Missing authorization code.' }, 400);
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
    return c.json({ error: 'GitHub OAuth is not configured.' }, 503);
  }

  const session = await verifyState(state, c.env.GITHUB_CLIENT_SECRET);
  if (session === null) return c.json({ error: 'Invalid OAuth state.' }, 400);

  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  const token = await tokenResponse.json() as GitHubTokenResponse;
  if (!token.access_token) return c.json({ error: 'Failed to exchange GitHub OAuth code.' }, 400);

  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `Bearer ${token.access_token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'granite-cloudflare-mcp',
    },
  });
  if (!userResponse.ok) return c.json({ error: 'Failed to fetch GitHub user.' }, 500);
  const ghUser = await userResponse.json() as GitHubUser;

  const existing = await c.env.ACCOUNTS_DB.prepare(
    'SELECT id FROM users WHERE github_id = ?',
  ).bind(ghUser.id).first<{ id: string }>();

  const userId = existing?.id ?? nanoid(16);
  if (existing) {
    await c.env.ACCOUNTS_DB.prepare(`
      UPDATE users
      SET github_username = ?, email = COALESCE(?, email), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind(ghUser.login, ghUser.email, userId).run();
  } else {
    await c.env.ACCOUNTS_DB.prepare(`
      INSERT INTO users (id, github_id, github_username, email)
      VALUES (?, ?, ?, ?)
    `).bind(userId, ghUser.id, ghUser.login, ghUser.email).run();

    await c.env.ACCOUNTS_DB.prepare(`
      INSERT INTO vaults (vault_id, user_id, vault_name)
      VALUES (?, ?, ?)
    `).bind(`v_${nanoid(12)}`, userId, `${ghUser.login}'s vault`).run();
  }

  const apiKey = generateApiKey();
  await c.env.ACCOUNTS_DB.prepare(`
    INSERT INTO api_keys (key_hash, user_id, key_prefix, name)
    VALUES (?, ?, ?, 'oauth-login')
  `).bind(await hashApiKey(apiKey), userId, getKeyPrefix(apiKey)).run();

  if (session) {
    const verificationCode = generateVerificationCode();
    await c.env.ACCOUNTS_DB.prepare(`
      UPDATE auth_sessions
      SET api_key = ?, username = ?, verification_code_hash = ?
      WHERE session_id = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `).bind(apiKey, ghUser.login, await hashApiKey(verificationCode), session).run();
    return c.html(successPage(ghUser.login, verificationCode));
  }

  return c.html(successPage(ghUser.login));
});

auth.post('/auth/poll', async (c) => {
  const body = await c.req.json().catch(() => null) as {
    session?: string;
    poll_secret?: string;
    verification_code?: string;
  } | null;
  const session = body?.session?.trim() ?? '';
  const pollSecret = body?.poll_secret?.trim() ?? '';
  const verificationCode = body?.verification_code?.trim() ?? '';
  if (!session || !pollSecret || !verificationCode) return c.json({ error: 'Missing login verification.' }, 400);

  const row = await c.env.ACCOUNTS_DB.prepare(`
    SELECT api_key, username, poll_secret_hash, verification_code_hash
    FROM auth_sessions
    WHERE session_id = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).bind(session).first<{
    api_key: string | null;
    username: string | null;
    poll_secret_hash: string;
    verification_code_hash: string | null;
  }>();

  if (!row) return c.json({ pending: true }, 202);
  if (!timingSafeEqual(await hashApiKey(pollSecret), row.poll_secret_hash)) {
    return c.json({ error: 'Invalid login verification.' }, 401);
  }
  if (!row.api_key || !row.username || !row.verification_code_hash) {
    return c.json({ pending: true }, 202);
  }
  if (!timingSafeEqual(await hashApiKey(verificationCode), row.verification_code_hash)) {
    return c.json({ error: 'Invalid login verification.' }, 401);
  }
  await c.env.ACCOUNTS_DB.prepare('DELETE FROM auth_sessions WHERE session_id = ?').bind(session).run();
  return c.json({ api_key: row.api_key, username: row.username });
});

async function signState(session: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(session));
  return `${encodeURIComponent(session)}.${hex(signature)}`;
}

async function verifyState(state: string, secret: string): Promise<string | null> {
  const dot = state.lastIndexOf('.');
  if (dot < 0) return null;
  let session: string;
  try {
    session = decodeURIComponent(state.slice(0, dot));
  } catch {
    return null;
  }
  const expected = await signState(session, secret);
  return timingSafeEqual(state.slice(dot + 1), expected.slice(expected.lastIndexOf('.') + 1)) ? session : null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function generateVerificationCode(): string {
  return nanoid(10).toUpperCase();
}

function successPage(username: string, verificationCode?: string): string {
  const body = verificationCode
    ? `<p>Enter this verification code in your Granite CLI:</p>
  <pre>${escapeHtml(verificationCode)}</pre>`
    : '<p>Login completed.</p>';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Granite Cloud MCP</title></head>
<body>
  <h1>Granite Cloud MCP</h1>
  <p>Logged in as ${escapeHtml(username)}.</p>
  ${body}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default auth;
