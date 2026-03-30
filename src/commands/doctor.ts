import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { ensureIndex } from '../core/index-db.js';
import { runDoctor } from '../core/doctor.js';

export function doctorCommand(): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const db = ensureIndex(vaultRoot, config);

  const issues = runDoctor(vaultRoot, config, db);
  db.close();

  if (issues.length === 0) {
    console.log('No issues found. Vault is healthy.');
    return;
  }

  const errors = issues.filter(i => i.level === 'error');
  const warnings = issues.filter(i => i.level === 'warning');
  const infos = issues.filter(i => i.level === 'info');

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

  if (errors.length > 0) process.exit(1);
}
