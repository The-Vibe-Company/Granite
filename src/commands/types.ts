import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';

export function typesCommand(): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);

  console.log('Available note types:\n');

  for (const [name, tc] of Object.entries(config.note_types)) {
    console.log(`  ${name}`);
    console.log(`    ${tc.description}`);
    console.log(`    folder: ${tc.folder}  |  limit: ${tc.line_limit} lines`);
    if (tc.instructions) {
      console.log(`    guide: ${tc.instructions}`);
    }
    console.log('');
  }

  console.log(`Default type: ${config.defaults.note_type}`);
  console.log(`\nUsage: granite new <type> <title>`);
}
