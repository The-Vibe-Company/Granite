import fs from 'node:fs';
import path from 'node:path';
import type { Note, SyncChange, SyncConflict } from '../types.js';
import { readNote } from '../note.js';
import { serializeFrontmatter } from '../frontmatter.js';

const CONFLICTS_DIR = '.granite/conflicts';

function getConflictsDir(vaultRoot: string): string {
  const dir = path.join(vaultRoot, CONFLICTS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function detectConflict(localNote: Note, remoteChange: SyncChange): boolean {
  if (remoteChange.operation === 'delete') return false;
  if (!remoteChange.frontmatter) return false;

  const localModified = new Date(localNote.frontmatter.modified).getTime();
  const remoteModified = new Date(remoteChange.frontmatter.modified).getTime();

  // Both modified since last sync — conflict
  return localModified !== remoteModified && remoteChange.checksum !== '';
}

export function resolveConflict(
  vaultRoot: string,
  localNote: Note,
  remoteChange: SyncChange,
  deviceId: string,
): SyncConflict | null {
  if (!remoteChange.frontmatter || remoteChange.body === undefined) return null;

  const localModified = new Date(localNote.frontmatter.modified).getTime();
  const remoteModified = new Date(remoteChange.frontmatter.modified).getTime();

  // Last-Write-Wins: most recent timestamp wins
  const remoteWins = remoteModified > localModified;

  if (remoteWins) {
    // Save local version as conflict backup
    const conflictFile = saveConflictBackup(vaultRoot, localNote, deviceId);

    return {
      note_id: localNote.frontmatter.id,
      local_modified: localNote.frontmatter.modified,
      remote_modified: remoteChange.frontmatter.modified,
      resolved: true,
      conflict_file: conflictFile,
    };
  }

  // Local wins — save remote version as conflict backup
  const conflictFile = saveRemoteConflictBackup(vaultRoot, remoteChange);

  return {
    note_id: localNote.frontmatter.id,
    local_modified: localNote.frontmatter.modified,
    remote_modified: remoteChange.frontmatter.modified,
    resolved: true,
    conflict_file: conflictFile,
  };
}

function saveConflictBackup(vaultRoot: string, note: Note, deviceId: string): string {
  const conflictsDir = getConflictsDir(vaultRoot);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${note.frontmatter.id}_${deviceId}_${timestamp}.md`;
  const filePath = path.join(conflictsDir, filename);

  const content = serializeFrontmatter(note.frontmatter, note.body);
  fs.writeFileSync(filePath, content, 'utf-8');

  return filePath;
}

function saveRemoteConflictBackup(vaultRoot: string, change: SyncChange): string {
  const conflictsDir = getConflictsDir(vaultRoot);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${change.note_id}_remote_${timestamp}.md`;
  const filePath = path.join(conflictsDir, filename);

  if (change.frontmatter && change.body !== undefined) {
    const content = serializeFrontmatter(change.frontmatter, change.body);
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  return filePath;
}

export function listConflicts(vaultRoot: string): string[] {
  const conflictsDir = path.join(vaultRoot, CONFLICTS_DIR);
  if (!fs.existsSync(conflictsDir)) return [];
  return fs.readdirSync(conflictsDir)
    .filter((f: string) => f.endsWith('.md'))
    .map((f: string) => path.join(conflictsDir, f));
}

export function clearResolvedConflicts(vaultRoot: string): number {
  const files = listConflicts(vaultRoot);
  for (const f of files) {
    fs.unlinkSync(f);
  }
  return files.length;
}
