import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { ensureIndex } from '../core/index-db.js';
import { runDoctor } from '../core/doctor.js';
import { jsonSuccess } from '../core/json-output.js';

export function doctorCommand(options: { json?: boolean } = {}): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const db = ensureIndex(vaultRoot, config);

  const issues = runDoctor(vaultRoot, config, db);
  db.close();

  const errors = issues.filter(i => i.level === 'error');
  const warnings = issues.filter(i => i.level === 'warning');
  const infos = issues.filter(i => i.level === 'info');

  if (options.json) {
    console.log(jsonSuccess({
      healthy: errors.length === 0,
      issues,
      counts: {
        errors: errors.length,
        warnings: warnings.length,
        infos: infos.length,
      },
    }));
    return;
  }

  if (issues.length === 0) {
    console.log('Vault is healthy. No issues found.');
    console.log('');
    console.log('Keep the loop going: granite status');
    return;
  }

  const print = (label: string, items: typeof issues) => {
    if (items.length === 0) return;
    console.log(`\n${label}:`);
    for (const i of items) {
      const file = i.file.replace(vaultRoot + '/', '');
      console.log(`  ${file}: ${i.message}`);
    }
  };

  print('Errors', errors);
  print('Warnings', warnings);
  print('Info', infos);

  console.log(`\n${errors.length} error(s), ${warnings.length} warning(s), ${infos.length} info(s)`);

  // Actionable guidance
  console.log('');
  const brokenLinks = issues.filter(i => i.message.includes('Broken wikilink') || i.message.includes('broken'));
  const overLimit = issues.filter(i => i.message.includes('line limit') || i.message.includes('exceeds'));

  if (brokenLinks.length > 0) {
    console.log(`Fix broken links: ${brokenLinks.length} wikilink(s) point to notes that don't exist.`);
    console.log('  → Create the missing notes or fix the [[wikilinks]].');
  }
  if (overLimit.length > 0) {
    console.log(`Split oversized notes: ${overLimit.length} note(s) exceed their line limit.`);
    console.log('  → Break them into smaller, linked notes. One idea per note.');
  }

  if (errors.length > 0) process.exit(1);
}
