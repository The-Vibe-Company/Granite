import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployCommand, deployDestroyCommand, deployListCommand } from '../../src/commands/deploy.js';
import { MARKER_PATH, VAULT_PATH } from '../../src/core/deploy/deploy.js';
import type { SpriteInfo, SpriteServiceDefinition, SpritesClient } from '../../src/core/deploy/sprites-client.js';

const OK = '__GRANITE_STEP_OK__';

class FakeSpritesClient implements SpritesClient {
  sprites = new Map<string, { info: SpriteInfo; files: Map<string, string>; services: Map<string, SpriteServiceDefinition> }>();
  failInstallFor = new Set<string>();

  addManaged(name: string, version = '0.1.0'): void {
    this.sprites.set(name, {
      info: { name, url: `https://${name}-abc.sprites.app`, status: 'warm', url_auth: 'public' },
      files: new Map([
        [MARKER_PATH, JSON.stringify({ granite_version: version, mcp_token: 'tok', created: 'x', updated: 'x' })],
        [`${VAULT_PATH}/granite.yml`, 'note_types: {}\n'],
      ]),
      services: new Map(),
    });
  }

  async getSprite(name: string): Promise<SpriteInfo | null> {
    return this.sprites.get(name)?.info ?? null;
  }

  async createSprite(name: string): Promise<SpriteInfo> {
    const info: SpriteInfo = { name, url: `https://${name}-abc.sprites.app`, status: 'cold', url_auth: 'public' };
    this.sprites.set(name, { info, files: new Map(), services: new Map() });
    return info;
  }

  async deleteSprite(name: string): Promise<void> {
    this.sprites.delete(name);
  }

  async listSpriteNames(prefix: string): Promise<string[]> {
    return [...this.sprites.keys()].filter(name => name.startsWith(prefix));
  }

  async exec(name: string, script: string): Promise<string> {
    if (script.includes('node -v')) return 'v22.0.0';
    if (script.includes('npm prefix -g')) return `/usr/local/bin/node\n/usr/local/lib/node/bin/granite\n${OK}`;
    if (script.includes('npm install') && this.failInstallFor.has(name)) return 'npm ERR! boom';
    return OK;
  }

  async readFile(name: string, filePath: string): Promise<string | null> {
    return this.sprites.get(name)?.files.get(filePath) ?? null;
  }

  async writeFile(name: string, filePath: string, contents: string): Promise<void> {
    this.sprites.get(name)!.files.set(filePath, contents);
  }

  async putService(name: string, serviceName: string, definition: SpriteServiceDefinition): Promise<void> {
    this.sprites.get(name)!.services.set(serviceName, definition);
  }

  async deleteService(name: string, serviceName: string): Promise<void> {
    this.sprites.get(name)!.services.delete(serviceName);
  }

  async setUrlAuth(name: string, auth: 'sprite' | 'public'): Promise<void> {
    this.sprites.get(name)!.info.url_auth = auth;
  }

  healthy = true;

  async checkHealth(): Promise<boolean> {
    return this.healthy;
  }
}

