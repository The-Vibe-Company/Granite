// Minimal typed client for the Fly.io Sprites REST API (https://sprites.dev/api/sprites).
// This is the only file that knows Sprites API shapes; everything else goes
// through the SpritesClient interface so orchestration stays unit-testable.

export interface SpriteInfo {
  name: string;
  url: string;
  status: 'cold' | 'warm' | 'running' | string;
  url_auth: 'sprite' | 'public' | string;
}

export interface SpriteServiceDefinition {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  http_port?: number;
}

export interface SpritesClient {
  getSprite(name: string): Promise<SpriteInfo | null>;
  createSprite(name: string, auth: 'sprite' | 'public'): Promise<SpriteInfo>;
  deleteSprite(name: string): Promise<void>;
  listSpriteNames(prefix: string): Promise<string[]>;
  /** Run `bash -lc <script>` in the sprite and return the combined output. */
  exec(name: string, script: string): Promise<string>;
  /** Returns null when the file does not exist. */
  readFile(name: string, filePath: string): Promise<string | null>;
  writeFile(name: string, filePath: string, contents: string, options?: { mode?: string }): Promise<void>;
  putService(name: string, serviceName: string, definition: SpriteServiceDefinition): Promise<void>;
  /** No-op when the service does not exist. */
  deleteService(name: string, serviceName: string): Promise<void>;
  setUrlAuth(name: string, auth: 'sprite' | 'public'): Promise<void>;
  /** Probe a URL on the sprite itself (not the API), e.g. the MCP /health endpoint. */
  checkHealth(url: string): Promise<boolean>;
}

export class SpritesApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
    this.name = 'SpritesApiError';
  }
}

export interface HttpSpritesClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.sprites.dev/v1';

