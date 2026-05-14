import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { nanoid } from 'nanoid';
import type { AppVariables, Env, VaultRow } from './env.js';
import { authMiddleware, resolveVaultId } from './auth.js';
import authRoutes from './routes/auth.js';
import keysRoutes from './routes/keys.js';
import dashboardRoutes from './routes/dashboard.js';
import { R2VaultStorage } from './storage/r2.js';
import { CloudMcpRuntime, VaultSqlIndex, type ImportPayload } from './runtime.js';
import { handleCloudMcpRequest } from './mcp.js';
import { database, ownedVault, reserveVaultBytes } from './db.js';
import { ensureStripeCustomer, stripeBilling, subscriptionStatus } from './billing.js';

type Bindings = { Bindings: Env; Variables: AppVariables };

const app = new Hono<Bindings>();

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version', 'Last-Event-ID', 'X-Vault-Id'],
  exposeHeaders: ['MCP-Session-Id', 'MCP-Protocol-Version'],
}));

app.get('/health', c => c.json({
  status: 'ok',
  service: 'granite-cloudflare-mcp',
  bindings: {
    database: !!(c.env.DATABASE_URL || c.env.HYPERDRIVE || c.env.TEST_DB),
    neon_auth: !!c.env.NEON_AUTH_JWKS_URL,
    stripe: !!(c.env.STRIPE_SECRET_KEY && c.env.STRIPE_VAULT_1GB_PRICE_ID),
    vault_bucket: !!c.env.VAULT_BUCKET,
    vault_object: !!c.env.VAULT_OBJECT,
  },
}));
app.route('/', authRoutes);
app.route('/', dashboardRoutes);

app.use('/keys', authMiddleware);
app.use('/keys/*', authMiddleware);
app.use('/vaults', authMiddleware);
app.use('/vaults/*', authMiddleware);
app.use('/billing/*', authMiddleware);
app.use('/mcp', authMiddleware);
app.use('/api/*', authMiddleware);
app.route('/', keysRoutes);

app.get('/vaults', async (c) => {
  const user = c.get('user');
  const result = await database(c.env).query<VaultRow>(`
    SELECT vault_id, user_id, vault_name, billing_status, stripe_subscription_id,
      stripe_checkout_session_id, stripe_price_id, current_period_end, cancel_at_period_end,
      storage_limit_bytes, storage_used_bytes, activated_at, created_at, updated_at
    FROM vaults
    WHERE user_id = $1
    ORDER BY created_at
  `, [user.id]);
  return c.json({ vaults: result });
});

app.post('/vaults', async (c) => {
  const user = c.get('user');
  const body = await safeJson<{ name?: string }>(c.req.raw);
  const vaultId = `v_${nanoid(12)}`;
  const name = (typeof body?.name === 'string' && body.name.trim() ? body.name : 'Cloud Vault').slice(0, 100);
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
  return c.json({ vault_id: vaultId, vault_name: name, billing_status: 'pending_checkout', checkout_url: checkout.url }, 201);
});

app.post('/vaults/:id/import', async (c) => {
  const vaultId = c.req.param('id');
  const owner = await assertOwnedVault(c.env, c.get('user').id, vaultId, 'write');
  if (!owner) return c.json({ error: 'Vault not found or access denied.' }, 404);
  if (owner instanceof Response) return owner;

  const response = await vaultObject(c.env, vaultId).fetch(new Request('https://vault.internal/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: await c.req.text(),
  }));
  return proxyResponse(response);
});

app.post('/billing/portal', async (c) => {
  const user = c.get('user');
  if (!user.stripe_customer_id) return c.json({ error: 'No Stripe customer exists for this account.' }, 404);
  const portal = await stripeBilling(c.env).createPortal({
    customerId: user.stripe_customer_id,
    returnUrl: `${c.env.BASE_URL}/app`,
  });
  return c.json(portal);
});

