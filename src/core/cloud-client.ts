import { requireCloudConfig, type ResolvedGraniteCloudConfig } from './cloud-config.js';

export interface CloudVault {
  vault_id: string;
  vault_name: string;
  created_at?: string;
  updated_at?: string;
}

export interface CloudNoteSummary {
  slug: string;
  title: string;
  type: string;
  created: string;
  modified: string;
  tags?: string[];
  aliases?: string[];
  status?: string;
  source?: string;
  review_state?: string;
  durability?: string;
  derived_from?: string[];
  filepath?: string;
}

export interface CloudNoteDetails extends CloudNoteSummary {
  body: string;
  frontmatter?: Record<string, unknown>;
}

export interface CloudSearchResult {
  slug: string;
  title: string;
  snippet: string;
  score: number;
}

export interface CloudImportPayload {
  config: string;
  notes: Array<{ path: string; content: string }>;
  assets?: Array<{ path: string; content_base64: string; content_type?: string }>;
}

export interface CloudHealth {
  status: string;
  service?: string;
  bindings?: Record<string, boolean>;
}

export interface CloudKeySummary {
  key_prefix: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface CloudCreateNoteInput {
  title?: string;
  type?: string;
  body?: string;
  tags?: string[];
  aliases?: string[];
  status?: string;
  source?: string;
  review_state?: string;
  durability?: string;
  derived_from?: string[];
  fields?: Record<string, unknown>;
}

export interface CloudUpdateNoteInput extends Partial<Omit<CloudCreateNoteInput, 'title'>> {
  title?: string;
  append?: string;
}

export class CloudClient {
  constructor(private config: ResolvedGraniteCloudConfig = requireCloudConfig()) {}

  get baseUrl(): string {
    return this.config.base_url.replace(/\/+$/, '');
  }

  get defaultVaultId(): string | undefined {
    return this.config.default_vault_id;
  }

  async health(): Promise<CloudHealth> {
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json() as Promise<CloudHealth>;
  }

  async listKeys(): Promise<CloudKeySummary[]> {
    const data = await this.request<{ keys: CloudKeySummary[] }>('/keys');
    return data.keys;
  }

  async createKey(name: string): Promise<{ api_key: string; key_prefix: string; name: string }> {
    return this.request('/keys', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  async revokeKey(prefix: string): Promise<{ revoked: boolean; prefix: string }> {
    return this.request(`/keys/${encodeURIComponent(prefix)}`, { method: 'DELETE' });
  }

  async listVaults(): Promise<CloudVault[]> {
    const data = await this.request<{ vaults: CloudVault[] }>('/vaults');
    return data.vaults;
  }

  async createVault(name: string): Promise<CloudVault> {
    const data = await this.request<{ vault_id: string; vault_name: string }>('/vaults', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    return data;
  }

  async importVault(vaultId: string, payload: CloudImportPayload): Promise<{ note_count: number; asset_count: number }> {
    return this.request(`/vaults/${encodeURIComponent(vaultId)}/import`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async listNotes(input: { vaultId?: string; type?: string; status?: string; source?: string; since?: string } = {}): Promise<CloudNoteSummary[]> {
    const params = this.vaultParams(input.vaultId);
    if (input.type) params.set('type', input.type);
    if (input.status) params.set('status', input.status);
    if (input.source) params.set('source', input.source);
    if (input.since) params.set('since', input.since);
    const data = await this.request<{ notes: CloudNoteSummary[] }>(`/api/notes?${params}`);
    return data.notes;
  }

  async getNote(slug: string, vaultId?: string): Promise<CloudNoteDetails> {
    return this.request(`/api/notes/${encodeURIComponent(slug)}?${this.vaultParams(vaultId)}`);
  }

  async search(query: string, vaultId?: string): Promise<CloudSearchResult[]> {
    const params = this.vaultParams(vaultId);
    params.set('q', query);
    const data = await this.request<{ results: CloudSearchResult[] }>(`/api/search?${params}`);
    return data.results;
  }

  async createNote(input: CloudCreateNoteInput, vaultId?: string): Promise<{ note: CloudNoteDetails; recommendations?: unknown }> {
    return this.request(`/api/notes?${this.vaultParams(vaultId)}`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async updateNote(slug: string, input: CloudUpdateNoteInput, vaultId?: string): Promise<{ note: CloudNoteDetails; recommendations?: unknown }> {
    return this.request(`/api/notes/${encodeURIComponent(slug)}?${this.vaultParams(vaultId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  mcpUrl(vaultId?: string): string {
    const params = this.vaultParams(vaultId);
    const query = params.toString();
    return `${this.baseUrl}/mcp${query ? `?${query}` : ''}`;
  }

  private vaultParams(vaultId?: string): URLSearchParams {
    const params = new URLSearchParams();
    const resolved = vaultId ?? this.defaultVaultId;
    if (!resolved) {
      throw new Error('Cloud vault is not selected. Pass --vault <id> or set a default with granite cloud create/import.');
    }
    if (resolved) params.set('vault_id', resolved);
    return params;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.config.api_key}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const body = await response.json() as { error?: string };
        if (body.error) message = body.error;
      } catch {}
      throw new Error(message);
    }
    return response.json() as Promise<T>;
  }
}
