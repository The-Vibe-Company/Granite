import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeDefaultConfig } from '../../src/core/config.js';
import type { GraniteConfig } from '../../src/core/types.js';
import { createApp } from '../../src/web/server.js';
import type { CloudInstance } from '../../src/web/instances.js';

function cloudInstance(overrides: Partial<CloudInstance> = {}): CloudInstance {
  return {
    id: 'work',
    label: 'work',
    baseUrl: 'https://granite-work-abc.sprites.app',
    token: 'cloud-secret-token',
    version: '0.1.12',
    webApi: true,
    ...overrides,
  };
}

describe('instance gateway', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-gw-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);
    for (const typeConfig of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, typeConfig.folder), { recursive: true });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists instances without leaking tokens or sprite URLs', async () => {
    const app = createApp(tmpDir, config, { cloudInstances: [cloudInstance()] });

    const response = await app.request('/api/instances');
    expect(response.status).toBe(200);
    const raw = await response.text();
    const payload = JSON.parse(raw) as { instances: Array<{ id: string; kind: string }>; default: string };

    expect(payload.default).toBe('local');
    expect(payload.instances.map(i => i.id)).toEqual(['local', 'cloud:work']);
    expect(raw).not.toContain('cloud-secret-token');
    expect(raw).not.toContain('sprites.app');
  });

  it('serves local requests without touching the network', async () => {
    const fetchImpl = vi.fn();
    const app = createApp(tmpDir, config, { cloudInstances: [cloudInstance()], fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await app.request('/api/graph');
    expect(response.status).toBe(200);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('proxies header-selected cloud requests with the bearer token and forwards the query string', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ query: 'x', results: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const app = createApp(tmpDir, config, { cloudInstances: [cloudInstance()], fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await app.request('/api/search?q=hello%20world', {
      headers: { 'X-Granite-Instance': 'cloud:work' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const [target, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(target)).toBe('https://granite-work-abc.sprites.app/api/search?q=hello+world');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cloud-secret-token');
  });

  it('routes assets by ?instance= and strips the param from the forwarded URL', async () => {
    const fetchImpl = vi.fn(async () => new Response('img-bytes', {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' },
    }));
    const app = createApp(tmpDir, config, { cloudInstances: [cloudInstance()], fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await app.request('/assets/pic.png?instance=cloud%3Awork');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    const [target] = fetchImpl.mock.calls[0] as unknown as [URL];
    expect(String(target)).toBe('https://granite-work-abc.sprites.app/assets/pic.png');
  });

  it('refuses writes against cloud instances', async () => {
    const fetchImpl = vi.fn();
    const app = createApp(tmpDir, config, { cloudInstances: [cloudInstance()], fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await app.request('/api/notes', {
      method: 'POST',
      headers: { 'X-Granite-Instance': 'cloud:work', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'note', title: 'Nope' }),
    });

    expect(response.status).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects unknown instances', async () => {
    const app = createApp(tmpDir, config, { cloudInstances: [cloudInstance()] });

    const response = await app.request('/api/graph', {
      headers: { 'X-Granite-Instance': 'ghost' },
    });
    expect(response.status).toBe(404);
    const payload = await response.json() as { code: string };
    expect(payload.code).toBe('unknown-instance');
  });

  it('short-circuits outdated instances without a network round-trip', async () => {
    const fetchImpl = vi.fn();
    const app = createApp(tmpDir, config, {
      cloudInstances: [cloudInstance({ version: '0.1.11', webApi: false })],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const response = await app.request('/api/graph', { headers: { 'X-Granite-Instance': 'cloud:work' } });

    expect(response.status).toBe(502);
    const payload = await response.json() as { code: string; error: string };
    expect(payload.code).toBe('instance-outdated');
    expect(payload.error).toContain('granite deploy work');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps an upstream plain-text 404 on API paths to instance-outdated', async () => {
    const fetchImpl = vi.fn(async () => new Response('404 Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    }));
    const app = createApp(tmpDir, config, { cloudInstances: [cloudInstance()], fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await app.request('/api/graph', { headers: { 'X-Granite-Instance': 'cloud:work' } });

    expect(response.status).toBe(502);
    expect(((await response.json()) as { code: string }).code).toBe('instance-outdated');
  });

  it('passes through a real JSON 404 from the instance', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'Note not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }));
    const app = createApp(tmpDir, config, { cloudInstances: [cloudInstance()], fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await app.request('/api/notes/ghost', { headers: { 'X-Granite-Instance': 'cloud:work' } });
    expect(response.status).toBe(404);
  });

  it('maps upstream auth failures to instance-auth', async () => {
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    const app = createApp(tmpDir, config, { cloudInstances: [cloudInstance()], fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await app.request('/api/graph', { headers: { 'X-Granite-Instance': 'cloud:work' } });

    expect(response.status).toBe(502);
    expect(((await response.json()) as { code: string }).code).toBe('instance-auth');
  });

  it('maps timeouts and network errors to instance-unreachable', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('aborted'); });
    const app = createApp(tmpDir, config, { cloudInstances: [cloudInstance()], fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await app.request('/api/graph', { headers: { 'X-Granite-Instance': 'cloud:work' } });

    expect(response.status).toBe(504);
    expect(((await response.json()) as { code: string }).code).toBe('instance-unreachable');
  });

  it('runs cloud-only when no local vault exists', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ nodes: [], edges: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const app = createApp(null, null, { cloudInstances: [cloudInstance()], fetchImpl: fetchImpl as unknown as typeof fetch });

    const instances = await app.request('/api/instances');
    const payload = await instances.json() as { instances: Array<{ id: string }>; default: string };
    expect(payload.default).toBe('cloud:work');
    expect(payload.instances.map(i => i.id)).toEqual(['cloud:work']);

    // Default routing goes to the cloud instance without a header.
    const graph = await app.request('/api/graph');
    expect(graph.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalled();

    // Explicitly requesting local fails cleanly.
    const local = await app.request('/api/graph', { headers: { 'X-Granite-Instance': 'local' } });
    expect(local.status).toBe(404);
    expect(((await local.json()) as { code: string }).code).toBe('no-local-vault');
  });

  it('keeps a cloud instance named local distinct from the local vault selector', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ nodes: [], edges: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const app = createApp(tmpDir, config, {
      cloudInstances: [cloudInstance({ id: 'local', label: 'local' })],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const instances = await app.request('/api/instances');
    const payload = await instances.json() as { instances: Array<{ id: string; kind: string; name?: string }> };
    expect(payload.instances).toContainEqual({
      id: 'local',
      label: 'Local vault',
      kind: 'local',
      version: null,
      web_api: true,
    });
    expect(payload.instances).toContainEqual({
      id: 'cloud:local',
      label: 'local',
      kind: 'cloud',
      name: 'local',
      version: '0.1.12',
      web_api: true,
    });

    const local = await app.request('/api/graph', { headers: { 'X-Granite-Instance': 'local' } });
    expect(local.status).toBe(200);
    expect(fetchImpl).not.toHaveBeenCalled();

    const cloud = await app.request('/api/graph', { headers: { 'X-Granite-Instance': 'cloud:local' } });
    expect(cloud.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalled();
  });
});
