import crypto from 'node:crypto';
import type { SpritesClient, SpriteInfo } from './sprites-client.js';

// One Granite instance = one sprite. The sprite is the source of truth for
// instance state: a marker file identifies sprites managed by granite deploy
// and preserves the MCP token across re-deploys from any machine.

export const SPRITE_NAME_PREFIX = 'granite';
export const DEFAULT_INSTANCE_NAME = 'granite';
// Granite's default vault root for the sprite user — `granite init` on released
// versions always initializes there, regardless of GRANITE_VAULT.
export const VAULT_PATH = '/home/sprite/.granite';
// Outside the vault: it holds the MCP token and must never be swept into
// vault listings or sync manifests.
export const MARKER_PATH = '/home/sprite/.granite-deploy/deploy.json';
export const SERVICE_NAME = 'granite-mcp';
export const MCP_PORT = 8080;

const EXEC_OK_MARKER = '__GRANITE_STEP_OK__';
const RESERVED_INSTANCE_NAMES = new Set(['list', 'status', 'destroy']);

export interface DeployMarker {
  granite_version: string;
  mcp_token: string;
  created: string;
  updated: string;
}

export interface DeployInstanceOptions {
  /** Instance name as typed by the user (default "granite"). */
  name: string;
  graniteVersion: string;
  template?: string;
  rotateToken?: boolean;
  force?: boolean;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
}

export interface DeployInstanceResult {
  instance: string;
  sprite: string;
  url: string;
  mcp_url: string;
  mcp_token: string;
  granite_version: string;
  previous_version: string | null;
  created: boolean;
  healthy: boolean;
}

export interface InstanceStatus {
  instance: string;
  sprite: string;
  url: string;
  mcp_url: string;
  status: string;
  granite_version: string | null;
  healthy: boolean;
  mcp_token?: string;
}

export interface DeployLogger {
  step(message: string): void;
}

const silentLogger: DeployLogger = { step: () => {} };

export class DeployError extends Error {
  constructor(message: string, readonly output?: string) {
    super(message);
    this.name = 'DeployError';
  }
}

export function resolveSpriteName(instanceName: string): string {
  const name = instanceName.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new DeployError(`Invalid instance name "${instanceName}". Use lowercase letters, digits, and dashes.`);
  }
  if (RESERVED_INSTANCE_NAMES.has(name)) {
    throw new DeployError(`"${name}" is a reserved deploy subcommand and cannot be used as an instance name.`);
  }
  if (name === SPRITE_NAME_PREFIX || name.startsWith(`${SPRITE_NAME_PREFIX}-`)) {
    return name;
  }
  return `${SPRITE_NAME_PREFIX}-${name}`;
}

export function instanceNameFromSprite(spriteName: string): string {
  if (spriteName === SPRITE_NAME_PREFIX) return DEFAULT_INSTANCE_NAME;
  return spriteName.startsWith(`${SPRITE_NAME_PREFIX}-`)
    ? spriteName.slice(SPRITE_NAME_PREFIX.length + 1)
    : spriteName;
}

