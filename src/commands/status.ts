import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { listNotes } from '../core/note.js';
import { ensureIndex } from '../core/index-db.js';
import { runDoctor } from '../core/doctor.js';
import { getBacklinks } from '../core/backlinks.js';
import { jsonSuccess } from '../core/json-output.js';

export function statusCommand(options: { json?: boolean } = {}): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const notes = listNotes(vaultRoot, config);

  // Count by type
  const byType: Record<string, number> = {};
  for (const note of notes) {
    byType[note.frontmatter.type] = (byType[note.frontmatter.type] ?? 0) + 1;
  }

  // Count by status
  const inbox = notes.filter(n => n.frontmatter.status === 'inbox');
  const drafts = notes.filter(n => n.frontmatter.review_state === 'draft' && n.frontmatter.status === 'active');
  const orphans: string[] = [];

  // Find orphans (notes with no backlinks)
  const db = ensureIndex(vaultRoot, config);
  const issues = runDoctor(vaultRoot, config, db);

  for (const note of notes.slice(0, 50)) {
    const bl = getBacklinks(db, note.slug);
    if (bl.length === 0 && note.outgoing_links.length === 0) {
      orphans.push(note.slug);
    }
  }
  db.close();

  const errors = issues.filter(i => i.level === 'error');

  // Determine next actions
  const nextActions: string[] = [];

  if (notes.length === 0) {
    nextActions.push('Your vault is empty. Start capturing: granite add "Your first thought"');
  } else {
    if (inbox.length > 0) {
      nextActions.push(`Process your inbox: ${inbox.length} note(s) waiting → granite show ${inbox[0].slug}`);
    }
    if (drafts.length > 0) {
      nextActions.push(`Review drafts: ${drafts.length} active draft(s) → granite show ${drafts[0].slug}`);
    }
    if (errors.length > 0) {
      nextActions.push(`Fix ${errors.length} error(s) found by doctor → granite doctor`);
    }
    if (orphans.length > 0) {
      nextActions.push(`Connect ${orphans.length} orphan note(s) → granite suggest-links ${orphans[0]}`);
    }
    const syntheses = byType['synthesis'] ?? 0;
    const notesAndSources = (byType['note'] ?? 0) + (byType['source'] ?? 0);
    if (notesAndSources >= 5 && syntheses === 0) {
      nextActions.push('You have enough notes to compile a synthesis → granite recommend <slug>');
    }
    if (nextActions.length === 0) {
      nextActions.push('Vault is healthy. Keep capturing or run: granite doctor');
    }
  }

  if (options.json) {
    console.log(jsonSuccess({
      vault_name: config.vault_name,
      note_count: notes.length,
      notes_by_type: byType,
      inbox_count: inbox.length,
      draft_count: drafts.length,
      orphan_count: orphans.length,
      error_count: errors.length,
      next_actions: nextActions,
    }));
    return;
  }

  console.log(`${config.vault_name}`);
  console.log('');

  // Stats
  const typeLine = Object.entries(byType)
    .map(([type, count]) => `${count} ${type}${count > 1 ? 's' : ''}`)
    .join(', ');
  console.log(`  ${notes.length} notes: ${typeLine || 'none'}`);

  if (inbox.length > 0 || drafts.length > 0 || orphans.length > 0) {
    const parts: string[] = [];
    if (inbox.length > 0) parts.push(`${inbox.length} inbox`);
    if (drafts.length > 0) parts.push(`${drafts.length} drafts`);
    if (orphans.length > 0) parts.push(`${orphans.length} orphans`);
    console.log(`  Attention: ${parts.join(', ')}`);
  }

  if (errors.length > 0) {
    console.log(`  Health: ${errors.length} error(s) — run granite doctor`);
  }

  // Next actions
  console.log('');
  console.log('Next:');
  for (const action of nextActions) {
    console.log(`  → ${action}`);
  }
}
