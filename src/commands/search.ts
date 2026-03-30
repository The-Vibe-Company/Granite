import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { ensureIndex } from '../core/index-db.js';
import { searchNotes } from '../core/search.js';

export function searchCommand(query: string): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const db = ensureIndex(vaultRoot, config);

  const results = searchNotes(db, query);
  db.close();

  if (results.length === 0) {
    console.log('No results found.');
    return;
  }

  for (const r of results) {
    console.log(`  ${r.title} (${r.slug})`);
    console.log(`    ${r.snippet}`);
    console.log('');
  }
}
