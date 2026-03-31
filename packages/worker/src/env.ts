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
    maxNotesPerVault: 100,
    rateLimit: 30, // sync pushes per hour
  },
  pro: {
    maxVaults: 10,
    maxNotesPerVault: 10_000,
    rateLimit: 300,
  },
} as const;
