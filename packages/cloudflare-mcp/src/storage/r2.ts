export class R2VaultStorage {
  constructor(
    private bucket: R2Bucket,
    private vaultId: string,
    private quota?: { reserve(delta: number): Promise<void> },
  ) {}

  async readText(path: string): Promise<string> {
    const obj = await this.bucket.get(this.key(path));
    if (!obj) throw new Error(`Object not found: ${path}`);
    return obj.text();
  }

  async writeText(path: string, content: string, contentType = 'text/plain'): Promise<void> {
    const delta = await this.delta(path, new TextEncoder().encode(content).byteLength);
    await this.quota?.reserve(delta);
    try {
      await this.bucket.put(this.key(path), content, {
        httpMetadata: { contentType },
      });
    } catch (error) {
      await this.quota?.reserve(-delta);
      throw error;
    }
  }

  async writeBytes(path: string, bytes: ArrayBuffer | ReadableStream, contentType = 'application/octet-stream'): Promise<void> {
    if (bytes instanceof ReadableStream) throw new Error('Quota enforcement requires known byte length.');
    const delta = await this.delta(path, bytes.byteLength);
    await this.quota?.reserve(delta);
    try {
      await this.bucket.put(this.key(path), bytes, {
        httpMetadata: { contentType },
      });
    } catch (error) {
      await this.quota?.reserve(-delta);
      throw error;
    }
  }

  async delete(path: string): Promise<void> {
    const current = await this.size(path);
    await this.bucket.delete(this.key(path));
    if (current > 0) await this.quota?.reserve(-current);
  }

  async exists(path: string): Promise<boolean> {
    return await this.bucket.head(this.key(path)) !== null;
  }

  async list(prefix = ''): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.bucket.list({ prefix: this.key(prefix), cursor });
      for (const obj of result.objects) {
        keys.push(obj.key.slice(`${this.vaultId}/`.length));
      }
      cursor = result.truncated ? result.cursor : undefined;
    } while (cursor);
    return keys;
  }

  private key(path: string): string {
    return `${this.vaultId}/${path.replace(/^\/+/, '')}`;
  }

  private async delta(path: string, nextSize: number): Promise<number> {
    return nextSize - await this.size(path);
  }

  private async size(path: string): Promise<number> {
    const obj = await this.bucket.head(this.key(path));
    return typeof (obj as { size?: unknown } | null)?.size === 'number'
      ? (obj as { size: number }).size
      : 0;
  }
}
