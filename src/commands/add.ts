import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { createNote } from '../core/note.js';

export function addNote(text: string): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const typeName = config.defaults.note_type;

  // Auto-generate title from text
  const title = text.length > 50 ? text.slice(0, 50).trim() + '...' : text;

  const note = createNote(vaultRoot, config, typeName, title, text + '\n');
  console.log(note.filepath);
}
