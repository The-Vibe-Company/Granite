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

  async readBytes(path: string): Promise<ArrayBuffer> {
    const obj = await this.bucket.get(this.key(path));
    if (!obj) throw new Error(`Object not found: ${path}`);
    return obj.arrayBuffer();
  }

  async readFile(path: string): Promise<{ bytes: ArrayBuffer; contentType?: string }> {
    const obj = await this.bucket.get(this.key(path));
    if (!obj) throw new Error(`Object not found: ${path}`);
    return {
      bytes: await obj.arrayBuffer(),
      contentType: obj.httpMetadata?.contentType,
    };
  }

  async stat(path: string): Promise<{ size: number; contentType?: string } | null> {
    const obj = await this.bucket.head(this.key(path));
    if (!obj) return null;
    return {
      size: typeof (obj as { size?: unknown }).size === 'number' ? (obj as { size: number }).size : 0,
      contentType: (obj as { httpMetadata?: { contentType?: string } }).httpMetadata?.contentType,
    };
  }

  async writeText(path: string, content: string, contentType = 'text/plain'): Promise<void> {
    const delta = await this.delta(path, new TextEncoder().encode(content).byteLength);
    await this.quota?.reserve(delta);
    try {
      await this.writeTextUnmetered(path, content, contentType);
    } catch (error) {
      await this.quota?.reserve(-delta);
      throw error;
    }
  }

  async writeTextUnmetered(path: string, content: string, contentType = 'text/plain'): Promise<void> {
    await this.bucket.put(this.key(path), content, {
      httpMetadata: { contentType },
    });
  }

  async writeBytes(path: string, bytes: ArrayBuffer | ReadableStream, contentType = 'application/octet-stream'): Promise<void> {
    if (bytes instanceof ReadableStream) throw new Error('Quota enforcement requires known byte length.');
    const delta = await this.delta(path, bytes.byteLength);
    await this.quota?.reserve(delta);
    try {
      await this.writeBytesUnmetered(path, bytes, contentType);
    } catch (error) {
      await this.quota?.reserve(-delta);
      throw error;
    }
  }

  async writeBytesUnmetered(path: string, bytes: ArrayBuffer | ReadableStream, contentType = 'application/octet-stream'): Promise<void> {
    await this.bucket.put(this.key(path), bytes, {
      httpMetadata: { contentType },
    });
  }

  async delete(path: string): Promise<void> {
    const current = await this.size(path);
    await this.deleteUnmetered(path);
    if (current > 0) await this.quota?.reserve(-current);
  }

  async deleteUnmetered(path: string): Promise<void> {
    await this.bucket.delete(this.key(path));
  }

  async reserve(delta: number): Promise<void> {
    await this.quota?.reserve(delta);
  }

  async createRollbackBackup(path: string, backupId: string): Promise<string | null> {
    const obj = await this.bucket.get(this.key(path));
    if (!obj) return null;
    const backupPath = `${backupId}/${path}`;
    await this.bucket.put(this.rollbackKey(backupPath), obj.body, {
      httpMetadata: { contentType: obj.httpMetadata?.contentType },
    });
    return backupPath;
  }

  async restoreRollbackBackup(path: string, backupPath: string): Promise<void> {
    const backup = await this.bucket.get(this.rollbackKey(backupPath));
    if (!backup) throw new Error(`Rollback backup not found: ${backupPath}`);
    await this.bucket.put(this.key(path), backup.body, {
      httpMetadata: { contentType: backup.httpMetadata?.contentType },
    });
  }

  async deleteRollbackBackup(backupPath: string): Promise<void> {
    await this.bucket.delete(this.rollbackKey(backupPath));
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

  private rollbackKey(path: string): string {
    return `__rollback/${this.vaultId}/${path.replace(/^\/+/, '')}`;
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
