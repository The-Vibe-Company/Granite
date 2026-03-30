import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { ensureIndex } from '../core/index-db.js';
import { searchNotes } from '../core/search.js';
import { jsonSuccess } from '../core/json-output.js';

export function searchCommand(query: string, options: { json?: boolean }): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const db = ensureIndex(vaultRoot, config);

  const results = searchNotes(db, query);
  db.close();

  if (options.json) {
    console.log(jsonSuccess(results));
    return;
  }

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
