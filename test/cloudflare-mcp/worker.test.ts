import { describe, expect, it } from 'vitest';
import worker, { VaultObject } from '../../packages/cloudflare-mcp/src/index.js';
import { hashApiKey } from '../../packages/cloudflare-mcp/src/lib/api-key.js';

describe('granite cloudflare worker routes', () => {
  it('rejects /mcp without a bearer api key', async () => {
    const { env } = await createEnv();

    const response = await fetchWorker(env, new Request('https://granite.test/mcp?vault_id=v_a', {
      method: 'POST',
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Missing or invalid API key.' });
  });

  it('routes /mcp to the durable object selected by vault_id query', async () => {
    const { env, routedVaults } = await createEnv();

    const response = await fetchWorker(env, new Request('https://granite.test/mcp?vault_id=v_a', {
      method: 'POST',
      headers: { Authorization: 'Bearer gsk_valid' },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ vault_id: 'v_a', path: '/mcp' });
    expect(routedVaults).toEqual(['v_a']);
  });

  it('accepts bearer authorization case-insensitively', async () => {
    const { env, routedVaults } = await createEnv();

    const response = await fetchWorker(env, new Request('https://granite.test/mcp?vault_id=v_a', {
      method: 'POST',
      headers: { Authorization: 'bearer gsk_valid' },
    }));

    expect(response.status).toBe(200);
    expect(routedVaults).toEqual(['v_a']);
  });

  it('routes /mcp to the durable object selected by X-Vault-Id', async () => {
    const { env, routedVaults } = await createEnv();

    const response = await fetchWorker(env, new Request('https://granite.test/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer gsk_valid',
        'X-Vault-Id': 'v_b',
      },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ vault_id: 'v_b', path: '/mcp' });
    expect(routedVaults).toEqual(['v_b']);
  });

  it('requires explicit vault selection for /mcp', async () => {
    const { env, routedVaults } = await createEnv();

    const response = await fetchWorker(env, new Request('https://granite.test/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer gsk_valid' },
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Missing vault_id. Provide ?vault_id=<id> or X-Vault-Id.' });
    expect(routedVaults).toEqual([]);
  });

  it('defaults invalid vault names instead of throwing', async () => {
    const { env } = await createEnv();

    const response = await fetchWorker(env, new Request('https://granite.test/vaults', {
      method: 'POST',
      headers: { Authorization: 'Bearer gsk_valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 123 }),
    }));

    expect(response.status).toBe(201);
    const body = await response.json() as { vault_name: string };
    expect(body.vault_name).toBe('Cloud Vault');
  });

  it('returns 400 for malformed import JSON', async () => {
    const { env } = await createEnv();

    const response = await fetchWorker(env, new Request('https://granite.test/vaults/v_a/import', {
      method: 'POST',
      headers: { Authorization: 'Bearer gsk_valid', 'Content-Type': 'application/json' },
      body: '{bad',
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid import JSON.' });
  });

  it('returns 400 for malformed note create and update JSON inside the vault object', async () => {
    const vault = new VaultObject({
      id: { name: 'v_a' },
      storage: {},
    } as any, { VAULT_BUCKET: {} } as any);

    const create = await vault.fetch(new Request('https://vault.internal/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad',
    }));
    const update = await vault.fetch(new Request('https://vault.internal/api/notes/demo', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad',
    }));

    expect(create.status).toBe(400);
    expect(update.status).toBe(400);
    await expect(create.json()).resolves.toEqual({ error: 'Invalid note JSON.' });
    await expect(update.json()).resolves.toEqual({ error: 'Invalid note JSON.' });
  });

  it('reports missing api key revocations instead of false success', async () => {
    const { env } = await createEnv({ revokeChanges: 0 });

    const response = await fetchWorker(env, new Request('https://granite.test/keys/gsk_missing', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer gsk_valid' },
    }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'API key not found or already revoked.' });
  });

  it('confirms api key revocations only when a row changed', async () => {
    const { env } = await createEnv({ revokeChanges: 1 });

    const response = await fetchWorker(env, new Request('https://granite.test/keys/gsk_existing', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer gsk_valid' },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: true, prefix: 'gsk_existing' });
  });
});

function fetchWorker(env: any, request: Request): Promise<Response> {
  return worker.fetch(request, env, { waitUntil: () => {} } as any);
}

async function createEnv(options: { revokeChanges?: number } = {}) {
  const validHash = await hashApiKey('gsk_valid');
  const routedVaults: string[] = [];
  const user = {
    id: 'u_1',
    github_id: 123,
    email: 'user@example.com',
    github_username: 'user',
    created_at: '2026-05-13T00:00:00.000Z',
    updated_at: '2026-05-13T00:00:00.000Z',
  };
  const vaults = new Set(['v_a', 'v_b']);

  const env = {
    ACCOUNTS_DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                if (sql.includes('JOIN users')) {
                  return args[0] === validHash ? user : null;
                }
                if (
                  sql.includes('SELECT vault_id FROM vaults WHERE vault_id = ? AND user_id = ?') ||
                  sql.includes('SELECT vault_id FROM vaults WHERE user_id = ? AND vault_id = ?')
                ) {
                  const vaultId = String(args[0]);
                  const reorderedVaultId = String(args[1]);
                  const resolvedVaultId = vaults.has(vaultId) ? vaultId : reorderedVaultId;
                  return vaults.has(resolvedVaultId) ? { vault_id: resolvedVaultId } : null;
                }
                if (sql.includes('SELECT vault_id FROM vaults WHERE user_id = ? ORDER BY created_at LIMIT 1')) {
                  return { vault_id: 'v_a' };
                }
                return null;
              },
              async all() {
                return { results: [] };
              },
              async run() {
                if (sql.includes('INSERT INTO vaults')) {
                  return { success: true, meta: { changes: 1 } };
                }
                if (sql.includes('SET revoked_at')) {
                  return { success: true, meta: { changes: options.revokeChanges ?? 1 } };
                }
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
    VAULT_OBJECT: {
      idFromName(name: string) {
        return { name };
      },
      get(id: { name: string }) {
        return {
          async fetch(request: Request) {
            routedVaults.push(id.name);
            if (new URL(request.url).pathname === '/import') {
              try {
                await request.clone().json();
              } catch {
                return Response.json({ error: 'Invalid import JSON.' }, { status: 400 });
              }
            }
            return Response.json({ vault_id: id.name, path: new URL(request.url).pathname });
          },
        };
      },
    },
    VAULT_BUCKET: {},
    BASE_URL: 'https://granite.test',
    GITHUB_CLIENT_ID: 'client',
    GITHUB_CLIENT_SECRET: 'secret',
  };

  return { env: env as any, routedVaults };
}
