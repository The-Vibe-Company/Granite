import type { SyncPushPayload, SyncPullResponse, SyncChange, SyncConfig } from '../types.js';

export class SyncClient {
  private baseUrl: string;
  private apiKey: string;
  private timeoutMs: number;

  constructor(config: SyncConfig, timeoutMs = 5000) {
    this.baseUrl = config.server.replace(/\/$/, '');
    this.apiKey = config.api_key;
    this.timeoutMs = timeoutMs;
  }

  private async request<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new SyncApiError(response.status, text || response.statusText);
      }

      return await response.json() as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async push(payload: SyncPushPayload): Promise<{ server_seq: number; accepted: number }> {
    return this.request('POST', '/v1/sync/push', payload);
  }

  async pull(sinceSeq: number, deviceId: string): Promise<SyncPullResponse> {
    return this.request('GET', `/v1/sync/pull?since_seq=${sinceSeq}&device_id=${deviceId}`);
  }

  async quickPull(sinceSeq: number, deviceId: string, timeoutMs = 200): Promise<SyncPullResponse | null> {
    const oldTimeout = this.timeoutMs;
    this.timeoutMs = timeoutMs;
    try {
      return await this.pull(sinceSeq, deviceId);
    } catch {
      return null;
    } finally {
      this.timeoutMs = oldTimeout;
    }
  }

  async listDevices(): Promise<Array<{ device_id: string; device_name: string; last_seen: string }>> {
    return this.request('GET', '/v1/sync/devices');
  }

  async ping(): Promise<boolean> {
    try {
      await this.request('GET', '/v1/sync/ping');
      return true;
    } catch {
      return false;
    }
  }
}

export class SyncApiError extends Error {
  constructor(
    public statusCode: number,
    public body: string,
  ) {
    super(`Sync API error ${statusCode}: ${body}`);
    this.name = 'SyncApiError';
  }
}
