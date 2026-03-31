export interface Env {
  DB: D1Database;
  VAULT_BUCKET: R2Bucket;
  BASE_URL: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_ID?: string;
}

export type Tier = 'free' | 'pro';

export interface User {
  id: string;
  github_id: number | null;
  email: string | null;
  github_username: string | null;
  tier: Tier;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: string;
  updated_at: string;
}

export const TIER_LIMITS = {
  free: {
    maxVaults: 1,
    maxNotesPerVault: 0, // no sync on free tier
    maxStorageBytes: 0,
    rateLimit: 0,
    syncEnabled: false,
  },
  pro: {
    maxVaults: 10,
    maxNotesPerVault: 50_000,
    maxStorageBytes: 1_073_741_824, // 1 GB
    rateLimit: 300,
    syncEnabled: true,
  },
} as const;