export function generateMcpToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export async function deployInstance(
  client: SpritesClient,
  options: DeployInstanceOptions,
  logger: DeployLogger = silentLogger,
): Promise<DeployInstanceResult> {
  const spriteName = resolveSpriteName(options.name);
  const instance = instanceNameFromSprite(spriteName);

  let sprite = await client.getSprite(spriteName);
  let marker: DeployMarker | null = null;
  let created = false;

  if (sprite) {
    marker = await readMarker(client, spriteName);
    if (!marker && !options.force) {
      throw new DeployError(
        `Sprite "${spriteName}" exists but was not created by granite deploy. `
        + 'Pick another instance name, or re-run with --force to adopt it.',
      );
    }
  } else {
    logger.step(`Creating sprite "${spriteName}"…`);
    sprite = await client.createSprite(spriteName, 'public');
    created = true;
  }

  // Write the marker before any setup step: if a step fails mid-way, the
  // sprite stays recognized as managed and a plain re-run can resume it.
  // granite_version reflects what is actually installed, so it only advances
  // in the final marker write below.
  const mcpToken = options.rotateToken || !marker?.mcp_token ? generateMcpToken() : marker.mcp_token;
  const now = new Date().toISOString();
  const provisionalMarker: DeployMarker = {
    granite_version: marker?.granite_version ?? 'pending',
    mcp_token: mcpToken,
    created: marker?.created ?? now,
    updated: now,
  };
  await writeMarker(client, spriteName, provisionalMarker);

  logger.step('Checking Node.js…');
  await ensureNode(client, spriteName);

  logger.step(`Installing granite-mem@${options.graniteVersion}…`);
  await runStep(
    client,
    spriteName,
    `npm install -g granite-mem@${options.graniteVersion}`,
    `install granite-mem@${options.graniteVersion}`,
  );
  const { nodeBin, graniteBin } = await resolveRuntimeBins(client, spriteName);

  const hasVault = await client.readFile(spriteName, `${VAULT_PATH}/granite.yml`) !== null;
  if (!hasVault) {
    logger.step('Initializing vault…');
    const templateFlag = options.template ? ` --template ${shellQuote(options.template)}` : '';
    await runStep(
      client,
      spriteName,
      `cd /home/sprite && GRANITE_VAULT=${VAULT_PATH} ${shellQuote(nodeBin)} ${shellQuote(graniteBin)} init${templateFlag}`,
      'initialize the vault',
    );
  }

  await writeMarker(client, spriteName, {
    ...provisionalMarker,
    granite_version: options.graniteVersion,
    updated: new Date().toISOString(),
  });

  logger.step('Registering MCP service…');
  // PUT never updates an existing service definition (the API replies
  // "already running with that command") — delete first, then recreate.
  // This leaves a short window with no service; a failure here is repaired
  // by re-running deploy, which re-reads the marker and converges.
  await client.deleteService(spriteName, SERVICE_NAME);
  // Launch through the absolute node binary: freshly npm-installed global bins
  // are not on the sprite's default PATH, and services don't get a login shell.
  await client.putService(spriteName, SERVICE_NAME, {
    cmd: nodeBin,
    args: [graniteBin, 'mcp', '--transport', 'http', '--host', '0.0.0.0', '--port', String(MCP_PORT)],
    env: {
      GRANITE_VAULT: VAULT_PATH,
      GRANITE_MCP_TOKEN: mcpToken,
      GRANITE_DISABLE_DOCUMENT_PARSING: '1',
    },
    http_port: MCP_PORT,
  });

  await client.setUrlAuth(spriteName, 'public');

  logger.step('Waiting for the MCP server to come up…');
  const healthy = await waitForHealth(client, sprite, options);

  return {
    instance,
    sprite: spriteName,
    url: sprite.url,
    mcp_url: `${sprite.url}/mcp`,
    mcp_token: mcpToken,
    granite_version: options.graniteVersion,
    previous_version: marker?.granite_version ?? null,
    created,
    healthy,
  };
}

export async function listManagedInstances(client: SpritesClient): Promise<InstanceStatus[]> {
  const names = await client.listSpriteNames(SPRITE_NAME_PREFIX);
  const instances: InstanceStatus[] = [];

  for (const spriteName of names) {
    const marker = await readMarker(client, spriteName);
    if (!marker) continue;
    const sprite = await client.getSprite(spriteName);
    if (!sprite) continue;
    instances.push(await buildStatus(client, sprite, marker));
  }

  return instances;
}

export async function getInstanceStatus(
  client: SpritesClient,
  instanceName: string,
  options: { includeToken?: boolean } = {},
): Promise<InstanceStatus> {
  const spriteName = resolveSpriteName(instanceName);
  const sprite = await client.getSprite(spriteName);
  if (!sprite) {
    throw new DeployError(`No sprite named "${spriteName}" found. Deploy it first: granite deploy ${instanceNameFromSprite(spriteName)}`);
  }
  const marker = await readMarker(client, spriteName);
  if (!marker) {
    throw new DeployError(`Sprite "${spriteName}" exists but is not managed by granite deploy (no deploy marker).`);
  }
  const status = await buildStatus(client, sprite, marker);
  if (options.includeToken) {
    status.mcp_token = marker.mcp_token;
  }
  return status;
}

export async function destroyInstance(client: SpritesClient, instanceName: string): Promise<string> {
  const spriteName = resolveSpriteName(instanceName);
  const sprite = await client.getSprite(spriteName);
  if (!sprite) {
    throw new DeployError(`No sprite named "${spriteName}" found.`);
  }
  // Same managed-only rule as deploy/status: never delete a sprite that
  // granite deploy does not own — --force only skips the prompt, not this.
  const marker = await readMarker(client, spriteName);
  if (!marker) {
    throw new DeployError(
      `Sprite "${spriteName}" is not managed by granite deploy (no deploy marker). `
      + 'Delete it with the Sprites CLI or dashboard if you really mean to.',
    );
  }
  await client.deleteSprite(spriteName);
  return spriteName;
}

