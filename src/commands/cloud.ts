import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { CloudClient, type CloudCreateNoteInput, type CloudNoteSummary, type CloudUpdateNoteInput } from '../core/cloud-client.js';
import {
  DEFAULT_CLOUD_BASE_URL,
  getCloudConfigPath,
  readCloudConfig,
  removeCloudConfig,
  updateCloudConfig,
} from '../core/cloud-config.js';
import { jsonSuccess } from '../core/json-output.js';
import { loadConfig } from '../core/config.js';
import { listNotes } from '../core/note.js';

export async function cloudLoginCommand(options: { apiKey?: string; baseUrl?: string; vault?: string; noBrowser?: boolean }): Promise<void> {
  const baseUrl = options.baseUrl ?? process.env.GRANITE_CLOUD_URL ?? readCloudConfig()?.base_url ?? DEFAULT_CLOUD_BASE_URL;
  const apiKey = options.apiKey;
  if (!apiKey) {
    const result = await browserLogin(baseUrl, options.noBrowser ?? false);
    const config = updateCloudConfig({
      api_key: result.api_key,
      base_url: baseUrl,
      default_vault_id: options.vault ?? process.env.GRANITE_CLOUD_VAULT ?? readCloudConfig()?.default_vault_id,
    });
    console.log(`Granite Cloud configured for ${result.username}: ${config.base_url}`);
    console.log(`Config: ${getCloudConfigPath()}`);
    return;
  }

  const config = updateCloudConfig({
    api_key: apiKey,
    base_url: baseUrl,
    default_vault_id: options.vault ?? process.env.GRANITE_CLOUD_VAULT ?? readCloudConfig()?.default_vault_id,
  });
  console.log(`Granite Cloud configured: ${config.base_url}`);
  console.log(`Config: ${getCloudConfigPath()}`);
}

export function cloudLogoutCommand(): void {
  removeCloudConfig();
  console.log('Granite Cloud credentials removed.');
}

export async function cloudStatusCommand(options: { json?: boolean }): Promise<void> {
  const config = readCloudConfig();
  if (!config) {
    const out = { configured: false, health: await probeHealth(DEFAULT_CLOUD_BASE_URL) };
    if (options.json) console.log(jsonSuccess(out));
    else console.log('Granite Cloud is not configured.');
    return;
  }

  const client = new CloudClient(config);
  const health = await probeHealth(config.base_url);
  const auth = await probeAuth(client);
  const data = {
    configured: true,
    base_url: config.base_url,
    default_vault_id: config.default_vault_id,
    config_path: process.env.GRANITE_CLOUD_API_KEY ? '(env)' : getCloudConfigPath(),
    health,
    auth,
  };
  if (options.json) console.log(jsonSuccess(data));
  else {
    console.log('Granite Cloud configured');
    console.log(`  URL:   ${data.base_url}`);
    console.log(`  Vault: ${data.default_vault_id ?? '(first vault)'}`);
    console.log(`  Config: ${data.config_path}`);
    console.log(`  Health: ${health.ok ? 'ok' : `failed (${health.error})`}`);
    console.log(`  Auth:   ${auth.ok ? `ok (${auth.vault_count} vault(s))` : `failed (${auth.error})`}`);
  }
}

export async function cloudKeysCommand(options: { json?: boolean }): Promise<void> {
  const keys = await new CloudClient().listKeys();
  if (options.json) {
    console.log(jsonSuccess(keys));
    return;
  }
  if (keys.length === 0) {
    console.log('No API keys found.');
    return;
  }
  for (const key of keys) {
    const revoked = key.revoked_at ? 'revoked' : 'active';
    console.log(`  ${key.key_prefix}  ${revoked.padEnd(7)}  ${key.name}  created ${key.created_at}`);
  }
}

export async function cloudCreateKeyCommand(options: { name?: string; json?: boolean }): Promise<void> {
  const key = await new CloudClient().createKey(options.name ?? 'manual');
  if (options.json) console.log(jsonSuccess(key));
  else {
    console.log(`Created API key: ${key.key_prefix}`);
    console.log(key.api_key);
  }
}

export async function cloudRevokeKeyCommand(prefix: string, options: { json?: boolean }): Promise<void> {
  const result = await new CloudClient().revokeKey(prefix);
  if (options.json) console.log(jsonSuccess(result));
  else console.log(`Revoked API key: ${prefix}`);
}

export async function cloudVaultsCommand(options: { json?: boolean }): Promise<void> {
  const vaults = await new CloudClient().listVaults();
  if (options.json) {
    console.log(jsonSuccess(vaults));
    return;
  }
  if (vaults.length === 0) {
    console.log('No cloud vaults found. Create one: granite cloud create --name "My Vault"');
    return;
  }
  for (const vault of vaults) {
    console.log(`  ${vault.vault_id}  ${vault.vault_name}`);
  }
}