app.post('/stripe/webhook', async (c) => {
  const signature = c.req.header('Stripe-Signature') ?? '';
  if (!signature) return c.json({ error: 'Missing Stripe signature.' }, 400);
  const event = await stripeBilling(c.env).parseWebhook(await c.req.text(), signature);
  const inserted = await database(c.env).first<{ event_id: string }>(`
    INSERT INTO stripe_events (event_id, event_type)
    VALUES ($1, $2)
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id
  `, [event.id, event.type]);
  if (!inserted) return c.json({ received: true, duplicate: true });
  await applyStripeEvent(c.env, event);
  return c.json({ received: true });
});

app.all('/mcp', async (c) => {
  const resolved = await resolveVaultId(c, 'write');
  if (resolved instanceof Response) return resolved;
  return proxyResponse(await vaultObject(c.env, resolved).fetch(c.req.raw));
});

app.get('/api/notes', async (c) => {
  const resolved = await resolveVaultId(c, 'read');
  if (resolved instanceof Response) return resolved;
  return proxyResponse(await vaultObject(c.env, resolved).fetch(rewrite(c.req.raw, '/api/notes')));
});

app.post('/api/notes', async (c) => {
  const resolved = await resolveVaultId(c, 'write');
  if (resolved instanceof Response) return resolved;
  return proxyResponse(await vaultObject(c.env, resolved).fetch(rewrite(c.req.raw, '/api/notes')));
});

app.get('/api/notes/:slug', async (c) => {
  const resolved = await resolveVaultId(c, 'read');
  if (resolved instanceof Response) return resolved;
  return proxyResponse(await vaultObject(c.env, resolved).fetch(rewrite(c.req.raw, `/api/notes/${encodeURIComponent(c.req.param('slug'))}`)));
});

app.patch('/api/notes/:slug', async (c) => {
  const resolved = await resolveVaultId(c, 'write');
  if (resolved instanceof Response) return resolved;
  return proxyResponse(await vaultObject(c.env, resolved).fetch(rewrite(c.req.raw, `/api/notes/${encodeURIComponent(c.req.param('slug'))}`)));
});

app.delete('/api/notes/:slug', async (c) => {
  const resolved = await resolveVaultId(c, 'write');
  if (resolved instanceof Response) return resolved;
  return proxyResponse(await vaultObject(c.env, resolved).fetch(rewrite(c.req.raw, `/api/notes/${encodeURIComponent(c.req.param('slug'))}`)));
});

app.get('/api/search', async (c) => {
  const resolved = await resolveVaultId(c, 'read');
  if (resolved instanceof Response) return resolved;
  return proxyResponse(await vaultObject(c.env, resolved).fetch(c.req.raw));
});

app.get('/api/graph', async (c) => {
  const resolved = await resolveVaultId(c, 'read');
  if (resolved instanceof Response) return resolved;
  return proxyResponse(await vaultObject(c.env, resolved).fetch(c.req.raw));
});

app.notFound(c => c.json({ error: 'Not found' }, 404));

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: 'Internal server error' }, 500);
});

export class VaultObject {
  private runtime: CloudMcpRuntime;

