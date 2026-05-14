import { describe, expect, it, vi } from 'vitest';
import { CloudMcpRuntime, type VaultSqlIndex } from '../../packages/cloudflare-mcp/src/runtime.js';
import type { R2VaultStorage } from '../../packages/cloudflare-mcp/src/storage/r2.js';

describe('granite cloudflare runtime', () => {
  it('rejects asset imports that target the reserved vault config path', async () => {
    const storage = {
      writeTextUnmetered: vi.fn(),
      writeBytesUnmetered: vi.fn(),
    };
    const index = {
      initialize: vi.fn(),
      clear: vi.fn(),
    };
    const runtime = new CloudMcpRuntime(
      'v_1',
      storage as unknown as R2VaultStorage,
      index as unknown as VaultSqlIndex,
    );

    await expect(runtime.importVault({
      config: validConfig(),
      notes: [],
      assets: [{ path: 'granite.yml', content_base64: 'Y29uZmlnOiBvdmVyd3JpdGU=' }],
    })).rejects.toThrow('Invalid import path: granite.yml');

    expect(index.initialize).not.toHaveBeenCalled();
    expect(index.clear).not.toHaveBeenCalled();
    expect(storage.writeTextUnmetered).not.toHaveBeenCalled();
    expect(storage.writeBytesUnmetered).not.toHaveBeenCalled();
  });

  it('rejects imports with duplicate basename-derived note slugs before writing', async () => {
    const storage = {
      writeTextUnmetered: vi.fn(),
      writeBytesUnmetered: vi.fn(),
    };
    const index = {
      initialize: vi.fn(),
      clear: vi.fn(),
    };
    const runtime = new CloudMcpRuntime(
      'v_1',
      storage as unknown as R2VaultStorage,
      index as unknown as VaultSqlIndex,
    );

    await expect(runtime.importVault({
      config: validConfig(),
      notes: [
        { path: 'notes/same.md', content: '# One\n' },
        { path: 'drafts/same.md', content: '# Two\n' },
      ],
      assets: [],
    })).rejects.toThrow('Duplicate note slug in import: same');

    expect(index.initialize).not.toHaveBeenCalled();
    expect(storage.writeTextUnmetered).not.toHaveBeenCalled();
  });

  it('rejects asset imports that collide with note paths before writing', async () => {
    const storage = {
      writeTextUnmetered: vi.fn(),
      writeBytesUnmetered: vi.fn(),
    };
    const index = {
      initialize: vi.fn(),
      clear: vi.fn(),
    };
    const runtime = new CloudMcpRuntime(
      'v_1',
      storage as unknown as R2VaultStorage,
      index as unknown as VaultSqlIndex,
    );

    await expect(runtime.importVault({
      config: validConfig(),
      notes: [{ path: 'notes/same.md', content: '# Same\n' }],
      assets: [{ path: 'notes/same.md', content_base64: 'YmluYXJ5' }],
    })).rejects.toThrow('Duplicate import path: notes/same.md');

    expect(index.initialize).not.toHaveBeenCalled();
    expect(storage.writeTextUnmetered).not.toHaveBeenCalled();
    expect(storage.writeBytesUnmetered).not.toHaveBeenCalled();
  });

  it('rejects note import paths with an empty basename', async () => {
    const runtime = new CloudMcpRuntime(
      'v_1',
      { writeTextUnmetered: vi.fn(), writeBytesUnmetered: vi.fn() } as unknown as R2VaultStorage,
      { initialize: vi.fn(), clear: vi.fn() } as unknown as VaultSqlIndex,
    );

    await expect(runtime.importVault({
      config: validConfig(),
      notes: [{ path: '.md', content: '# Empty\n' }],
      assets: [],
    })).rejects.toThrow('Invalid note import path: .md');
  });

  it('rejects configs whose default note type is not configured', async () => {
    const storage = {
      writeTextUnmetered: vi.fn(),
      writeBytesUnmetered: vi.fn(),
    };
    const index = {
      initialize: vi.fn(),
      clear: vi.fn(),
    };
    const runtime = new CloudMcpRuntime(
      'v_1',
      storage as unknown as R2VaultStorage,
      index as unknown as VaultSqlIndex,
    );

    await expect(runtime.importVault({
      config: [
        'vault_name: Cloud Vault',
        'version: 1',
        'note_types:',
        '  source:',
        '    folder: sources',
        'defaults:',
        '  note_type: note',
      ].join('\n'),
      notes: [],
      assets: [],
    })).rejects.toThrow('Invalid Granite config.');

    expect(index.initialize).not.toHaveBeenCalled();
    expect(storage.writeTextUnmetered).not.toHaveBeenCalled();
  });

  it('replaces the index only after import files are written', async () => {
    const storage = {
      list: vi.fn(async () => ['old.md']),
      exists: vi.fn(async () => false),
      stat: vi.fn(async (path: string) => path === 'old.md' ? { size: 10 } : null),
      reserve: vi.fn(async () => undefined),
      writeTextUnmetered: vi.fn(async () => undefined),
      writeBytesUnmetered: vi.fn(async () => undefined),
      deleteUnmetered: vi.fn(async () => undefined),
    };
    const index = {
      initialize: vi.fn(async () => undefined),
      replaceAll: vi.fn(async () => undefined),
    };
    const runtime = new CloudMcpRuntime(
      'v_1',
      storage as unknown as R2VaultStorage,
      index as unknown as VaultSqlIndex,
    );

    await expect(runtime.importVault({
      config: validConfig(),
      notes: [{ path: 'notes/smoke.md', content: noteContent('Smoke') }],
      assets: [{ path: 'assets/logo.txt', content_base64: 'bG9nbw==', content_type: 'text/plain' }],
    })).resolves.toEqual({ note_count: 1, asset_count: 1 });

    expect(storage.writeTextUnmetered).toHaveBeenCalledWith('granite.yml', validConfig(), 'text/yaml');
    expect(storage.writeTextUnmetered).toHaveBeenCalledWith('notes/smoke.md', noteContent('Smoke'), 'text/markdown');
    expect(index.replaceAll).toHaveBeenCalledTimes(1);
    expect(storage.deleteUnmetered).toHaveBeenCalledWith('old.md');
  });

  it('rolls back import writes and keeps the index untouched when storage fails', async () => {
    const storage = {
      list: vi.fn(async () => []),
      exists: vi.fn(async () => false),
      stat: vi.fn(async () => null),
      reserve: vi.fn(async () => undefined),
      readBytes: vi.fn(),
      writeTextUnmetered: vi.fn(async (path: string) => {
        if (path === 'notes/fail.md') throw new Error('R2 write failed');
      }),
      writeBytesUnmetered: vi.fn(async () => undefined),
      deleteUnmetered: vi.fn(async () => undefined),
    };
    const index = {
      initialize: vi.fn(async () => undefined),
      replaceAll: vi.fn(async () => undefined),
    };
    const runtime = new CloudMcpRuntime(
      'v_1',
      storage as unknown as R2VaultStorage,
      index as unknown as VaultSqlIndex,
    );

    await expect(runtime.importVault({
      config: validConfig(),
      notes: [{ path: 'notes/fail.md', content: noteContent('Fail') }],
      assets: [],
    })).rejects.toThrow('R2 write failed');

    expect(storage.deleteUnmetered).toHaveBeenCalledWith('granite.yml');
    expect(index.initialize).not.toHaveBeenCalled();
    expect(index.replaceAll).not.toHaveBeenCalled();
  });

  it('rolls back import writes when index replacement fails', async () => {
    const storage = {
      list: vi.fn(async () => []),
      exists: vi.fn(async () => false),
      stat: vi.fn(async () => null),
      reserve: vi.fn(async () => undefined),
      readBytes: vi.fn(),
      writeTextUnmetered: vi.fn(async () => undefined),
      writeBytesUnmetered: vi.fn(async () => undefined),
      deleteUnmetered: vi.fn(async () => undefined),
    };
    const index = {
      initialize: vi.fn(async () => undefined),
      replaceAll: vi.fn(async () => {
        throw new Error('index replace failed');
      }),
    };
    const runtime = new CloudMcpRuntime(
      'v_1',
      storage as unknown as R2VaultStorage,
      index as unknown as VaultSqlIndex,
    );

    await expect(runtime.importVault({
      config: validConfig(),
      notes: [{ path: 'notes/fail.md', content: noteContent('Fail') }],
      assets: [{ path: 'assets/fail.txt', content_base64: 'ZmFpbA==' }],
    })).rejects.toThrow('index replace failed');

    expect(storage.deleteUnmetered).toHaveBeenCalledWith('assets/fail.txt');
    expect(storage.deleteUnmetered).toHaveBeenCalledWith('notes/fail.md');
    expect(storage.deleteUnmetered).toHaveBeenCalledWith('granite.yml');
  });

  it('restores rollback backups when rolling back overwritten files', async () => {
    const storage = {
      list: vi.fn(async () => []),
      exists: vi.fn(async (path: string) => path === 'granite.yml'),
      stat: vi.fn(async (path: string) => path === 'granite.yml' ? { size: 10 } : null),
      reserve: vi.fn(async () => undefined),
      createRollbackBackup: vi.fn(async () => '.rollback/backup/granite.yml'),
      restoreRollbackBackup: vi.fn(async () => undefined),
      deleteRollbackBackup: vi.fn(async () => undefined),
      writeTextUnmetered: vi.fn(async (path: string) => {
        if (path === 'notes/fail.md') throw new Error('R2 write failed');
      }),
      writeBytesUnmetered: vi.fn(async () => undefined),
      deleteUnmetered: vi.fn(async () => undefined),
    };
    const index = {
      initialize: vi.fn(async () => undefined),
      replaceAll: vi.fn(async () => undefined),
    };
    const runtime = new CloudMcpRuntime(
      'v_1',
      storage as unknown as R2VaultStorage,
      index as unknown as VaultSqlIndex,
    );

    await expect(runtime.importVault({
      config: validConfig(),
      notes: [{ path: 'notes/fail.md', content: noteContent('Fail') }],
      assets: [],
    })).rejects.toThrow('R2 write failed');

    expect(storage.restoreRollbackBackup).toHaveBeenCalledWith('granite.yml', '.rollback/backup/granite.yml');
    expect(storage.deleteRollbackBackup).toHaveBeenCalledWith('.rollback/backup/granite.yml');
  });
});

function validConfig(): string {
  return [
    'vault_name: Cloud Vault',
    'version: 1',
    'note_types:',
    '  note:',
    '    folder: notes',
    'defaults:',
    '  note_type: note',
  ].join('\n');
}

function noteContent(title: string): string {
  return [
    '---',
    `title: ${title}`,
    'type: note',
    'created: 2026-05-14T00:00:00.000Z',
    'modified: 2026-05-14T00:00:00.000Z',
    'tags: []',
    'aliases: []',
    '---',
    '',
    `${title} body`,
  ].join('\n');
}
