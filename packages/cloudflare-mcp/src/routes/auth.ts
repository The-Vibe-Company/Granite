import { Hono, type Context } from 'hono';
import { nanoid } from 'nanoid';
import type { AppVariables, Env } from '../env.js';
import { database, upsertNeonUser } from '../db.js';
import { generateApiKey, getKeyPrefix, hashApiKey } from '../lib/api-key.js';
import { createWebSession, verifyNeonJwt } from '../neon-auth.js';

type Bindings = { Bindings: Env; Variables: AppVariables };

const auth = new Hono<Bindings>();
const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
const AUTH_RATE_LIMIT_MAX_ATTEMPTS = 20;
const AUTH_RATE_LIMIT_MAX_POLL_ATTEMPTS = 180;
const AUTH_RATE_LIMIT_CLEANUP_MS = 300_000;
let lastAuthRateLimitCleanup = 0;

auth.post('/auth/neon/session', async (c) => {
  const token = await tokenFromRequest(c.req.raw);
  if (!token) return c.json({ error: 'Missing Neon Auth token.' }, 400);
  try {
    const user = await upsertNeonUser(database(c.env), await verifyNeonJwt(c.env, token));
    return c.json({ user }, 200, { 'Set-Cookie': await createWebSession(c, user) });
  } catch {
    return c.json({ error: 'Invalid Neon Auth token.' }, 401);
  }
});

auth.post('/auth/neon/email', async (c) => {
  return neonEmailAuth(c, 'sign-in/email');
});

auth.post('/auth/neon/signup', async (c) => {
  return neonEmailAuth(c, 'sign-up/email');
});

auth.post('/auth/neon/reset', async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = stringField(body, 'email');
  const redirectTo = stringField(body, 'redirectTo');
  if (!email || !redirectTo) return c.json({ error: 'Missing password reset request.' }, 400);
  const rateLimited = await authRateLimited(c, `reset:${email.toLowerCase()}`);
  if (rateLimited) return rateLimited;
  const endpoint = neonAuthEndpoint(c.env, 'forget-password');
  if (!endpoint) return c.json({ error: 'Authentication service is not configured.' }, 500);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, redirectTo: sameOriginRedirect(c.env, redirectTo) }),
  }).catch(() => null);
  if (!response) return c.json({ error: 'Authentication service failed.' }, 502);
  if (!response.ok) return neonError(c, response);
  return c.json({ ok: true });
});

auth.post('/auth/start', async (c) => {
  const body = await c.req.json().catch(() => null);
  const session = stringField(body, 'session');
  const pollSecret = stringField(body, 'poll_secret');
  if (!session || !pollSecret) return c.json({ error: 'Missing login session.' }, 400);

  await database(c.env).execute(`
    INSERT INTO cli_login_sessions (session_id, poll_secret_hash, expires_at)
    VALUES ($1, $2, now() + interval '5 minutes')
    ON CONFLICT (session_id) DO UPDATE SET
      poll_secret_hash = EXCLUDED.poll_secret_hash,
      user_id = NULL,
      verification_code_hash = NULL,
      expires_at = EXCLUDED.expires_at
  `, [session, await hashApiKey(pollSecret)]);

  return c.json({
    login_url: `${c.env.BASE_URL}/app/login?cli_session=${encodeURIComponent(session)}`,
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });
});

auth.post('/auth/complete-cli', async (c) => {
  const body = await c.req.json().catch(() => null);
  const session = stringField(body, 'session');
  const token = stringField(body, 'token');
  if (!session || !token) return c.json({ error: 'Missing login completion.' }, 400);
  const rateLimited = await authRateLimited(c, `complete-cli:${session}`);
  if (rateLimited) return rateLimited;

  let user;
  try {
    user = await upsertNeonUser(database(c.env), await verifyNeonJwt(c.env, token));
  } catch {
    return c.json({ error: 'Invalid Neon Auth token.' }, 401);
  }
  const verificationCode = await completeCliLogin(c.env, session, user.id);
  if (!verificationCode) return c.json({ error: 'Login session expired.' }, 410);
  return c.json({ verification_code: verificationCode, username: user.display_name ?? user.email ?? user.id });
});

