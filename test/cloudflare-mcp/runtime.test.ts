import { describe, expect, it, vi } from 'vitest';
import { CloudMcpRuntime, type VaultSqlIndex } from '../../packages/cloudflare-mcp/src/runtime.js';
import type { R2VaultStorage } from '../../packages/cloudflare-mcp/src/storage/r2.js';

describe('granite cloudflare runtime', () => {
  it('rejects asset imports that target the reserved vault config path', async () => {
    const storage = {
      writeText: vi.fn(),
      writeBytes: vi.fn(),
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
    expect(storage.writeText).not.toHaveBeenCalled();
    expect(storage.writeBytes).not.toHaveBeenCalled();
  });

  it('rejects imports with duplicate basename-derived note slugs before writing', async () => {
    const storage = {
      writeText: vi.fn(),
      writeBytes: vi.fn(),
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
    expect(storage.writeText).not.toHaveBeenCalled();
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
