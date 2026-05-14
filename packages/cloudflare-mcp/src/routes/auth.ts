import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { AppVariables, Env } from '../env.js';
import { database, upsertNeonUser } from '../db.js';
import { generateApiKey, getKeyPrefix, hashApiKey } from '../lib/api-key.js';
import { createWebSession, verifyNeonJwt } from '../neon-auth.js';

type Bindings = { Bindings: Env; Variables: AppVariables };

const auth = new Hono<Bindings>();

auth.post('/auth/neon/session', async (c) => {
  const token = await tokenFromRequest(c.req.raw);
  if (!token) return c.json({ error: 'Missing Neon Auth token.' }, 400);
  const user = await upsertNeonUser(database(c.env), await verifyNeonJwt(c.env, token));
  return c.json({ user }, 200, { 'Set-Cookie': await createWebSession(c, user) });
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
      api_key_value = NULL,
      api_key_prefix = NULL,
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

  const user = await upsertNeonUser(database(c.env), await verifyNeonJwt(c.env, token));
  const verificationCode = verification();
  const apiKey = generateApiKey();
  await database(c.env).execute(`
    UPDATE cli_login_sessions
    SET user_id = $2,
      verification_code_hash = $3,
      api_key_value = $4,
      api_key_prefix = $5
    WHERE session_id = $1 AND expires_at > now()
  `, [
    session,
    user.id,
    await hashApiKey(verificationCode),
    apiKey,
    getKeyPrefix(apiKey),
  ]);
  return c.json({ verification_code: verificationCode, username: user.display_name ?? user.email ?? user.id });
});

auth.post('/auth/poll', async (c) => {
  const body = await c.req.json().catch(() => null);
  const session = stringField(body, 'session');
  const pollSecret = stringField(body, 'poll_secret');
  const verificationCode = stringField(body, 'verification_code');
  if (!session || !pollSecret || !verificationCode) return c.json({ error: 'Missing login verification.' }, 400);

  const row = await database(c.env).first<{
    user_id: string | null;
    poll_secret_hash: string;
    verification_code_hash: string | null;
    api_key_value: string | null;
    api_key_prefix: string | null;
  }>(`
    SELECT user_id, poll_secret_hash, verification_code_hash, api_key_value, api_key_prefix
    FROM cli_login_sessions
    WHERE session_id = $1 AND expires_at > now()
  `, [session]);

  if (!row?.user_id || !row.verification_code_hash || !row.api_key_value || !row.api_key_prefix) {
    return c.json({ pending: true }, 202);
  }
  if (!timingSafeEqual(await hashApiKey(pollSecret), row.poll_secret_hash)
    || !timingSafeEqual(await hashApiKey(verificationCode), row.verification_code_hash)) {
    return c.json({ error: 'Invalid login verification.' }, 401);
  }

  await database(c.env).execute(`
    INSERT INTO api_keys (key_hash, user_id, key_prefix, name)
    VALUES ($1, $2, $3, 'oauth-login')
  `, [await hashApiKey(row.api_key_value), row.user_id, row.api_key_prefix]);
  await database(c.env).execute('DELETE FROM cli_login_sessions WHERE session_id = $1', [session]);
  return c.json({ api_key: row.api_key_value, username: row.user_id });
});

async function tokenFromRequest(request: Request): Promise<string> {
  const auth = request.headers.get('Authorization') ?? '';
  const [scheme, ...rest] = auth.split(/\s+/);
  if (scheme?.toLowerCase() === 'bearer') return rest.join(' ').trim();
  const body = await request.json().catch(() => null) as { token?: unknown } | null;
  return typeof body?.token === 'string' ? body.token : '';
}

function stringField(body: unknown, field: string): string {
  if (!body || typeof body !== 'object') return '';
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value.trim() : '';
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
