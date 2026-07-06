import readline from 'node:readline/promises';
import { jsonSuccess } from '../core/json-output.js';
import { GRANITE_VERSION } from '../version.js';
import {
  DEFAULT_INSTANCE_NAME,
  DeployError,
  VAULT_PATH,
  deployInstance,
  destroyInstance,
  getInstanceStatus,
  listManagedInstances,
  resolveSpriteName,
} from '../core/deploy/deploy.js';
import type { DeployInstanceResult, InstanceStatus } from '../core/deploy/deploy.js';
import { HttpSpritesClient, SpritesApiError } from '../core/deploy/sprites-client.js';
import type { SpritesClient } from '../core/deploy/sprites-client.js';
import {
  deleteStoredSpritesToken,
  getSpritesCredentialsPath,
  resolveSpritesToken,
  saveSpritesToken,
} from '../core/deploy/credentials.js';

interface DeployCommandOptions {
  token?: string;
  template?: string;
  rotateToken?: boolean;
  force?: boolean;
  all?: boolean;
  json?: boolean;
}

interface DeployStatusOptions {
  token?: string;
  showToken?: boolean;
  json?: boolean;
}

interface DeployDestroyOptions {
  token?: string;
  force?: boolean;
}

interface DeployListOptions {
  token?: string;
  json?: boolean;
}

interface DeployLoginOptions {
  token?: string;
}

// Injectable for tests; production always talks to the real Sprites API.
export type SpritesClientFactory = (token: string) => SpritesClient;

// Test-only override for the health polling window.
export type HealthOverrides = { healthTimeoutMs?: number; healthIntervalMs?: number };

const defaultClientFactory: SpritesClientFactory = token => new HttpSpritesClient({ token });

export async function deployCommand(
  name: string | undefined,
  options: DeployCommandOptions,
  clientFactory: SpritesClientFactory = defaultClientFactory,
  healthOverrides: HealthOverrides = {},
): Promise<void> {
  const client = clientFactory(requireSpritesToken(options.token));

  try {
    if (options.all) {
      if (name) {
        console.error('Pass either an instance name or --all, not both.');
        process.exit(1);
      }
      if (options.rotateToken || options.template) {
        console.error('--rotate-token and --template apply to a single instance — pass an instance name instead of --all.');
        process.exit(1);
      }
      await deployAll(client, options, healthOverrides);
      return;
    }

    const result = await deployInstance(client, {
      name: name ?? DEFAULT_INSTANCE_NAME,
      graniteVersion: GRANITE_VERSION,
      template: options.template,
      rotateToken: options.rotateToken,
      force: options.force,
      ...healthOverrides,
    }, { step: message => console.error(message) });

    if (options.json) {
      console.log(jsonSuccess(result));
    } else {
      printDeployResult(result);
    }
    if (!result.healthy) {
      process.exit(1);
    }
  } catch (error) {
    failWithDeployError(error);
  }
}

export async function deployListCommand(
  options: DeployListOptions,
  clientFactory: SpritesClientFactory = defaultClientFactory,
): Promise<void> {
  const client = clientFactory(requireSpritesToken(options.token));

  try {
    const instances = await listManagedInstances(client);

    if (options.json) {
      console.log(jsonSuccess({ instances }));
      return;
    }

    if (instances.length === 0) {
      console.log('No Granite instances deployed. Create one: granite deploy');
      return;
    }

    for (const instance of instances) {
      console.log(formatInstanceLine(instance));
    }
  } catch (error) {
    failWithDeployError(error);
  }
}

export async function deployStatusCommand(
  name: string | undefined,
  options: DeployStatusOptions,
  clientFactory: SpritesClientFactory = defaultClientFactory,
): Promise<void> {
  const client = clientFactory(requireSpritesToken(options.token));

  try {
    const status = await getInstanceStatus(client, name ?? DEFAULT_INSTANCE_NAME, {
      includeToken: options.showToken,
    });

    if (options.json) {
      console.log(jsonSuccess(status));
      return;
    }

    console.log(`Instance : ${status.instance} (sprite "${status.sprite}")`);
    console.log(`Status   : ${status.status}${status.healthy ? ' · MCP healthy' : ' · MCP unreachable'}`);
    console.log(`Version  : granite-mem ${status.granite_version ?? 'unknown'}`);
    console.log(`MCP URL  : ${status.mcp_url}`);
    if (status.mcp_token) {
      console.log(`Token    : ${status.mcp_token}`);
    }
  } catch (error) {
    failWithDeployError(error);
  }
}