async function buildStatus(client: SpritesClient, sprite: SpriteInfo, marker: DeployMarker): Promise<InstanceStatus> {
  return {
    instance: instanceNameFromSprite(sprite.name),
    sprite: sprite.name,
    url: sprite.url,
    mcp_url: `${sprite.url}/mcp`,
    status: sprite.status,
    granite_version: marker.granite_version,
    healthy: sprite.url ? await client.checkHealth(`${sprite.url}/health`) : false,
  };
}

async function writeMarker(client: SpritesClient, spriteName: string, marker: DeployMarker): Promise<void> {
  await client.writeFile(spriteName, MARKER_PATH, `${JSON.stringify(marker, null, 2)}\n`, { mode: '0600' });
}

async function readMarker(client: SpritesClient, spriteName: string): Promise<DeployMarker | null> {
  const raw = await client.readFile(spriteName, MARKER_PATH);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DeployMarker>;
    if (typeof parsed.mcp_token !== 'string' || !parsed.mcp_token) return null;
    return {
      granite_version: typeof parsed.granite_version === 'string' ? parsed.granite_version : 'unknown',
      mcp_token: parsed.mcp_token,
      created: typeof parsed.created === 'string' ? parsed.created : new Date().toISOString(),
      updated: typeof parsed.updated === 'string' ? parsed.updated : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// The exec endpoint has no documented exit-code channel, so every step script
// ends with an explicit success marker; its absence means the step failed.
async function runStep(client: SpritesClient, spriteName: string, script: string, action: string): Promise<string> {
  const output = await client.exec(spriteName, `set -eo pipefail; { ${script}; } && echo ${EXEC_OK_MARKER}`);
  if (!output.includes(EXEC_OK_MARKER)) {
    throw new DeployError(
      `Failed to ${action} on sprite "${spriteName}". Steps are idempotent — fix the issue and re-run granite deploy.`,
      output.trim(),
    );
  }
  return output.replaceAll(EXEC_OK_MARKER, '').trim();
}

async function ensureNode(client: SpritesClient, spriteName: string): Promise<void> {
  const probe = await client.exec(spriteName, 'node -v 2>/dev/null || echo missing');
  const version = probe.match(/v(\d+)\./);
  if (version && Number.parseInt(version[1], 10) >= 20) return;

  await runStep(
    client,
    spriteName,
    'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs',
    'install Node.js 22',
  );
}

// npm global bins land in the nvm prefix, which is not on the sprite's PATH —
// resolve absolute paths instead of relying on `command -v granite`.
async function resolveRuntimeBins(
  client: SpritesClient,
  spriteName: string,
): Promise<{ nodeBin: string; graniteBin: string }> {
  const output = await runStep(
    client,
    spriteName,
    'NODE_BIN="$(command -v node)" && GRANITE_BIN="$(npm prefix -g)/bin/granite" && test -x "$NODE_BIN" && test -e "$GRANITE_BIN" && printf "%s\\n%s\\n" "$NODE_BIN" "$GRANITE_BIN"',
    'locate the node and granite binaries',
  );
  const lines = output.split('\n').map(line => line.trim()).filter(line => line.startsWith('/'));
  const nodeBin = lines.at(-2);
  const graniteBin = lines.at(-1);
  if (!nodeBin || !graniteBin) {
    throw new DeployError(`Could not locate the node/granite binaries on sprite "${spriteName}".`, output);
  }
  return { nodeBin, graniteBin };
}

async function waitForHealth(
  client: SpritesClient,
  sprite: SpriteInfo,
  options: Pick<DeployInstanceOptions, 'healthTimeoutMs' | 'healthIntervalMs'>,
): Promise<boolean> {
  if (!sprite.url) return false;
  const timeoutMs = options.healthTimeoutMs ?? 90_000;
  const intervalMs = options.healthIntervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  const healthUrl = `${sprite.url}/health`;

  while (Date.now() < deadline) {
    if (await client.checkHealth(healthUrl)) return true;
    await sleep(intervalMs);
  }
  return client.checkHealth(healthUrl);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