  constructor(
    private state: DurableObjectState,
    env: Env,
  ) {
    const vaultId = state.id.name ?? 'unknown';
    this.runtime = new CloudMcpRuntime(
      vaultId,
      new R2VaultStorage(env.VAULT_BUCKET, vaultId, {
        reserve: (delta) => reserveVaultBytes(database(env), vaultId, delta),
      }),
      new VaultSqlIndex(state.storage),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/mcp') {
      return handleCloudMcpRequest(request, this.runtime);
    }

    if (url.pathname === '/import' && request.method === 'POST') {
      const payload = await safeJson<ImportPayload>(request);
      if (!payload) return Response.json({ error: 'Invalid import JSON.' }, { status: 400 });
      return Response.json(await this.runtime.importVault(payload));
    }

    if (url.pathname === '/api/notes' && request.method === 'GET') {
      return Response.json({
        notes: await this.runtime.listNotes({
          type: url.searchParams.get('type') ?? undefined,
          status: url.searchParams.get('status') ?? undefined,
          source: url.searchParams.get('source') ?? undefined,
          since: url.searchParams.get('since') ?? undefined,
        }),
      });
    }

    if (url.pathname === '/api/notes' && request.method === 'POST') {
      const input = await safeJson<Parameters<CloudMcpRuntime['captureKnowledge']>[0]>(request);
      if (!input) return Response.json({ error: 'Invalid note JSON.' }, { status: 400 });
      return Response.json(await this.runtime.captureKnowledge(input), { status: 201 });
    }

    const noteMatch = url.pathname.match(/^\/api\/notes\/([^/]+)$/);
    if (noteMatch && request.method === 'GET') {
      return noteEndpointResponse(() => this.runtime.getNote(decodeURIComponent(noteMatch[1])));
    }

    if (noteMatch && request.method === 'PATCH') {
      const input = await safeJson<Omit<Parameters<CloudMcpRuntime['reviseNote']>[0], 'slug'>>(request);
      if (!input) return Response.json({ error: 'Invalid note JSON.' }, { status: 400 });
      return noteEndpointResponse(() => this.runtime.reviseNote({
        slug: decodeURIComponent(noteMatch[1]),
        ...input,
      }));
    }

    if (noteMatch && request.method === 'DELETE') {
      return noteEndpointResponse(() => this.runtime.disposeNote({
        slug: decodeURIComponent(noteMatch[1]),
        mode: url.searchParams.get('mode') === 'delete' ? 'delete' : 'archive',
      }));
    }

    if (url.pathname === '/api/search' && request.method === 'GET') {
      const query = url.searchParams.get('q') ?? '';
      return Response.json({ query, results: query ? await this.runtime.researchTopic({ query }) : [] });
    }

    if (url.pathname === '/api/graph' && request.method === 'GET') {
      return Response.json(await this.runtime.graph());
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }
}

function vaultObject(env: Env, vaultId: string): DurableObjectStub {
  return env.VAULT_OBJECT.get(env.VAULT_OBJECT.idFromName(vaultId));
}

async function assertOwnedVault(env: Env, userId: string, vaultId: string, mode: 'read' | 'write'): Promise<VaultRow | Response | null> {
  const row = await ownedVault(database(env), userId, vaultId);
  if (!row) return null;
  if (mode === 'write' && row.billing_status !== 'active') {
    return Response.json({ error: `Vault is not writable while billing status is ${row.billing_status}.` }, { status: 402 });
  }
  return row;
}

async function applyStripeEvent(env: Env, event: any): Promise<void> {
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const vaultId = session.metadata?.granite_vault_id ?? session.client_reference_id;
    if (!vaultId) return;
    await database(env).execute(`
      UPDATE vaults
      SET billing_status = 'active',
        stripe_subscription_id = $2,
        activated_at = COALESCE(activated_at, now()),
        updated_at = now()
      WHERE vault_id = $1
    `, [vaultId, typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null]);
    return;
  }

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const vaultId = subscription.metadata?.granite_vault_id;
    if (!vaultId) return;
    await database(env).execute(`
      UPDATE vaults
      SET billing_status = $2,
        current_period_end = CASE WHEN $3::bigint IS NULL THEN current_period_end ELSE to_timestamp($3::bigint) END,
        cancel_at_period_end = $4,
        updated_at = now()
      WHERE vault_id = $1
    `, [
      vaultId,
      subscriptionStatus(subscription.status),
      typeof subscription.current_period_end === 'number' ? subscription.current_period_end : null,
      Boolean(subscription.cancel_at_period_end),
    ]);
  }
}

function rewrite(request: Request, path: string): Request {
  const url = new URL(request.url);
  url.pathname = path;
  return new Request(url.toString(), request);
}

function proxyResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function safeJson<T>(request: Request): Promise<T | null> {
  try {
    return await request.json() as T;
  } catch {
    return null;
  }
}

async function noteEndpointResponse(action: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await action());
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Note not found')) {
      return Response.json({ error: 'Note not found.' }, { status: 404 });
    }
    throw error;
  }
}

export default {
  fetch: app.fetch,
};
