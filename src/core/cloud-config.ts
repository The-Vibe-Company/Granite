import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GraniteCloudConfig {
  base_url: string;
  api_key?: string;
  default_vault_id?: string;
}

export type ResolvedGraniteCloudConfig = GraniteCloudConfig & { api_key: string };

export const DEFAULT_CLOUD_BASE_URL = 'https://granite.thevibecompany.co';

export function getCloudConfigPath(): string {
  return path.join(getCloudConfigDir(), 'cloud.json');
}

export function readCloudConfig(): ResolvedGraniteCloudConfig | null {
  const storedConfig = readStoredCloudConfig();
  const envConfig = readCloudConfigFromEnv();
  if (envConfig) {
    return {
      ...storedConfig,
      ...envConfig,
      base_url: process.env.GRANITE_CLOUD_URL
        ? envConfig.base_url
        : storedConfig?.base_url ?? envConfig.base_url,
      default_vault_id: envConfig.default_vault_id ?? storedConfig?.default_vault_id,
    };
  }
  if (storedConfig?.api_key) {
    return {
      ...storedConfig,
      base_url: storedConfig.base_url || DEFAULT_CLOUD_BASE_URL,
      api_key: storedConfig.api_key,
    };
  }
  return null;
}

function readStoredCloudConfig(): GraniteCloudConfig | null {
  try {
    return JSON.parse(fs.readFileSync(getCloudConfigPath(), 'utf-8')) as GraniteCloudConfig;
  } catch {
    return null;
  }
}

export function requireCloudConfig(): ResolvedGraniteCloudConfig {
  const config = readCloudConfig();
  if (!config?.api_key) {
    throw new Error('Granite Cloud is not configured. Run: granite cloud login --api-key <key> --base-url <url>');
  }
  return config;
}

export function writeCloudConfig(config: GraniteCloudConfig): void {
  fs.mkdirSync(getCloudConfigDir(), { recursive: true });
  const configPath = getCloudConfigPath();
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
}

export function updateCloudConfig(patch: Partial<GraniteCloudConfig>): GraniteCloudConfig {
  const stored = readStoredCloudConfig();
  const envConfig = readCloudConfigFromEnv();
  if (!stored?.api_key && !patch.api_key && !envConfig?.api_key) {
    throw new Error('Granite Cloud is not configured. Run: granite cloud login first.');
  }
  const next: GraniteCloudConfig = {
    base_url: stored?.base_url ?? envConfig?.base_url ?? DEFAULT_CLOUD_BASE_URL,
    ...stored,
    ...patch,
  } as GraniteCloudConfig;
  if (!next.api_key) delete next.api_key;
  writeCloudConfig(next);
  return next;
}

export function removeCloudConfig(): void {
  try {
    fs.unlinkSync(getCloudConfigPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function getCloudConfigDir(): string {
  return path.join(os.homedir(), '.granite');
}

function readCloudConfigFromEnv(): ResolvedGraniteCloudConfig | null {
  const apiKey = process.env.GRANITE_CLOUD_API_KEY;
  if (!apiKey) return null;
  return {
    base_url: process.env.GRANITE_CLOUD_URL || DEFAULT_CLOUD_BASE_URL,
    api_key: apiKey,
    default_vault_id: process.env.GRANITE_CLOUD_VAULT,
  };
}
