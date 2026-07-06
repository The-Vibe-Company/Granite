import { describe, expect, it, vi } from 'vitest';
import { HttpSpritesClient, SpritesApiError, SpritesExecError } from '../../src/core/deploy/sprites-client.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createClient(fetchImpl: typeof fetch): HttpSpritesClient {
  return new HttpSpritesClient({ token: 'test-token', fetchImpl });
}

describe('HttpSpritesClient', () => {
  it('sends the bearer token on every request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ name: 'granite', url: 'https://x.sprites.app', status: 'cold' }));
    const client = createClient(fetchMock as unknown as typeof fetch);

    await client.getSprite('granite');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.sprites.dev/v1/sprites/granite');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });

  it('returns null when a sprite does not exist', async () => {
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    const client = createClient(fetchMock as unknown as typeof fetch);

    expect(await client.getSprite('missing')).toBeNull();
    expect(await client.readFile('missing', '/tmp/x')).toBeNull();
  });

  it('raises an actionable error on 401', async () => {
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    const client = createClient(fetchMock as unknown as typeof fetch);

    await expect(client.createSprite('granite', 'public')).rejects.toThrow(/SPRITES_TOKEN/);
  });

  it('surfaces the response body on other API errors', async () => {
    const fetchMock = vi.fn(async () => new Response('name already taken', { status: 400 }));
    const client = createClient(fetchMock as unknown as typeof fetch);

    const error = await client.createSprite('granite', 'public').catch(e => e);
    expect(error).toBeInstanceOf(SpritesApiError);
    expect(error.status).toBe(400);
    expect(error.message).toContain('name already taken');
  });

  it('creates sprites with URL settings', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      name: 'granite',
      url: 'https://granite-abc.sprites.app',
      status: 'cold',
      url_settings: { auth: 'public' },
    }, 201));
    const client = createClient(fetchMock as unknown as typeof fetch);

    const sprite = await client.createSprite('granite', 'public');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ name: 'granite', url_settings: { auth: 'public' } });
    expect(sprite.url).toBe('https://granite-abc.sprites.app');
    expect(sprite.url_auth).toBe('public');
  });

  it('paginates sprite listings with the name prefix', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        sprites: [{ name: 'granite' }, { name: 'granite-work' }],
        has_more: true,
        next_continuation_token: 'next',
      }))
      .mockResolvedValueOnce(jsonResponse({
        sprites: [{ name: 'granite-perso' }],
        has_more: false,
      }));
    const client = createClient(fetchMock as unknown as typeof fetch);

    const names = await client.listSpriteNames('granite');

    expect(names).toEqual(['granite', 'granite-work', 'granite-perso']);
    const firstUrl = String(fetchMock.mock.calls[0][0]);
    const secondUrl = String(fetchMock.mock.calls[1][0]);
    expect(firstUrl).toContain('prefix=granite');
    expect(secondUrl).toContain('continuation_token=next');
  });

  it('executes commands via repeated cmd query params and returns raw output', async () => {
    const fetchMock = vi.fn(async () => new Response('v22.1.0\n', { status: 200 }));
    const client = createClient(fetchMock as unknown as typeof fetch);

    const output = await client.exec('granite', 'node -v');

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe('/v1/sprites/granite/exec');
    expect(url.searchParams.getAll('cmd')).toEqual(['bash', '-lc', 'node -v']);
    expect(output).toBe('v22.1.0\n');
  });

  it('decodes framed binary exec output (stream IDs + exit frame)', async () => {
    // 0x01 = stdout frame ID, trailing 0x03 0x00 = exit frame with code 0
    const framed = new Uint8Array([
      0x01, ...new TextEncoder().encode('/usr/bin/node\n'),
      0x01, ...new TextEncoder().encode('/usr/lib/bin/granite\n'),
      0x03, 0x00,
    ]);
    const fetchMock = vi.fn(async () => new Response(framed, { status: 200 }));
    const client = createClient(fetchMock as unknown as typeof fetch);

    expect(await client.exec('granite', 'locate')).toBe('/usr/bin/node\n/usr/lib/bin/granite\n');
  });

  it('throws with captured output when framed exec output reports a non-zero exit code', async () => {
    const framed = new Uint8Array([
      0x01, ...new TextEncoder().encode('stdout before failure\n'),
      0x02, ...new TextEncoder().encode('stderr detail\n'),
      0x03, 0x7f,
    ]);
    const fetchMock = vi.fn(async () => new Response(framed, { status: 200 }));
    const client = createClient(fetchMock as unknown as typeof fetch);

    const error = await client.exec('granite', 'false').catch(e => e);

    expect(error).toBeInstanceOf(SpritesExecError);
    expect(error.exitCode).toBe(127);
    expect(error.output).toContain('stdout before failure');
    expect(error.output).toContain('stderr detail');
  });

  it('unwraps JSON-encoded exec output when present', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ stdout: 'ok', stderr: '' }));
    const client = createClient(fetchMock as unknown as typeof fetch);

    expect(await client.exec('granite', 'true')).toBe('ok\n');
  });

  it('throws when JSON-encoded exec output reports a non-zero exit code', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ stdout: 'nope', exit_code: 2 }));
    const client = createClient(fetchMock as unknown as typeof fetch);

    const error = await client.exec('granite', 'false').catch(e => e);

    expect(error).toBeInstanceOf(SpritesExecError);
    expect(error.exitCode).toBe(2);
    expect(error.output).toBe('nope');
  });

  it('writes files with mode and mkdir', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ path: '/home/sprite/.granite/deploy.json', size: 2, mode: '0600' }));
    const client = createClient(fetchMock as unknown as typeof fetch);

    await client.writeFile('granite', '/home/sprite/.granite/deploy.json', '{}', { mode: '0600' });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe('/v1/sprites/granite/fs/write');
    expect(url.searchParams.get('path')).toBe('/home/sprite/.granite/deploy.json');
    expect(url.searchParams.get('mode')).toBe('0600');
    expect(url.searchParams.get('mkdir')).toBe('true');
  });

  it('treats deleting a missing service as a no-op', async () => {
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    const client = createClient(fetchMock as unknown as typeof fetch);

    await expect(client.deleteService('granite', 'granite-mcp')).resolves.toBeUndefined();
  });

  it('registers services with cmd, args, env, and http_port', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ name: 'granite-mcp' }));
    const client = createClient(fetchMock as unknown as typeof fetch);

    await client.putService('granite', 'granite-mcp', {
      cmd: '/usr/local/bin/granite',
      args: ['mcp', '--transport', 'http'],
      env: { GRANITE_VAULT: '/home/sprite/.granite' },
      http_port: 8080,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/v1/sprites/granite/services/granite-mcp');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      cmd: '/usr/local/bin/granite',
      args: ['mcp', '--transport', 'http'],
      env: { GRANITE_VAULT: '/home/sprite/.granite' },
      needs: [],
      http_port: 8080,
    });
  });
});