describe('deploy commands', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('SPRITES_TOKEN', '');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function loggedText(): string {
    return [...logSpy.mock.calls, ...errorSpy.mock.calls].map(call => call.join(' ')).join('\n');
  }

  it('exits before any API call when SPRITES_TOKEN is missing', async () => {
    const factory = vi.fn();

    await expect(deployCommand(undefined, {}, factory)).rejects.toThrow('process.exit(1)');

    expect(factory).not.toHaveBeenCalled();
    expect(loggedText()).toContain('SPRITES_TOKEN');
    expect(loggedText()).toContain('sprites.dev');
  });

  it('deploys the default instance and prints connection info', async () => {
    const client = new FakeSpritesClient();

    await deployCommand(undefined, { token: 'tok', json: true }, () => client);

    const jsonLine = logSpy.mock.calls.map(call => String(call[0])).find(line => line.startsWith('{'));
    const payload = JSON.parse(String(jsonLine)) as { success: boolean; data: { mcp_url: string; mcp_token: string; created: boolean } };
    expect(payload.success).toBe(true);
    expect(payload.data.created).toBe(true);
    expect(payload.data.mcp_url).toBe('https://granite-abc.sprites.app/mcp');
    expect(payload.data.mcp_token.length).toBeGreaterThan(20);
  });

  it('rejects passing both a name and --all', async () => {
    const client = new FakeSpritesClient();

    await expect(deployCommand('work', { token: 'tok', all: true }, () => client))
      .rejects.toThrow('process.exit(1)');
  });

  it('rejects single-instance flags with --all', async () => {
    const client = new FakeSpritesClient();

    await expect(deployCommand(undefined, { token: 'tok', all: true, rotateToken: true }, () => client))
      .rejects.toThrow('process.exit(1)');
    expect(loggedText()).toContain('--rotate-token');
  });

  it('exits non-zero on --json deploys that fail the health check', async () => {
    const client = new FakeSpritesClient();
    client.healthy = false;

    await expect(deployCommand(undefined, { token: 'tok', json: true }, () => client, { healthTimeoutMs: 20, healthIntervalMs: 1 }))
      .rejects.toThrow('process.exit(1)');

    const jsonLine = logSpy.mock.calls.map(call => String(call[0])).find(line => line.startsWith('{'));
    const payload = JSON.parse(String(jsonLine)) as { data: { healthy: boolean } };
    expect(payload.data.healthy).toBe(false); // JSON still emitted, exit code signals failure
  });

  it('reconciles every managed instance with --all and keeps going on failure', async () => {
    const client = new FakeSpritesClient();
    client.addManaged('granite', '0.1.0');
    client.addManaged('granite-work', '0.1.0');
    client.failInstallFor.add('granite');

    await expect(deployCommand(undefined, { token: 'tok', all: true }, () => client))
      .rejects.toThrow('process.exit(1)'); // one instance failed → non-zero exit

    const output = loggedText();
    expect(output).toContain('✗ granite');
    expect(output).toContain('✓ work');
  });

  it('emits a stable JSON shape for --all', async () => {
    const client = new FakeSpritesClient();
    client.addManaged('granite', '0.1.0');
    client.addManaged('granite-work', '0.1.0');

    await deployCommand(undefined, { token: 'tok', all: true, json: true }, () => client);

    const jsonLine = logSpy.mock.calls.map(call => String(call[0])).find(line => line.startsWith('{'));
    const payload = JSON.parse(String(jsonLine)) as {
      success: boolean;
      data: { updated: Array<{ instance: string; ok: boolean; detail: string; mcp_url?: string }> };
    };

    expect(payload.success).toBe(true);
    expect(payload.data.updated.map(entry => entry.instance).sort()).toEqual(['granite', 'work']);
    expect(payload.data.updated.every(entry => entry.ok)).toBe(true);
    expect(payload.data.updated.every(entry => entry.mcp_url?.endsWith('/mcp'))).toBe(true);
    // Bulk output must never leak bearer tokens into CI logs.
    expect(String(jsonLine)).not.toContain('mcp_token');
  });

  it('lists only managed instances', async () => {
    const client = new FakeSpritesClient();
    client.addManaged('granite-work', '0.1.9');
    await client.createSprite('granite-unmanaged'); // no marker file

    await deployListCommand({ token: 'tok' }, () => client);

    const output = loggedText();
    expect(output).toContain('work');
    expect(output).toContain('0.1.9');
    expect(output).not.toContain('unmanaged');
  });

  it('refuses to destroy without --force when not interactive', async () => {
    const client = new FakeSpritesClient();
    client.addManaged('granite-work');
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    try {
      await expect(deployDestroyCommand('work', { token: 'tok' }, () => client))
        .rejects.toThrow('process.exit(1)');
      expect(client.sprites.has('granite-work')).toBe(true);

      await deployDestroyCommand('work', { token: 'tok', force: true }, () => client);
      expect(client.sprites.has('granite-work')).toBe(false);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });
});
