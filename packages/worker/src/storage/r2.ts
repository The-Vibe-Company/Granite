export class R2NoteStorage {
  constructor(
    private bucket: R2Bucket,
    private vaultId: string,
  ) {}

  private noteKey(typeFolder: string, slug: string): string {
    return `${this.vaultId}/${typeFolder}/${slug}.md`;
  }

  async readNote(typeFolder: string, slug: string): Promise<string> {
    const key = this.noteKey(typeFolder, slug);
    const obj = await this.bucket.get(key);
    if (!obj) throw new Error(`Note not found in R2: ${typeFolder}/${slug}`);
    return obj.text();
  }

  async writeNote(typeFolder: string, slug: string, content: string): Promise<void> {
    const key = this.noteKey(typeFolder, slug);
    await this.bucket.put(key, content, {
      httpMetadata: { contentType: 'text/markdown' },
    });
  }

  async deleteNote(typeFolder: string, slug: string): Promise<void> {
    const key = this.noteKey(typeFolder, slug);
    await this.bucket.delete(key);
  }

  async noteExists(typeFolder: string, slug: string): Promise<boolean> {
    const key = this.noteKey(typeFolder, slug);
    const head = await this.bucket.head(key);
    return head !== null;
  }

  async listSlugs(typeFolder: string): Promise<string[]> {
    const prefix = `${this.vaultId}/${typeFolder}/`;
    const slugs: string[] = [];
    let cursor: string | undefined;

    do {
      const listed = await this.bucket.list({ prefix, cursor });
      for (const obj of listed.objects) {
        const name = obj.key.slice(prefix.length);
        if (name.endsWith('.md')) {
          slugs.push(name.slice(0, -3));
        }
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return slugs;
  }

  async readConfig(): Promise<string> {
    const key = `${this.vaultId}/granite.yml`;
    const obj = await this.bucket.get(key);
    if (!obj) throw new Error('Config not found in R2');
    return obj.text();
  }

  async writeConfig(content: string): Promise<void> {
    const key = `${this.vaultId}/granite.yml`;
    await this.bucket.put(key, content, {
      httpMetadata: { contentType: 'text/yaml' },
    });
  }
}
