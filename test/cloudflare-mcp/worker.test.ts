import { describe, expect, it } from 'vitest';
import worker from '../../packages/cloudflare-mcp/src/index.js';
import { hashApiKey } from '../../packages/cloudflare-mcp/src/lib/api-key.js';

describe('granite cloudflare worker routes', () => {
  it('rejects /mcp without a bearer api key', async () => {
    const { env } = await createEnv();

    const response = await worker.fetch(new Request('https://granite.test/mcp?vault_id=v_a', {
      method: 'POST',
    }), env);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Missing or invalid API key.' });
  });

  it('routes /mcp to the durable object selected by vault_id query', async () => {
    const { env, routedVaults } = await createEnv();

    const response = await worker.fetch(new Request('https://granite.test/mcp?vault_id=v_a', {
      method: 'POST',
      headers: { Authorization: 'Bearer gsk_valid' },
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ vault_id: 'v_a', path: '/mcp' });
    expect(routedVaults).toEqual(['v_a']);
  });

  it('routes /mcp to the durable object selected by X-Vault-Id', async () => {
    const { env, routedVaults } = await createEnv();

    const response = await worker.fetch(new Request('https://granite.test/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer gsk_valid',
        'X-Vault-Id': 'v_b',
      },
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ vault_id: 'v_b', path: '/mcp' });
    expect(routedVaults).toEqual(['v_b']);
  });

  it('reports missing api key revocations instead of false success', async () => {
    const { env } = await createEnv({ revokeChanges: 0 });

    const response = await worker.fetch(new Request('https://granite.test/keys/gsk_missing', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer gsk_valid' },
    }), env);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'API key not found or already revoked.' });
  });

  it('confirms api key revocations only when a row changed', async () => {
    const { env } = await createEnv({ revokeChanges: 1 });

    const response = await worker.fetch(new Request('https://granite.test/keys/gsk_existing', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer gsk_valid' },
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: true, prefix: 'gsk_existing' });
  });
});

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
                if (sql.includes('SELECT vault_id FROM vaults WHERE vault_id = ? AND user_id = ?')) {
                  const vaultId = String(args[0]);
                  return vaults.has(vaultId) ? { vault_id: vaultId } : null;
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