export async function deployDestroyCommand(
  name: string | undefined,
  options: DeployDestroyOptions,
  clientFactory: SpritesClientFactory = defaultClientFactory,
): Promise<void> {
  const client = clientFactory(requireSpritesToken(options.token));
  const instanceName = name ?? DEFAULT_INSTANCE_NAME;

  try {
    const spriteName = resolveSpriteName(instanceName);

    if (!options.force) {
      if (!process.stdin.isTTY) {
        console.error(`Refusing to destroy "${spriteName}" without confirmation. Re-run with --force.`);
        process.exit(1);
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      const answer = await rl.question(
        `This permanently deletes sprite "${spriteName}" and the cloud vault it contains. Type the sprite name to confirm: `,
      );
      rl.close();
      if (answer.trim() !== spriteName) {
        console.error('Aborted.');
        process.exit(1);
      }
    }

    const destroyed = await destroyInstance(client, instanceName);
    console.log(`Destroyed sprite "${destroyed}".`);
  } catch (error) {
    failWithDeployError(error);
  }
}

export function deployLoginCommand(options: DeployLoginOptions): void {
  const token = resolveSpritesToken(options.token);
  if (!token) {
    console.error('Missing Sprites token. Pass --token, or set SPRITES_TOKEN before running login.');
    process.exit(1);
  }
  const filePath = saveSpritesToken(token);
  console.log(`Saved Sprites token to ${filePath}`);
}

export function deployLogoutCommand(): void {
  const removed = deleteStoredSpritesToken();
  if (removed) {
    console.log(`Removed Sprites token from ${getSpritesCredentialsPath()}`);
  } else {
    console.log(`No stored Sprites token found at ${getSpritesCredentialsPath()}`);
  }
}

async function deployAll(
  client: SpritesClient,
  options: DeployCommandOptions,
  healthOverrides: HealthOverrides = {},
): Promise<void> {
  const instances = await listManagedInstances(client);
  if (instances.length === 0) {
    console.log('No Granite instances deployed. Create one: granite deploy');
    return;
  }

  // Bulk output deliberately omits mcp_token — bulk updates land in CI logs;
  // fetch a token explicitly with `deploy status <name> --show-token`.
  const results: Array<{ instance: string; ok: boolean; detail: string; mcp_url?: string; granite_version?: string }> = [];

  for (const instance of instances) {
    console.error(`— Updating "${instance.instance}"…`);
    try {
      const result = await deployInstance(client, {
        name: instance.instance,
        graniteVersion: GRANITE_VERSION,
        ...healthOverrides,
      }, { step: message => console.error(`  ${message}`) });
      results.push({
        instance: instance.instance,
        ok: result.healthy,
        detail: `${result.previous_version ?? '?'} → ${result.granite_version}${result.healthy ? '' : ' (MCP unreachable)'}`,
        mcp_url: result.mcp_url,
        granite_version: result.granite_version,
      });
    } catch (error) {
      results.push({
        instance: instance.instance,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (options.json) {
    console.log(jsonSuccess({ updated: results }));
  } else {
    console.log('');
    for (const entry of results) {
      console.log(`${entry.ok ? '✓' : '✗'} ${entry.instance} — ${entry.detail}`);
    }
  }

  if (results.some(entry => !entry.ok)) {
    process.exit(1);
  }
}

function printDeployResult(result: DeployInstanceResult): void {
  console.log('');
  console.log(result.created
    ? `Granite deployed (instance "${result.instance}").`
    : `Granite updated (instance "${result.instance}", ${result.previous_version ?? '?'} → ${result.granite_version}).`);
  console.log('');
  console.log(`  MCP URL : ${result.mcp_url}`);
  console.log(`  Token   : ${result.mcp_token}`);
  console.log('');
  console.log('  Add it to Claude Code:');
  console.log(`    claude mcp add --transport http granite ${result.mcp_url} \\`);
  console.log(`      --header "Authorization: Bearer ${result.mcp_token}"`);
  console.log('');
  console.log(`  The sprite sleeps when idle (idle cost ≈ storage only). Vault: ${VAULT_PATH} on the sprite.`);
  console.log(`  Update later: granite deploy ${result.instance} · All instances: granite deploy --all`);
  if (!result.healthy) {
    console.log('');
    console.log('  ⚠ The MCP health check did not pass yet. Check the service with: granite deploy status'
      + (result.instance === DEFAULT_INSTANCE_NAME ? '' : ` ${result.instance}`));
  }
}

function formatInstanceLine(instance: InstanceStatus): string {
  const health = instance.healthy ? 'healthy' : 'unreachable';
  return `${instance.instance.padEnd(16)} granite-mem ${instance.granite_version ?? 'unknown'}  ${instance.status}/${health}  ${instance.mcp_url}`;
}

function requireSpritesToken(explicit?: string): string {
  const token = resolveSpritesToken(explicit);
  if (!token) {
    console.error('Missing Sprites token. Get one at https://sprites.dev, then run "granite deploy login --token <token>", set SPRITES_TOKEN, or pass --token.');
    process.exit(1);
  }
  return token;
}

function failWithDeployError(error: unknown): never {
  if (error instanceof DeployError) {
    console.error(error.message);
    if (error.output) {
      console.error('');
      console.error(error.output);
    }
  } else if (error instanceof SpritesApiError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}
