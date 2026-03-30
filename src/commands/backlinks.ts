import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { ensureIndex } from '../core/index-db.js';
import { getBacklinks } from '../core/backlinks.js';
import { jsonSuccess } from '../core/json-output.js';

export function backlinksCommand(slug: string, options: { json?: boolean }): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const db = ensureIndex(vaultRoot, config);

  const backlinks = getBacklinks(db, slug);
  db.close();

  if (options.json) {
    console.log(jsonSuccess(backlinks));
    return;
  }

  if (backlinks.length === 0) {
    console.log(`No backlinks found for "${slug}".`);
    return;
  }

  console.log(`Backlinks to "${slug}":`);
  console.log('');
  for (const bl of backlinks) {
    console.log(`  ← ${bl.source_title} (${bl.source_slug})`);
    if (bl.context) {
      console.log(`    ${bl.context}`);
    }
    console.log('');
  }
}