export async function cloudCreateCommand(options: { name?: string; json?: boolean }): Promise<void> {
  const vault = await new CloudClient().createVault(options.name ?? 'Cloud Vault');
  updateCloudConfig({ default_vault_id: vault.vault_id });
  if (options.json) console.log(jsonSuccess(vault));
  else {
    console.log(`Created cloud vault: ${vault.vault_name} (${vault.vault_id})`);
    console.log('Set as default cloud vault.');
  }
}

export async function cloudImportCommand(options: { from?: string; name?: string; vault?: string; json?: boolean }): Promise<void> {
  const from = path.resolve(options.from ?? process.cwd());
  const payload = buildImportPayload(from);
  const client = new CloudClient();
  const vault = options.vault
    ? { vault_id: options.vault, vault_name: options.name ?? options.vault }
    : await client.createVault(options.name ?? (path.basename(from) || 'Imported Vault'));

  const result = await client.importVault(vault.vault_id, payload);
  updateCloudConfig({ default_vault_id: vault.vault_id });

  const out = { vault, ...result };
  if (options.json) console.log(jsonSuccess(out));
  else {
    console.log(`Imported ${result.note_count} note(s) and ${result.asset_count} asset(s) into ${vault.vault_name} (${vault.vault_id}).`);
    console.log('Set as default cloud vault.');
  }
}

export async function cloudListCommand(options: {
  type?: string;
  status?: string;
  source?: string;
  since?: string;
  json?: boolean | string;
}, vaultId?: string): Promise<void> {
  const notes = await new CloudClient().listNotes({ ...options, vaultId });
  const sorted = notes.sort((a, b) => b.modified.localeCompare(a.modified));
  if (options.json !== undefined && options.json !== false) {
    const fields = typeof options.json === 'string'
      ? options.json.split(',').map(field => field.trim()).filter(Boolean)
      : undefined;
    console.log(jsonSuccess(fields ? sorted.map(note => pickFields(note, fields)) : sorted));
    return;
  }
  if (sorted.length === 0) {
    console.log('No notes found.');
    return;
  }
  for (const note of sorted) {
    console.log(`  ${note.modified.slice(0, 10)}  ${(note.type ?? '').padEnd(10)}  ${(note.status ?? '').padEnd(8)}  ${note.title}  (${note.slug})`);
  }
  console.log(`\n${sorted.length} note(s)`);
}

function pickFields(note: CloudNoteSummary, fields: string[]): Record<string, unknown> {
  const record = note as unknown as Record<string, unknown>;
  return Object.fromEntries(fields.map(field => [field, record[field]]));
}

export async function cloudShowCommand(slug: string, options: { json?: boolean; body?: boolean }, vaultId?: string): Promise<void> {
  const note = await new CloudClient().getNote(slug, vaultId);
  if (options.json) {
    console.log(jsonSuccess(note));
    return;
  }
  if (options.body) {
    process.stdout.write(note.body);
    return;
  }
  console.log(`# ${note.title}  (${note.slug})`);
  console.log(`# type: ${note.type}  |  modified: ${note.modified.slice(0, 10)}  |  review: ${note.review_state}  |  durability: ${note.durability}`);
  console.log('');
  console.log(note.body);
}

export async function cloudSearchCommand(query: string, options: { json?: boolean }, vaultId?: string): Promise<void> {
  const results = await new CloudClient().search(query, vaultId);
  if (options.json) {
    console.log(jsonSuccess(results));
    return;
  }
  if (results.length === 0) {
    console.log('No results found.');
    return;
  }
  for (const result of results) {
    console.log(`  ${result.title} (${result.slug})`);
    console.log(`    ${result.snippet}`);
    console.log('');
  }
  console.log(`${results.length} result(s) for "${query}"`);
}

export async function cloudNewCommand(title: string, options: {
  type?: string;
  source?: string;
  status?: string;
  reviewState?: string;
  durability?: string;
  derivedFrom?: string;
  json?: boolean;
}, vaultId?: string): Promise<void> {
  const input: CloudCreateNoteInput = {
    title,
    type: options.type,
    source: options.source,
    status: options.status,
    review_state: options.reviewState,
    durability: options.durability,
    derived_from: splitRefs(options.derivedFrom),
  };
  const result = await new CloudClient().createNote(input, vaultId);
  if (options.json) console.log(jsonSuccess(result));
  else {
    console.log(result.note.filepath ?? result.note.slug);
    console.log('');
    console.log(`Created "${result.note.title}" (${result.note.slug}) in cloud vault.`);
  }
}

export async function cloudAddCommand(text: string | undefined, options: { json?: boolean }, vaultId?: string): Promise<void> {
  let content = text ?? '';
  if (!content && !process.stdin.isTTY) content = fs.readFileSync(0, 'utf-8').trim();
  if (!content) {
    console.error('Usage: granite --vault cloud add "some text" or echo "text" | granite --vault cloud add');
    process.exit(1);
  }
  const firstLine = content.split('\n')[0];
  const title = firstLine.length > 60 ? `${firstLine.slice(0, 60).trim()}...` : firstLine;
  const result = await new CloudClient().createNote({ title, body: `${content}\n` }, vaultId);
  if (options.json) console.log(jsonSuccess(result));
  else {
    console.log(result.note.filepath ?? result.note.slug);
    console.log('');
    console.log(`Captured as "${result.note.title}" (${result.note.slug}) in cloud vault.`);
  }
}

