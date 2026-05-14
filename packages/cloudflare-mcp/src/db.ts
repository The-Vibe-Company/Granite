import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { Env, NeonAuthUser, User, VaultRow } from './env.js';

export interface QueryResult {
  rowCount: number;
}

export interface AppDatabase {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  first<T = unknown>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<QueryResult>;
}

export function database(env: Env): AppDatabase {
  if (env.TEST_DB) return env.TEST_DB;
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL or HYPERDRIVE binding is required.');
  return new NeonDatabase(connectionString);
}

export class NeonDatabase implements AppDatabase {
  private sql: NeonQueryFunction<false, false>;

  constructor(connectionString: string) {
    this.sql = neon(connectionString);
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    return await this.sql.query(sql, params) as T[];
  }

  async first<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (await this.query<T>(sql, params))[0] ?? null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const result = await this.sql.query(sql, params, { fullResults: true }) as unknown as { rowCount?: number };
    return { rowCount: result.rowCount ?? 0 };
  }
}

export async function upsertNeonUser(db: AppDatabase, input: NeonAuthUser): Promise<User> {
  const row = await db.first<User>(`
    INSERT INTO users (id, neon_user_id, email, display_name)
    VALUES ($1, $1, $2, $3)
    ON CONFLICT (neon_user_id) DO UPDATE SET
      email = COALESCE(EXCLUDED.email, users.email),
      display_name = COALESCE(EXCLUDED.display_name, users.display_name),
      updated_at = now()
    RETURNING id, neon_user_id, email, display_name, stripe_customer_id, created_at, updated_at
  `, [input.id, input.email, input.display_name]);
  if (!row) throw new Error('Failed to upsert Neon Auth user.');
  return row;
}

export async function findUserByApiKeyHash(db: AppDatabase, keyHash: string): Promise<User | null> {
  return db.first<User>(`
    SELECT u.id, u.neon_user_id, u.email, u.display_name, u.stripe_customer_id, u.created_at, u.updated_at
    FROM api_keys k
    JOIN users u ON u.id = k.user_id
    WHERE k.key_hash = $1 AND k.revoked_at IS NULL
  `, [keyHash]);
}

export async function touchApiKey(db: AppDatabase, keyHash: string): Promise<void> {
  await db.execute('UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1', [keyHash]);
}

export function vaultCanRead(vault: VaultRow): boolean {
  return ['active', 'past_due', 'canceled', 'unpaid'].includes(vault.billing_status);
}

export function vaultCanWrite(vault: VaultRow): boolean {
  return vault.billing_status === 'active';
}

export async function ownedVault(db: AppDatabase, userId: string, vaultId: string): Promise<VaultRow | null> {
  return db.first<VaultRow>(`
    SELECT vault_id, user_id, vault_name, billing_status, stripe_subscription_id,
      stripe_checkout_session_id, stripe_price_id, current_period_end, cancel_at_period_end,
      storage_limit_bytes, storage_used_bytes, activated_at, created_at, updated_at
    FROM vaults
    WHERE vault_id = $1 AND user_id = $2
  `, [vaultId, userId]);
}

export async function reserveVaultBytes(db: AppDatabase, vaultId: string, delta: number): Promise<void> {
  if (delta === 0) return;
  const row = await db.first<{ storage_used_bytes: number }>(`
    UPDATE vaults
    SET storage_used_bytes = GREATEST(0, storage_used_bytes + $2), updated_at = now()
    WHERE vault_id = $1 AND ($2 <= 0 OR storage_used_bytes + $2 <= storage_limit_bytes)
    RETURNING storage_used_bytes
  `, [vaultId, delta]);
  if (!row) throw new Error('Vault storage quota exceeded.');
}
