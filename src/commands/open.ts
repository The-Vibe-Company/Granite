import { execSync } from 'node:child_process';
import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { findNoteBySlug } from '../core/note.js';

export function openNote(slug: string): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const note = findNoteBySlug(vaultRoot, config, slug);

  if (!note) {
    console.error(`Note not found: "${slug}"`);
    process.exit(1);
  }
  const existingNote = note;

  const editor = config.defaults.editor === '$EDITOR'
    ? process.env.EDITOR || 'vi'
    : config.defaults.editor;

  execSync(`${editor} "${existingNote.filepath}"`, { stdio: 'inherit' });
}