auth.post('/auth/poll', async (c) => {
  const body = await c.req.json().catch(() => null);
  const session = stringField(body, 'session');
  const pollSecret = stringField(body, 'poll_secret');
  const verificationCode = stringField(body, 'verification_code');
  if (!session || !pollSecret || !verificationCode) return c.json({ error: 'Missing login verification.' }, 400);
  const rateLimited = await authRateLimited(c, `poll:${session}`);
  if (rateLimited) return rateLimited;

  const row = await database(c.env).first<{
    user_id: string | null;
    poll_secret_hash: string;
    verification_code_hash: string | null;
    expired: boolean;
  }>(`
    SELECT user_id, poll_secret_hash, verification_code_hash, expires_at <= now() AS expired
    FROM cli_login_sessions
    WHERE session_id = $1
  `, [session]);

  if (!row) return c.json({ pending: true }, 202);
  if (row.expired) return c.json({ error: 'Login session expired.' }, 410);
  if (!row.user_id || !row.verification_code_hash) {
    return c.json({ pending: true }, 202);
  }
  if (!timingSafeEqual(await hashApiKey(pollSecret), row.poll_secret_hash)
    || !timingSafeEqual(await hashApiKey(verificationCode), row.verification_code_hash)) {
    return c.json({ error: 'Invalid login verification.' }, 401);
  }

  const apiKey = generateApiKey();
  const keyPrefix = getKeyPrefix(apiKey);
  const pollSecretHash = await hashApiKey(pollSecret);
  const verificationCodeHash = await hashApiKey(verificationCode);
  const inserted = await database(c.env).first<{ key_hash: string }>(`
    WITH deleted AS (
      DELETE FROM cli_login_sessions
      WHERE session_id = $4
        AND user_id = $2
        AND poll_secret_hash = $5
        AND verification_code_hash = $6
        AND expires_at > now()
      RETURNING user_id
    ),
    inserted AS (
      INSERT INTO api_keys (key_hash, user_id, key_prefix, name)
      SELECT $1, user_id, $3, 'oauth-login'
      FROM deleted
      RETURNING key_hash
    )
    SELECT key_hash FROM inserted
  `, [await hashApiKey(apiKey), row.user_id, keyPrefix, session, pollSecretHash, verificationCodeHash]);
  if (!inserted) return c.json({ error: 'Login session is no longer available.' }, 409);
  return c.json({ api_key: apiKey, username: row.user_id });
});

async function tokenFromRequest(request: Request): Promise<string> {
  const auth = request.headers.get('Authorization') ?? '';
  const [scheme, ...rest] = auth.split(/\s+/);
  if (scheme?.toLowerCase() === 'bearer') return rest.join(' ').trim();
  const body = await request.json().catch(() => null) as { token?: unknown } | null;
  return typeof body?.token === 'string' ? body.token : '';
}

async function neonEmailAuth(c: Context<Bindings>, endpoint: 'sign-in/email' | 'sign-up/email'): Promise<Response> {
  const body = await c.req.json().catch(() => null);
  const email = stringField(body, 'email');
  const password = stringField(body, 'password');
  const name = stringField(body, 'name');
  const cliSession = stringField(body, 'cli_session');
  if (!email || !password) return c.json({ error: 'Missing email or password.' }, 400);
  const rateLimited = await authRateLimited(c, `${endpoint}:${email.toLowerCase()}`);
  if (rateLimited) return rateLimited;

  const payload: Record<string, string> = { email, password };
  if (endpoint === 'sign-up/email') payload.name = name || email;
  const authUrl = neonAuthEndpoint(c.env, endpoint);
  if (!authUrl) return c.json({ error: 'Authentication service is not configured.' }, 500);
  const response = await fetch(authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => null);
  if (!response) return c.json({ error: 'Authentication service failed.' }, 502);
  if (!response.ok) return neonError(c, response);

  const token = response.headers.get('set-auth-jwt') ?? await tokenFromJson(response.clone());
  if (!token) return c.json({ error: 'Could not establish a session.' }, 502);

  let user;
  try {
    user = await upsertNeonUser(database(c.env), await verifyNeonJwt(c.env, token));
  } catch {
    return c.json({ error: 'Authentication service returned an invalid session.' }, 502);
  }
  const cookie = await createWebSession(c, user);
  if (cliSession) {
    const verificationCode = await completeCliLogin(c.env, cliSession, user.id);
    if (!verificationCode) return c.json({ user, cli_expired: true }, 200, { 'Set-Cookie': cookie });
    return c.json(
      { verification_code: verificationCode, username: user.display_name ?? user.email ?? user.id },
      200,
      { 'Set-Cookie': cookie },
    );
  }
  return c.json({ user }, 200, { 'Set-Cookie': cookie });
}

