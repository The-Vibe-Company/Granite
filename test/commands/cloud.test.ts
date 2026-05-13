import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  browserLaunchCommand,
  cloudLoginCommand,
  cloudImportCommand,
  cloudMcpConfigCommand,
  cloudMcpUrlCommand,
  cloudStatusCommand,
} from '../../src/commands/cloud.js';
import { getCloudConfigPath, readCloudConfig, removeCloudConfig, updateCloudConfig, writeCloudConfig } from '../../src/core/cloud-config.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalApiKey = process.env.GRANITE_CLOUD_API_KEY;
const originalCloudUrl = process.env.GRANITE_CLOUD_URL;
const originalCloudVault = process.env.GRANITE_CLOUD_VAULT;

describe('cloud commands', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-cloud-home-'));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    delete process.env.GRANITE_CLOUD_API_KEY;
    delete process.env.GRANITE_CLOUD_URL;
    delete process.env.GRANITE_CLOUD_VAULT;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    removeCloudConfig();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    restoreEnv('HOME', originalHome);
    restoreEnv('USERPROFILE', originalUserProfile);
    restoreEnv('GRANITE_CLOUD_API_KEY', originalApiKey);
    restoreEnv('GRANITE_CLOUD_URL', originalCloudUrl);
    restoreEnv('GRANITE_CLOUD_VAULT', originalCloudVault);
  });

  it('cloud login via api key writes the local config', async () => {
    await cloudLoginCommand({
      apiKey: 'gsk_test',
      baseUrl: 'https://cloud.example',
      vault: 'v_demo',
    });

    expect(getCloudConfigPath()).toBe(path.join(tmpHome, '.granite', 'cloud.json'));
    expect(readCloudConfig()).toEqual({
      api_key: 'gsk_test',
      base_url: 'https://cloud.example',
      default_vault_id: 'v_demo',
    });
  });

  it('cloud mcp-url prints the hosted URL with a vault_id query parameter', async () => {
    await cloudLoginCommand({
      apiKey: 'gsk_test',
      baseUrl: 'https://cloud.example',
    });

    cloudMcpUrlCommand('v_demo');

    expect(console.log).toHaveBeenLastCalledWith('https://cloud.example/mcp?vault_id=v_demo');
  });

  it('cloud mcp-url fails before building a server-rejected URL when no vault is selected', async () => {
    await cloudLoginCommand({
      apiKey: 'gsk_test',
      baseUrl: 'https://cloud.example',
    });

    expect(() => cloudMcpUrlCommand()).toThrow('Cloud vault is not selected');
  });

  it('cloud mcp-config prints URL and Authorization header', async () => {
    await cloudLoginCommand({
      apiKey: 'gsk_test',
      baseUrl: 'https://cloud.example',
    });

    cloudMcpConfigCommand({ client: 'cursor', vault: 'v_demo', json: true });
    const output = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string);

    expect(output.data.url).toBe('https://cloud.example/mcp?vault_id=v_demo');
    expect(output.data.headers.Authorization).toBe('Bearer gsk_test');
    expect(output.data.config).toContain('"Authorization": "Bearer gsk_test"');
  });

  it('cloud status reports missing config with health probe result', async () => {
    stubFetch(async (url) => {
      expect(url).toBe('https://granite.thevibecompany.co/health');
      return Response.json({ status: 'ok', service: 'granite-cloudflare-mcp' });
    });

    await cloudStatusCommand({ json: true });
    const output = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string);

    expect(output.data.configured).toBe(false);
    expect(output.data.health).toEqual({ ok: true, service: 'granite-cloudflare-mcp' });
  });

  it('cloud status distinguishes invalid and valid auth', async () => {
    await cloudLoginCommand({
      apiKey: 'gsk_test',
      baseUrl: 'https://cloud.example',
      vault: 'v_demo',
    });

    stubFetch(async (url) => {
      if (url === 'https://cloud.example/health') {
        return Response.json({ status: 'ok', service: 'granite-cloudflare-mcp' });
      }
      if (url === 'https://cloud.example/vaults') {
        return Response.json({ error: 'Invalid API key.' }, { status: 401 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    await cloudStatusCommand({ json: true });
    const invalid = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string);
    expect(invalid.data.auth).toEqual({ ok: false, error: 'Invalid API key.' });

    stubFetch(async (url) => {
      if (url === 'https://cloud.example/health') {
        return Response.json({ status: 'ok', service: 'granite-cloudflare-mcp' });
      }
      if (url === 'https://cloud.example/vaults') {
        return Response.json({ vaults: [{ vault_id: 'v_demo', vault_name: 'Demo' }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    await cloudStatusCommand({ json: true });
    const valid = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string);
    expect(valid.data.auth).toEqual({ ok: true, vault_count: 1 });
  });

  it('updates env-backed cloud preferences without persisting the env API key', () => {
    process.env.GRANITE_CLOUD_API_KEY = 'gsk_env';

    updateCloudConfig({ default_vault_id: 'v_env' });

    expect(readCloudConfig()).toMatchObject({
      api_key: 'gsk_env',
      default_vault_id: 'v_env',
    });
    const stored = JSON.parse(fs.readFileSync(getCloudConfigPath(), 'utf-8'));
    expect(stored).toEqual({
      base_url: 'https://granite.thevibecompany.co',
      default_vault_id: 'v_env',
    });
  });

  it('preserves a stored custom base URL when only the API key comes from env', () => {
    writeCloudConfig({
      base_url: 'https://self-hosted.example',
      default_vault_id: 'v_stored',
    });
    process.env.GRANITE_CLOUD_API_KEY = 'gsk_env';

    expect(readCloudConfig()).toMatchObject({
      api_key: 'gsk_env',
      base_url: 'https://self-hosted.example',
      default_vault_id: 'v_stored',
    });
  });

  it('forces restrictive permissions when rewriting cloud config', () => {
    writeCloudConfig({
      api_key: 'gsk_test',
      base_url: 'https://cloud.example',
    });
    fs.chmodSync(getCloudConfigPath(), 0o644);

    updateCloudConfig({ default_vault_id: 'v_demo' });

    expect(fs.statSync(getCloudConfigPath()).mode & 0o777).toBe(0o600);
  });

  it('builds the import payload before creating a cloud vault', async () => {
    await cloudLoginCommand({
      apiKey: 'gsk_test',
      baseUrl: 'https://cloud.example',
    });
    stubFetch(async (url) => {
      throw new Error(`Unexpected cloud request before local import validation: ${url}`);
    });

    await expect(cloudImportCommand({
      from: path.join(tmpHome, 'missing-vault'),
      name: 'Missing',
    })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses a non-shell Windows browser launcher', () => {
    expect(browserLaunchCommand('https://cloud.example/login?x=1&y=2', 'win32')).toEqual({
      command: 'rundll32',
      args: ['url.dll,FileProtocolHandler', 'https://cloud.example/login?x=1&y=2'],
    });
  });
});

function stubFetch(handler: (url: string) => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    return handler(url);
  }));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
