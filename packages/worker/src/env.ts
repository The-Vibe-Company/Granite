export interface Env {
  DB: D1Database;
  VAULT_BUCKET: R2Bucket;
}

export interface AuthedContext {
  vaultId: string;
  vaultName: string;
}
