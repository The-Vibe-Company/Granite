import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Context } from 'hono';
import type { AppVariables, Env, NeonAuthUser, User } from './env.js';
import { database, upsertNeonUser } from './db.js';

type Bindings = { Bindings: Env; Variables: AppVariables };

const SESSION_COOKIE = 'granite_session';
const NEON_TOKEN_COOKIE = 'granite_neon_jwt';
const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function currentWebUser(c: Context<Bindings>): Promise<User | null> {
  const token = bearerToken(c.req.header('Authorization') ?? '')
    || cookie(c.req.header('Cookie') ?? '', NEON_TOKEN_COOKIE);
  if (token) {
    try {
      const neonUser = await verifyNeonJwt(c.env, token);
      return upsertNeonUser(database(c.env), neonUser);
    } catch {
      // Fall through to the durable web session cookie when the Neon JWT is stale.
    }
  }

  const session = cookie(c.req.header('Cookie') ?? '', SESSION_COOKIE);
  if (!session) return null;
  return database(c.env).first<User>(`
    SELECT u.id, u.neon_user_id, u.email, u.display_name, u.stripe_customer_id, u.created_at, u.updated_at
    FROM web_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.session_hash = $1 AND s.expires_at > now()
  `, [await sha256(session)]);
}

export async function createWebSession(c: Context<Bindings>, user: User): Promise<string> {
  const token = crypto.randomUUID() + crypto.randomUUID();
  await database(c.env).execute(`
    INSERT INTO web_sessions (session_hash, user_id, expires_at)
    VALUES ($1, $2, now() + interval '30 days')
  `, [await sha256(token), user.id]);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
}

export async function verifyNeonJwt(env: Env, token: string): Promise<NeonAuthUser> {
  if (!env.NEON_AUTH_JWKS_URL) throw new Error('NEON_AUTH_JWKS_URL is not configured.');
  const jwks = jwksFor(env.NEON_AUTH_JWKS_URL);
  const { payload } = await jwtVerify(token, jwks);
  const id = stringClaim(payload.sub);
  if (!id) throw new Error('Neon Auth token is missing a subject.');
  return {
    id,
    email: stringClaim(payload.email),
    display_name: stringClaim(payload.name) ?? stringClaim(payload.preferred_username),
  };
}

function jwksFor(url: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksByUrl.get(url);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(new URL(url));
  jwksByUrl.set(url, jwks);
  return jwks;
}

function bearerToken(header: string): string {
  const [scheme, ...rest] = header.split(/\s+/);
  return scheme?.toLowerCase() === 'bearer' ? rest.join(' ').trim() : '';
}

function cookie(header: string, name: string): string {
  for (const part of header.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey === name) return decodeURIComponent(rawValue.join('='));
  }
  return '';
}

function stringClaim(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}
