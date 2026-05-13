export interface Env {
  ACCOUNTS_DB: D1Database;
  VAULT_BUCKET: R2Bucket;
  VAULT_OBJECT: DurableObjectNamespace;
  BASE_URL: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

export interface User {
  id: string;
  github_id: number | null;
  email: string | null;
  github_username: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppVariables {
  user: User;
  vaultId: string;
}

export interface VaultRow {
  vault_id: string;
  user_id: string;
  vault_name: string;
  created_at: string;
  updated_at: string;
}
