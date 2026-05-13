import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { nanoid } from 'nanoid';
import type { AppVariables, Env, VaultRow } from './env.js';
import { authMiddleware, resolveVaultId } from './auth.js';
import authRoutes from './routes/auth.js';
import keysRoutes from './routes/keys.js';
import { R2VaultStorage } from './storage/r2.js';
import { CloudMcpRuntime, VaultSqlIndex, type ImportPayload } from './runtime.js';
import { handleCloudMcpRequest } from './mcp.js';

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
    accounts_db: !!c.env.ACCOUNTS_DB,
    vault_bucket: !!c.env.VAULT_BUCKET,
    vault_object: !!c.env.VAULT_OBJECT,
  },
}));
app.route('/', authRoutes);

app.use('/keys', authMiddleware);
app.use('/keys/*', authMiddleware);
app.use('/vaults', authMiddleware);
app.use('/vaults/*', authMiddleware);
app.use('/mcp', authMiddleware);
app.use('/api/*', authMiddleware);
app.route('/', keysRoutes);

app.get('/vaults', async (c) => {
  const user = c.get('user');
  const result = await c.env.ACCOUNTS_DB.prepare(`
    SELECT vault_id, user_id, vault_name, created_at, updated_at
    FROM vaults
    WHERE user_id = ?
    ORDER BY created_at
  `).bind(user.id).all<VaultRow>();
  return c.json({ vaults: result.results ?? [] });
});

app.post('/vaults', async (c) => {
  const user = c.get('user');
  const body = await safeJson<{ name?: string }>(c.req.raw);
  const vaultId = `v_${nanoid(12)}`;
  const name = (body?.name || 'Cloud Vault').slice(0, 100);
  await c.env.ACCOUNTS_DB.prepare(`
    INSERT INTO vaults (vault_id, user_id, vault_name)
    VALUES (?, ?, ?)
  `).bind(vaultId, user.id, name).run();
  return c.json({ vault_id: vaultId, vault_name: name }, 201);
});

app.post('/vaults/:id/import', async (c) => {
  const vaultId = c.req.param('id');
  const owner = await assertOwnedVault(c.env, c.get('user').id, vaultId);
  if (!owner) return c.json({ error: 'Vault not found or access denied.' }, 404);

  const response = await vaultObject(c.env, vaultId).fetch(new Request('https://vault.internal/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: await c.req.text(),
  }));
  return proxyResponse(response);
});

app.all('/mcp', async (c) => {
  const resolved = await resolveVaultId(c);
  if (resolved instanceof Response) return resolved;
  return proxyResponse(await vaultObject(c.env, resolved).fetch(c.req.raw));
});

app.get('/api/notes', async (c) => {
  const resolved = await resolveVaultId(c);
  if (resolved instanceof Response) return resolved;
  return proxyResponse(await vaultObject(c.env, resolved).fetch(rewrite(c.req.raw, '/api/notes')));
});

app.post('/api/notes', async (c) => {
  const resolved = await resolveVaultId(c);
  if (resolved instanceof Response) return resolved;
  return proxyResponse(await vaultObject(c.env, resolved).fetch(rewrite(c.req.raw, '/api/notes')));
});

app.get('/api/notes/:slug', async (c) => {
  const resolved = await resolveVaultId(c);
  if (resolved instanceof Response) return resolved;
  return proxyResponse(await vaultObject(c.env, resolved).fetch(rewrite(c.req.raw, `/api/notes/${encodeURIComponent(c.req.param('slug'))}`)));
});

app.patch('/api/notes/:slug', async (c) => {
  const resolved = await resolveVaultId(c);
  if (resolved instanceof Response) return resolved;
  return proxyResponse(await vaultObject(c.env, resolved).fetch(rewrite(c.req.raw, `/api/notes/${encodeURIComponent(c.req.param('slug'))}`)));
});

app.delete('/api/notes/:slug', async (c) => {
  const resolved = await resolveVaultId(c);
  if (resolved instanceof Response) return resolved;
  return proxyResponse(await vaultObject(c.env, resolved).fetch(rewrite(c.req.raw, `/api/notes/${encodeURIComponent(c.req.param('slug'))}`)));
});

app.get('/api/search', async (c) => {
  const resolved = await resolveVaultId(c);
  if (resolved instanceof Response) return resolved;
  return proxyResponse(await vaultObject(c.env, resolved).fetch(c.req.raw));
});

app.get('/api/graph', async (c) => {
  const resolved = await resolveVaultId(c);
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
      new R2VaultStorage(env.VAULT_BUCKET, vaultId),
      new VaultSqlIndex(state.storage),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/mcp') {
      return handleCloudMcpRequest(request, this.runtime);
    }

    if (url.pathname === '/import' && request.method === 'POST') {
      const payload = await request.json() as ImportPayload;
      return Response.json(await this.runtime.importVault(payload));
    }

    if (url.pathname === '/api/notes' && request.method === 'GET') {
      return Response.json({ notes: await this.runtime.listNotes(url.searchParams.get('type') ?? undefined) });
    }

    if (url.pathname === '/api/notes' && request.method === 'POST') {
      const input = await request.json() as Parameters<CloudMcpRuntime['captureKnowledge']>[0];
      return Response.json(await this.runtime.captureKnowledge(input), { status: 201 });
    }

    const noteMatch = url.pathname.match(/^\/api\/notes\/([^/]+)$/);
    if (noteMatch && request.method === 'GET') {
      return Response.json(await this.runtime.getNote(decodeURIComponent(noteMatch[1])));
    }

    if (noteMatch && request.method === 'PATCH') {
      const input = await request.json() as Omit<Parameters<CloudMcpRuntime['reviseNote']>[0], 'slug'>;
      return Response.json(await this.runtime.reviseNote({
        slug: decodeURIComponent(noteMatch[1]),
        ...input,
      }));
    }

    if (noteMatch && request.method === 'DELETE') {
      return Response.json(await this.runtime.disposeNote({
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

async function assertOwnedVault(env: Env, userId: string, vaultId: string): Promise<boolean> {
  const row = await env.ACCOUNTS_DB.prepare(
    'SELECT vault_id FROM vaults WHERE user_id = ? AND vault_id = ?',
  ).bind(userId, vaultId).first<{ vault_id: string }>();
  return !!row;
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

export default {
  fetch: app.fetch,
};