export async function cloudEditCommand(slug: string, options: {
  body?: string;
  append?: string;
  title?: string;
  tag?: string;
  alias?: string;
  status?: string;
  source?: string;
  reviewState?: string;
  durability?: string;
  derivedFrom?: string;
}, vaultId?: string): Promise<void> {
  const input: CloudUpdateNoteInput = {
    title: options.title,
    body: options.body,
    append: options.append,
    tags: splitRefs(options.tag),
    aliases: splitRefs(options.alias),
    status: options.status,
    source: options.source,
    review_state: options.reviewState,
    durability: options.durability,
    derived_from: splitRefs(options.derivedFrom),
  };
  const result = await new CloudClient().updateNote(slug, input, vaultId);
  console.log(result.note.filepath ?? result.note.slug);
}

export function cloudMcpUrlCommand(vaultId?: string): void {
  console.log(new CloudClient().mcpUrl(vaultId));
}

export function cloudMcpConfigCommand(options: { client?: string; vault?: string; json?: boolean }): void {
  const client = new CloudClient();
  const url = client.mcpUrl(options.vault);
  const config = readCloudConfig();
  const apiKey = config?.api_key ?? '${GRANITE_CLOUD_API_KEY}';
  const name = options.client ?? 'generic';
  const snippet = mcpConfigSnippet(name, url, apiKey);
  if (options.json) {
    console.log(jsonSuccess({ client: name, url, headers: { Authorization: `Bearer ${apiKey}` }, config: snippet }));
    return;
  }
  console.log(snippet);
}

function buildImportPayload(vaultRoot: string) {
  const config = fs.readFileSync(path.join(vaultRoot, 'granite.yml'), 'utf-8');
  const graniteConfig = loadConfig(vaultRoot);
  const notes = listNotes(vaultRoot, graniteConfig).map(note => ({
    path: path.relative(vaultRoot, note.filepath),
    content: fs.readFileSync(note.filepath, 'utf-8'),
  }));

  const assetsDir = path.join(vaultRoot, 'assets');
  const assets = fs.existsSync(assetsDir)
    ? walkFiles(assetsDir).map(file => ({
        path: path.relative(vaultRoot, file),
        content_base64: fs.readFileSync(file).toString('base64'),
        content_type: contentType(file),
      }))
    : [];

  return { config, notes, assets };
}

function walkFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function contentType(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    case '.pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

function splitRefs(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

async function browserLogin(baseUrl: string, noBrowser: boolean): Promise<{ api_key: string; username: string }> {
  const session = randomUUID();
  const pollSecret = randomUUID();
  const normalized = baseUrl.replace(/\/+$/, '');
  const startResponse = await fetch(`${normalized}/auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, poll_secret: pollSecret }),
  });
  if (!startResponse.ok) {
    throw new Error(`Login failed: ${startResponse.status} ${startResponse.statusText}`);
  }
  const start = await startResponse.json() as { login_url: string };

  console.log('Open this URL to log in to Granite Cloud:');
  console.log(start.login_url);
  if (!noBrowser) openBrowser(start.login_url);

  const verificationCode = await promptVerificationCode();
  console.log('Verifying browser login...');

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const response = await fetch(`${normalized}/auth/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session,
        poll_secret: pollSecret,
        verification_code: verificationCode,
      }),
    });
    if (response.status === 200) {
      return await response.json() as { api_key: string; username: string };
    }
    if (response.status !== 202) {
      throw new Error(`Login failed: ${response.status} ${response.statusText}`);
    }
    await sleep(2000);
  }
  throw new Error('Timed out waiting for Granite Cloud login.');
}

async function promptVerificationCode(): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question('Enter the verification code shown in the browser: ')).trim();
  } finally {
    rl.close();
  }
}

function openBrowser(url: string): void {
  const { command, args } = browserLaunchCommand(url);
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

export function browserLaunchCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  return { command: 'xdg-open', args: [url] };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function probeHealth(baseUrl: string): Promise<{ ok: boolean; service?: string; error?: string }> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/health`);
    if (!response.ok) return { ok: false, error: `${response.status} ${response.statusText}` };
    const body = await response.json() as { service?: string };
    return { ok: true, service: body.service };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function probeAuth(client: CloudClient): Promise<{ ok: boolean; vault_count?: number; error?: string }> {
  try {
    const vaults = await client.listVaults();
    return { ok: true, vault_count: vaults.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function mcpConfigSnippet(client: string, url: string, apiKey: string): string {
  const config = {
    mcpServers: {
      granite: {
        url,
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    },
  };

  if (client === 'cursor') {
    return JSON.stringify(config, null, 2);
  }
  if (client === 'claude' || client === 'claude-desktop') {
    return JSON.stringify(config, null, 2);
  }
  return JSON.stringify(config, null, 2);
}
