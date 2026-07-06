import { describe, expect, it } from 'vitest';
import {
  DeployError,
  MARKER_PATH,
  MCP_PORT,
  SERVICE_NAME,
  VAULT_PATH,
  deployInstance,
  destroyInstance,
  getInstanceStatus,
  instanceNameFromSprite,
  listManagedInstances,
  resolveSpriteName,
} from '../../src/core/deploy/deploy.js';
import type { SpriteInfo, SpriteServiceDefinition, SpritesClient } from '../../src/core/deploy/sprites-client.js';

const OK = '__GRANITE_STEP_OK__';

interface FakeSpriteState {
  info: SpriteInfo;
  files: Map<string, string>;
  services: Map<string, SpriteServiceDefinition>;
}

class FakeSpritesClient implements SpritesClient {
  sprites = new Map<string, FakeSpriteState>();
  execLog: Array<{ sprite: string; script: string }> = [];
  healthyUrls = new Set<string>();
  nodeVersion = 'v22.1.0';
  failScriptsMatching: RegExp | null = null;

  addSprite(name: string, options: { managed?: boolean; version?: string; token?: string } = {}): FakeSpriteState {
    const state: FakeSpriteState = {
      info: { name, url: `https://${name}-abc.sprites.app`, status: 'cold', url_auth: 'sprite' },
      files: new Map(),
      services: new Map(),
    };
    if (options.managed) {
      state.files.set(MARKER_PATH, JSON.stringify({
        granite_version: options.version ?? '0.1.0',
        mcp_token: options.token ?? 'existing-token',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
      }));
      state.files.set(`${VAULT_PATH}/granite.yml`, 'note_types: {}\n');
    }
    this.sprites.set(name, state);
    this.healthyUrls.add(`${state.info.url}/health`);
    return state;
  }

  async getSprite(name: string): Promise<SpriteInfo | null> {
    return this.sprites.get(name)?.info ?? null;
  }

  async createSprite(name: string, auth: 'sprite' | 'public'): Promise<SpriteInfo> {
    const state = this.addSprite(name);
    state.files.clear();
    state.info.url_auth = auth;
    return state.info;
  }

  async deleteSprite(name: string): Promise<void> {
    if (!this.sprites.delete(name)) {
      throw new Error(`no sprite ${name}`);
    }
  }

  async listSpriteNames(prefix: string): Promise<string[]> {
    return [...this.sprites.keys()].filter(name => name.startsWith(prefix));
  }

  async exec(name: string, script: string): Promise<string> {
    this.execLog.push({ sprite: name, script });
    if (this.failScriptsMatching?.test(script)) {
      return 'boom: something failed';
    }
    if (script.includes('node -v')) {
      return this.nodeVersion === 'missing' ? 'missing' : this.nodeVersion;
    }
    if (script.includes('npm prefix -g')) {
      return `/usr/local/bin/node\n/usr/local/lib/node/bin/granite\n${OK}`;
    }
    return OK;
  }

  async readFile(name: string, filePath: string): Promise<string | null> {
    return this.sprites.get(name)?.files.get(filePath) ?? null;
  }

  async writeFile(name: string, filePath: string, contents: string): Promise<void> {
    this.sprites.get(name)!.files.set(filePath, contents);
  }

  serviceOps: string[] = [];

  async putService(name: string, serviceName: string, definition: SpriteServiceDefinition): Promise<void> {
    this.serviceOps.push(`put:${serviceName}`);
    this.sprites.get(name)!.services.set(serviceName, definition);
  }

  async deleteService(name: string, serviceName: string): Promise<void> {
    this.serviceOps.push(`delete:${serviceName}`);
    this.sprites.get(name)!.services.delete(serviceName);
  }

  async setUrlAuth(name: string, auth: 'sprite' | 'public'): Promise<void> {
    this.sprites.get(name)!.info.url_auth = auth;
  }

  async checkHealth(url: string): Promise<boolean> {
    return this.healthyUrls.has(url);
  }
}

const fastHealth = { healthTimeoutMs: 50, healthIntervalMs: 1 };

