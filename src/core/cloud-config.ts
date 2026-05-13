import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GraniteCloudConfig {
  base_url: string;
  api_key: string;
  default_vault_id?: string;
}

export const DEFAULT_CLOUD_BASE_URL = 'https://granite.thevibecompany.co';

export function getCloudConfigPath(): string {
  return path.join(getCloudConfigDir(), 'cloud.json');
}

export function readCloudConfig(): GraniteCloudConfig | null {
  const envConfig = readCloudConfigFromEnv();
  if (envConfig) return envConfig;
  return readStoredCloudConfig();
}

function readStoredCloudConfig(): GraniteCloudConfig | null {
  try {
    return JSON.parse(fs.readFileSync(getCloudConfigPath(), 'utf-8')) as GraniteCloudConfig;
  } catch {
    return null;
  }
}

export function requireCloudConfig(): GraniteCloudConfig {
  const config = readCloudConfig();
  if (!config?.api_key) {
    throw new Error('Granite Cloud is not configured. Run: granite cloud login --api-key <key> --base-url <url>');
  }
  return config;
}

export function writeCloudConfig(config: GraniteCloudConfig): void {
  fs.mkdirSync(getCloudConfigDir(), { recursive: true });
  fs.writeFileSync(getCloudConfigPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function updateCloudConfig(patch: Partial<GraniteCloudConfig>): GraniteCloudConfig {
  const next: GraniteCloudConfig = {
    base_url: DEFAULT_CLOUD_BASE_URL,
    api_key: '',
    ...(readStoredCloudConfig() ?? {}),
    ...patch,
  };
  writeCloudConfig(next);
  return next;
}

export function removeCloudConfig(): void {
  try {
    fs.unlinkSync(getCloudConfigPath());
  } catch {}
}

function getCloudConfigDir(): string {
  return path.join(os.homedir(), '.granite');
}

function readCloudConfigFromEnv(): GraniteCloudConfig | null {
  const apiKey = process.env.GRANITE_CLOUD_API_KEY;
  if (!apiKey) return null;
  return {
    base_url: process.env.GRANITE_CLOUD_URL || DEFAULT_CLOUD_BASE_URL,
    api_key: apiKey,
    default_vault_id: process.env.GRANITE_CLOUD_VAULT,
  };
}
