import fs from 'node:fs';
import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { createNote } from '../core/note.js';

export function addNote(text?: string): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const typeName = config.defaults.note_type;

  let content: string;

  if (text) {
    content = text;
  } else if (!process.stdin.isTTY) {
    // Read from stdin (pipe)
    content = fs.readFileSync(0, 'utf-8').trim();
  } else {
    console.error('Usage: mem add "some text" or echo "text" | mem add');
    process.exit(1);
  }

  if (!content) {
    console.error('No content provided.');
    process.exit(1);
  }

  // Auto-generate title from content
  const firstLine = content.split('\n')[0];
  const title = firstLine.length > 60 ? firstLine.slice(0, 60).trim() + '...' : firstLine;

  const note = createNote(vaultRoot, config, typeName, title, content + '\n');
  console.log(note.filepath);
}
