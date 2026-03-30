import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { createNote } from '../core/note.js';

export function newNote(title: string, typeName?: string): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const resolvedType = typeName || config.defaults.note_type;
  const note = createNote(vaultRoot, config, resolvedType, title);

  const typeConfig = config.note_types[resolvedType];
  const lines = note.body.split('\n').length;
  if (typeConfig && typeConfig.line_limit && lines > typeConfig.line_limit) {
    const action = typeConfig.warn_only ? 'Warning' : 'Error';
    console.warn(`${action}: Note exceeds ${typeConfig.line_limit} line limit for type "${resolvedType}"`);
  }

  console.log(note.filepath);

  // Show instructions if available
  if (typeConfig?.instructions) {
    console.log('');
    console.log(`  💡 ${typeConfig.instructions}`);
  }
}