async function completeCliLogin(env: Env, session: string, userId: string): Promise<string | null> {
  const verificationCode = verification();
  const result = await database(env).execute(`
    UPDATE cli_login_sessions
    SET user_id = $2,
      verification_code_hash = $3
    WHERE session_id = $1 AND expires_at > now()
  `, [session, userId, await hashApiKey(verificationCode)]);
  return result.rowCount > 0 ? verificationCode : null;
}

function neonAuthEndpoint(env: Env, endpoint: string): string | null {
  if (!env.NEON_AUTH_BASE_URL) return null;
  let base = env.NEON_AUTH_BASE_URL;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return `${base}/${endpoint}`;
}

async function neonError(c: Context<Bindings>, response: Response): Promise<Response> {
  await response.text().catch(() => '');
  const message = response.status >= 500
    ? 'Authentication service failed.'
    : 'Authentication request failed.';
  return c.json({ error: message }, response.status as any);
}

async function tokenFromJson(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  for (const key of ['token', 'jwt', 'accessToken', 'access_token']) {
    const value = body?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function sameOriginRedirect(env: Env, redirectTo: string): string {
  const base = new URL(env.BASE_URL);
  const target = new URL(redirectTo, base);
  return target.origin === base.origin ? target.toString() : `${base.origin}/app/login`;
}

function stringField(body: unknown, field: string): string {
  if (!body || typeof body !== 'object') return '';
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value.trim() : '';
}

async function authRateLimited(c: Context<Bindings>, action: string): Promise<Response | null> {
  const now = Date.now();
  if (now - lastAuthRateLimitCleanup > AUTH_RATE_LIMIT_CLEANUP_MS) {
    lastAuthRateLimitCleanup = now;
    await database(c.env).execute('DELETE FROM auth_rate_limits WHERE reset_at <= now()');
  }
  const client = c.req.header('CF-Connecting-IP')
    ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
    ?? `${c.req.header('Host') ?? 'no-host'}:${c.req.header('User-Agent') ?? 'no-user-agent'}`;
  const rateKey = await hashApiKey(`${action}:client:${client}`);
  const row = await database(c.env).first<{ count: number }>(`
    INSERT INTO auth_rate_limits (rate_key, count, reset_at)
    VALUES ($1, 1, now() + ($2::text || ' milliseconds')::interval)
    ON CONFLICT (rate_key) DO UPDATE SET
      count = CASE
        WHEN auth_rate_limits.reset_at <= now() THEN 1
        ELSE auth_rate_limits.count + 1
      END,
      reset_at = CASE
        WHEN auth_rate_limits.reset_at <= now() THEN now() + ($2::text || ' milliseconds')::interval
        ELSE auth_rate_limits.reset_at
      END
    RETURNING count
  `, [rateKey, AUTH_RATE_LIMIT_WINDOW_MS]);
  if ((row?.count ?? 1) <= authRateLimitMaxAttempts(action)) return null;
  return c.json({ error: 'Too many authentication attempts.' }, 429);
}

function authRateLimitMaxAttempts(action: string): number {
  return action.startsWith('poll:') ? AUTH_RATE_LIMIT_MAX_POLL_ATTEMPTS : AUTH_RATE_LIMIT_MAX_ATTEMPTS;
}

function verification(): string {
  return nanoid(8).toUpperCase();
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

export default auth;
