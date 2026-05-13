export class R2VaultStorage {
  constructor(
    private bucket: R2Bucket,
    private vaultId: string,
  ) {}

  async readText(path: string): Promise<string> {
    const obj = await this.bucket.get(this.key(path));
    if (!obj) throw new Error(`Object not found: ${path}`);
    return obj.text();
  }

  async writeText(path: string, content: string, contentType = 'text/plain'): Promise<void> {
    await this.bucket.put(this.key(path), content, {
      httpMetadata: { contentType },
    });
  }

  async writeBytes(path: string, bytes: ArrayBuffer | ReadableStream, contentType = 'application/octet-stream'): Promise<void> {
    await this.bucket.put(this.key(path), bytes, {
      httpMetadata: { contentType },
    });
  }

  async delete(path: string): Promise<void> {
    await this.bucket.delete(this.key(path));
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
}