describe('sprite naming', () => {
  it('maps instance names to prefixed sprite names and back', () => {
    expect(resolveSpriteName('granite')).toBe('granite');
    expect(resolveSpriteName('work')).toBe('granite-work');
    expect(resolveSpriteName('granite-work')).toBe('granite-work');
    expect(instanceNameFromSprite('granite')).toBe('granite');
    expect(instanceNameFromSprite('granite-work')).toBe('work');
  });

  it('rejects invalid and reserved instance names', () => {
    expect(() => resolveSpriteName('Bad Name')).toThrow(DeployError);
    expect(() => resolveSpriteName('list')).toThrow(/reserved/);
    expect(() => resolveSpriteName('destroy')).toThrow(/reserved/);
  });
});

describe('deployInstance', () => {
  it('creates a sprite, installs granite, inits the vault, and registers the MCP service', async () => {
    const client = new FakeSpritesClient();

    const result = await deployInstance(client, { name: 'granite', graniteVersion: '0.2.0', ...fastHealth });

    expect(result.created).toBe(true);
    expect(result.mcp_url).toBe('https://granite-abc.sprites.app/mcp');
    expect(result.mcp_token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(result.healthy).toBe(true);

    const state = client.sprites.get('granite')!;
    const service = state.services.get(SERVICE_NAME)!;
    expect(service.cmd).toBe('/usr/local/bin/node');
    expect(service.args).toEqual(['/usr/local/lib/node/bin/granite', 'mcp', '--transport', 'http', '--host', '0.0.0.0', '--port', String(MCP_PORT)]);
    expect(service.env.GRANITE_VAULT).toBe(VAULT_PATH);
    expect(service.env.GRANITE_MCP_TOKEN).toBe(result.mcp_token);
    expect(service.env.GRANITE_DISABLE_DOCUMENT_PARSING).toBe('1');
    expect(service.http_port).toBe(MCP_PORT);
    expect(state.info.url_auth).toBe('public');

    const marker = JSON.parse(state.files.get(MARKER_PATH)!) as { mcp_token: string; granite_version: string };
    expect(marker.mcp_token).toBe(result.mcp_token);
    expect(marker.granite_version).toBe('0.2.0');

    expect(client.execLog.some(entry => entry.script.includes('npm install -g granite-mem@0.2.0'))).toBe(true);
    expect(client.execLog.some(entry => entry.script.includes('granite') && entry.script.includes('init'))).toBe(true);
    // PUT alone never updates an existing service — the deploy must delete first.
    expect(client.serviceOps).toEqual([`delete:${SERVICE_NAME}`, `put:${SERVICE_NAME}`]);
  });

  it('updates an existing managed instance while preserving the token and skipping init', async () => {
    const client = new FakeSpritesClient();
    client.addSprite('granite-work', { managed: true, version: '0.1.0', token: 'keep-me' });

    const result = await deployInstance(client, { name: 'work', graniteVersion: '0.2.0', ...fastHealth });

    expect(result.created).toBe(false);
    expect(result.previous_version).toBe('0.1.0');
    expect(result.mcp_token).toBe('keep-me');
    expect(client.execLog.some(entry => entry.script.includes('init'))).toBe(false);
    expect(client.execLog.some(entry => entry.script.includes('npm install -g granite-mem@0.2.0'))).toBe(true);
  });

  it('rotates the token only when asked', async () => {
    const client = new FakeSpritesClient();
    client.addSprite('granite', { managed: true, token: 'old-token' });

    const rotated = await deployInstance(client, { name: 'granite', graniteVersion: '0.2.0', rotateToken: true, ...fastHealth });

    expect(rotated.mcp_token).not.toBe('old-token');
    const service = client.sprites.get('granite')!.services.get(SERVICE_NAME)!;
    expect(service.env.GRANITE_MCP_TOKEN).toBe(rotated.mcp_token);
  });

  it('refuses to touch a foreign sprite without --force', async () => {
    const client = new FakeSpritesClient();
    client.addSprite('granite'); // exists, no marker

    await expect(deployInstance(client, { name: 'granite', graniteVersion: '0.2.0', ...fastHealth }))
      .rejects.toThrow(/not created by granite deploy/);

    const adopted = await deployInstance(client, { name: 'granite', graniteVersion: '0.2.0', force: true, ...fastHealth });
    expect(adopted.created).toBe(false);
  });

  it('installs Node.js when the probe fails', async () => {
    const client = new FakeSpritesClient();
    client.addSprite('granite', { managed: true });
    client.nodeVersion = 'missing';

    await deployInstance(client, { name: 'granite', graniteVersion: '0.2.0', ...fastHealth });

    expect(client.execLog.some(entry => entry.script.includes('nodesource'))).toBe(true);
  });

  it('writes the marker before setup steps so a failed create can be resumed without --force', async () => {
    const client = new FakeSpritesClient();
    client.failScriptsMatching = /npm install/;

    await expect(deployInstance(client, { name: 'granite', graniteVersion: '0.2.0', ...fastHealth }))
      .rejects.toThrow(/install granite-mem/);

    // Sprite was created and the marker exists despite the failure…
    const marker = JSON.parse(client.sprites.get('granite')!.files.get(MARKER_PATH)!) as { granite_version: string; mcp_token: string };
    expect(marker.granite_version).toBe('pending'); // install never completed
    expect(marker.mcp_token).toBeTruthy();

    // …so a plain re-run (no --force) resumes and converges.
    client.failScriptsMatching = null;
    const result = await deployInstance(client, { name: 'granite', graniteVersion: '0.2.0', ...fastHealth });
    expect(result.mcp_token).toBe(marker.mcp_token);
    expect(result.granite_version).toBe('0.2.0');
  });

  it('fails with the step output when a remote step fails', async () => {
    const client = new FakeSpritesClient();
    client.addSprite('granite', { managed: true });
    client.failScriptsMatching = /npm install/;

    const error = await deployInstance(client, { name: 'granite', graniteVersion: '0.2.0', ...fastHealth })
      .catch(e => e);

    expect(error).toBeInstanceOf(DeployError);
    expect(error.message).toContain('install granite-mem');
    expect(error.output).toContain('boom');
  });

  it('reports unhealthy when the MCP health check never passes', async () => {
    const client = new FakeSpritesClient();
    client.addSprite('granite', { managed: true });
    client.healthyUrls.clear();

    const result = await deployInstance(client, { name: 'granite', graniteVersion: '0.2.0', ...fastHealth });
    expect(result.healthy).toBe(false);
  });
});

describe('listManagedInstances', () => {
  it('lists only sprites carrying the deploy marker', async () => {
    const client = new FakeSpritesClient();
    client.addSprite('granite', { managed: true, version: '0.1.5' });
    client.addSprite('granite-work', { managed: true, version: '0.1.9' });
    client.addSprite('granite-random-project'); // not managed by granite deploy

    const instances = await listManagedInstances(client);

    expect(instances.map(i => i.instance).sort()).toEqual(['granite', 'work']);
    const work = instances.find(i => i.instance === 'work')!;
    expect(work.granite_version).toBe('0.1.9');
    expect(work.mcp_url).toContain('/mcp');
    expect(work.healthy).toBe(true);
  });
});

describe('getInstanceStatus / destroyInstance', () => {
  it('returns status and optionally the token', async () => {
    const client = new FakeSpritesClient();
    client.addSprite('granite', { managed: true, token: 'secret' });

    const withoutToken = await getInstanceStatus(client, 'granite');
    expect(withoutToken.mcp_token).toBeUndefined();

    const withToken = await getInstanceStatus(client, 'granite', { includeToken: true });
    expect(withToken.mcp_token).toBe('secret');
  });

  it('throws a clear error for unknown or unmanaged instances', async () => {
    const client = new FakeSpritesClient();
    await expect(getInstanceStatus(client, 'ghost')).rejects.toThrow(/No sprite named/);

    client.addSprite('granite-foreign');
    await expect(getInstanceStatus(client, 'foreign')).rejects.toThrow(/not managed by granite deploy/);
  });

  it('destroys an instance by name', async () => {
    const client = new FakeSpritesClient();
    client.addSprite('granite-work', { managed: true });

    expect(await destroyInstance(client, 'work')).toBe('granite-work');
    expect(client.sprites.has('granite-work')).toBe(false);

    await expect(destroyInstance(client, 'work')).rejects.toThrow(/No sprite named/);
  });

  it('refuses to destroy a sprite not managed by granite deploy', async () => {
    const client = new FakeSpritesClient();
    client.addSprite('granite-foreign'); // exists, no deploy marker

    await expect(destroyInstance(client, 'foreign')).rejects.toThrow(/not managed by granite deploy/);
    expect(client.sprites.has('granite-foreign')).toBe(true);
  });
});
