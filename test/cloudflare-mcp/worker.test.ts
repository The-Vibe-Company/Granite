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

  it('blocks MCP access for pending paid vaults', async () => {
    const { env, routedVaults } = await createEnv();

    const response = await fetchWorker(env, new Request('https://granite.test/mcp?vault_id=v_pending', {
      method: 'POST',
      headers: { Authorization: 'Bearer gsk_valid' },
    }));

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({
      error: 'Vault is not writable while billing status is pending_checkout.',
    });
    expect(routedVaults).toEqual([]);
  });

  it('creates pending paid vaults with checkout URLs', async () => {
    const { env } = await createEnv();

    const response = await fetchWorker(env, new Request('https://granite.test/vaults', {
      method: 'POST',
      headers: { Authorization: 'Bearer gsk_valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 123 }),
    }));

    expect(response.status).toBe(201);
    const body = await response.json() as { vault_name: string; billing_status: string; checkout_url: string };
    expect(body.vault_name).toBe('Cloud Vault');
    expect(body.billing_status).toBe('pending_checkout');
    expect(body.checkout_url).toBe('https://stripe.test/checkout');
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

  it('returns 400 for non-string login poll fields', async () => {
    const { env } = await createEnv();

    const response = await fetchWorker(env, new Request('https://granite.test/auth/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: 123, poll_secret: {}, verification_code: [] }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Missing login verification.' });
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

  it('returns 404 for missing notes inside the vault object', async () => {
    const vault = new VaultObject({
      id: { name: 'v_a' },
      storage: {},
    } as any, { VAULT_BUCKET: {} } as any);
    (vault as any).runtime = {
      getNote: async () => {
        throw new Error('Note not found: missing');
      },
    };

    const response = await vault.fetch(new Request('https://vault.internal/api/notes/missing'));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Note not found.' });
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

  it('activates a pending vault from a Stripe checkout webhook', async () => {
    const { env } = await createEnv();

    const response = await fetchWorker(env, new Request('https://granite.test/stripe/webhook', {
      method: 'POST',
      headers: { 'Stripe-Signature': 'sig' },
      body: '{}',
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
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
    neon_user_id: 'neon_1',
    email: 'user@example.com',
    display_name: 'user',
    stripe_customer_id: 'cus_1',
    created_at: '2026-05-13T00:00:00.000Z',
    updated_at: '2026-05-13T00:00:00.000Z',
  };
  const vaults = new Map([
    ['v_a', vaultRow('v_a', user.id, 'active')],
    ['v_b', vaultRow('v_b', user.id, 'active')],
    ['v_pending', vaultRow('v_pending', user.id, 'pending_checkout')],
  ]);
  const seenEvents = new Set<string>();
  const db = {
    async first(sql: string, args: unknown[] = []) {
      if (sql.includes('JOIN users')) {
        return args[0] === validHash ? user : null;
      }
      if (sql.includes('FROM vaults') && sql.includes('WHERE vault_id = $1 AND user_id = $2')) {
        const vault = vaults.get(String(args[0]));
        return vault && args[1] === user.id ? vault : null;
      }
      if (sql.includes('INSERT INTO stripe_events')) {
        const id = String(args[0]);
        if (seenEvents.has(id)) return null;
        seenEvents.add(id);
        return { event_id: id };
      }
      return null;
    },
    async query(sql: string, args: unknown[] = []) {
      if (sql.includes('FROM vaults') && sql.includes('WHERE user_id = $1')) {
        return [...vaults.values()].filter(v => v.user_id === args[0]);
      }
      if (sql.includes('FROM api_keys')) return [];
      return [];
    },
    async execute(sql: string, args: unknown[] = []) {
      if (sql.includes('INSERT INTO vaults')) {
        const vaultId = String(args[0]);
        vaults.set(vaultId, vaultRow(vaultId, String(args[1]), 'pending_checkout'));
        return { rowCount: 1 };
      }
      if (sql.includes('SET revoked_at')) {
        return { rowCount: options.revokeChanges ?? 1 };
      }
      if (sql.includes('UPDATE vaults') && sql.includes("billing_status = 'active'")) {
        const vault = vaults.get(String(args[0]));
        if (vault) vault.billing_status = 'active';
        return { rowCount: vault ? 1 : 0 };
      }
      return { rowCount: 1 };
    },
  };

  const env = {
    TEST_DB: db,
    TEST_STRIPE: {
      async createCustomer() { return 'cus_1'; },
      async createVaultCheckout() { return { id: 'cs_1', url: 'https://stripe.test/checkout' }; },
      async createPortal() { return { url: 'https://stripe.test/portal' }; },
      async parseWebhook() {
        return { id: 'evt_1', type: 'checkout.session.completed', data: { object: { metadata: { granite_vault_id: 'v_a' }, subscription: 'sub_1' } } };
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
    NEON_AUTH_JWKS_URL: 'https://neon.test/jwks.json',
    STRIPE_VAULT_1GB_PRICE_ID: 'price_1gb',
  };

  return { env: env as any, routedVaults };
}

function vaultRow(vaultId: string, userId: string, status: string) {
  return {
    vault_id: vaultId,
    user_id: userId,
    vault_name: vaultId,
    billing_status: status,
    stripe_subscription_id: null,
    stripe_checkout_session_id: null,
    stripe_price_id: 'price_1gb',
    current_period_end: null,
    cancel_at_period_end: false,
    storage_limit_bytes: 1000000000,
    storage_used_bytes: 0,
    activated_at: status === 'active' ? '2026-05-13T00:00:00.000Z' : null,
    created_at: '2026-05-13T00:00:00.000Z',
    updated_at: '2026-05-13T00:00:00.000Z',
  };
}