export class HttpSpritesClient implements SpritesClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpSpritesClientOptions) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getSprite(name: string): Promise<SpriteInfo | null> {
    const response = await this.request('GET', `/sprites/${encodeURIComponent(name)}`);
    if (response.status === 404) return null;
    await this.assertOk(response, `get sprite "${name}"`);
    return toSpriteInfo(await response.json());
  }

  async createSprite(name: string, auth: 'sprite' | 'public'): Promise<SpriteInfo> {
    const response = await this.request('POST', '/sprites', {
      json: { name, url_settings: { auth } },
    });
    await this.assertOk(response, `create sprite "${name}"`);
    return toSpriteInfo(await response.json());
  }

  async deleteSprite(name: string): Promise<void> {
    const response = await this.request('DELETE', `/sprites/${encodeURIComponent(name)}`);
    await this.assertOk(response, `delete sprite "${name}"`);
  }

  async listSpriteNames(prefix: string): Promise<string[]> {
    const names: string[] = [];
    let continuationToken: string | undefined;

    do {
      const query = new URLSearchParams({ prefix, max_results: '50' });
      if (continuationToken) query.set('continuation_token', continuationToken);
      const response = await this.request('GET', `/sprites?${query}`);
      await this.assertOk(response, 'list sprites');
      const payload = await response.json() as {
        sprites?: Array<{ name?: string }>;
        has_more?: boolean;
        next_continuation_token?: string;
      };
      for (const entry of payload.sprites ?? []) {
        if (typeof entry.name === 'string') names.push(entry.name);
      }
      continuationToken = payload.has_more ? payload.next_continuation_token : undefined;
    } while (continuationToken);

    return names;
  }

  async exec(name: string, script: string): Promise<string> {
    const query = new URLSearchParams();
    query.append('cmd', 'bash');
    query.append('cmd', '-lc');
    query.append('cmd', script);
    const response = await this.request('POST', `/sprites/${encodeURIComponent(name)}/exec?${query}`);
    const body = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) {
      throw new SpritesApiError(
        `Sprites API error while executing a command in "${name}" (HTTP ${response.status}).`,
        response.status,
        new TextDecoder().decode(body),
      );
    }
    return decodeExecOutput(body);
  }

  async readFile(name: string, filePath: string): Promise<string | null> {
    const query = new URLSearchParams({ path: filePath });
    const response = await this.request('GET', `/sprites/${encodeURIComponent(name)}/fs/read?${query}`);
    if (response.status === 404) return null;
    await this.assertOk(response, `read ${filePath} from sprite "${name}"`);
    return response.text();
  }

  async writeFile(name: string, filePath: string, contents: string, options: { mode?: string } = {}): Promise<void> {
    const query = new URLSearchParams({ path: filePath, mkdir: 'true' });
    if (options.mode) query.set('mode', options.mode);
    const response = await this.request('PUT', `/sprites/${encodeURIComponent(name)}/fs/write?${query}`, {
      body: contents,
      contentType: 'application/octet-stream',
    });
    await this.assertOk(response, `write ${filePath} to sprite "${name}"`);
  }

  async putService(name: string, serviceName: string, definition: SpriteServiceDefinition): Promise<void> {
    const response = await this.request(
      'PUT',
      `/sprites/${encodeURIComponent(name)}/services/${encodeURIComponent(serviceName)}`,
      {
        json: {
          cmd: definition.cmd,
          args: definition.args,
          env: definition.env,
          needs: [],
          ...(definition.http_port !== undefined ? { http_port: definition.http_port } : {}),
        },
      },
    );
    await this.assertOk(response, `register service "${serviceName}" on sprite "${name}"`);
  }

  async deleteService(name: string, serviceName: string): Promise<void> {
    const response = await this.request(
      'DELETE',
      `/sprites/${encodeURIComponent(name)}/services/${encodeURIComponent(serviceName)}`,
    );
    if (response.status === 404) return;
    await this.assertOk(response, `delete service "${serviceName}" on sprite "${name}"`);
  }

  async setUrlAuth(name: string, auth: 'sprite' | 'public'): Promise<void> {
    const response = await this.request('PUT', `/sprites/${encodeURIComponent(name)}`, {
      json: { url_settings: { auth } },
    });
    await this.assertOk(response, `update URL settings for sprite "${name}"`);
  }

  async checkHealth(url: string): Promise<boolean> {
    try {
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async request(
    method: string,
    path: string,
    options: { json?: unknown; body?: string; contentType?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    let body: string | undefined = options.body;
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.contentType) {
      headers['Content-Type'] = options.contentType;
    }
    return this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body });
  }

  private async assertOk(response: Response, action: string): Promise<void> {
    if (response.ok) return;
    const body = await response.text().catch(() => '');
    if (response.status === 401) {
      throw new SpritesApiError(
        'Sprites API rejected the token (HTTP 401). Check SPRITES_TOKEN — get one at https://sprites.dev.',
        response.status,
        body,
      );
    }
    throw new SpritesApiError(
      `Sprites API error: failed to ${action} (HTTP ${response.status})${body ? `: ${truncate(body)}` : '.'}`,
      response.status,
      body,
    );
  }
}

function toSpriteInfo(payload: unknown): SpriteInfo {
  const record = (payload ?? {}) as Record<string, unknown>;
  const urlSettings = (record.url_settings ?? {}) as Record<string, unknown>;
  return {
    name: String(record.name ?? ''),
    url: String(record.url ?? ''),
    status: String(record.status ?? 'unknown'),
    url_auth: String(urlSettings.auth ?? 'sprite'),
  };
}

// The exec POST endpoint streams 1-byte stream-ID frames (0=stdin, 1=stdout,
// 2=stderr, 3=exit code) concatenated into the HTTP body. Frame boundaries are
// lost once concatenated, so drop the trailing exit frame and strip the ID
// bytes — they can never occur in text output. Falls back to JSON-wrapped
// output if the API ever switches encodings.
function decodeExecOutput(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes);
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      const parts = [parsed.stdout, parsed.stderr, parsed.output]
        .filter((part): part is string => typeof part === 'string');
      if (parts.length > 0) return parts.join('\n');
    }
  } catch {
    // Framed or raw text output.
  }

  let end = bytes.length;
  if (end >= 2 && bytes[end - 2] === 0x03) {
    end -= 2; // exit frame: 0x03 + exit-code byte
  }
  const kept: number[] = [];
  for (let i = 0; i < end; i++) {
    if (bytes[i] > 0x04) kept.push(bytes[i]);
  }
  return new TextDecoder().decode(new Uint8Array(kept));
}

function truncate(text: string, max = 300): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
