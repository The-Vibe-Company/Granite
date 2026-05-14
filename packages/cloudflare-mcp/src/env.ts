export interface Env {
  VAULT_BUCKET: R2Bucket;
  VAULT_OBJECT: DurableObjectNamespace;
  BASE_URL: string;
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
  NEON_AUTH_BASE_URL?: string;
  NEON_AUTH_JWKS_URL?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_VAULT_1GB_PRICE_ID?: string;
  TEST_DB?: import('./db.js').AppDatabase;
  TEST_STRIPE?: import('./billing.js').StripeBilling;
}

export interface User {
  id: string;
  neon_user_id: string | null;
  email: string | null;
  display_name: string | null;
  stripe_customer_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppVariables {
  user: User;
  vault: VaultRow;
}

export interface VaultRow {
  vault_id: string;
  user_id: string;
  vault_name: string;
  billing_status: VaultBillingStatus;
  stripe_subscription_id: string | null;
  stripe_checkout_session_id: string | null;
  stripe_price_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  storage_limit_bytes: number;
  storage_used_bytes: number;
  activated_at: string | null;
  created_at: string;
  updated_at: string;
}

export type VaultBillingStatus =
  | 'pending_checkout'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid';

export interface NeonAuthUser {
  id: string;
  email: string | null;
  display_name: string | null;
}
