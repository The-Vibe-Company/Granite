import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';

export function typesCommand(): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);

  console.log('Note types — the natural flow is: source → note → synthesis → output\n');

  for (const [name, tc] of Object.entries(config.note_types)) {
    console.log(`  ${name}`);
    console.log(`    ${tc.description}`);
    console.log(`    folder: ${tc.folder}  |  limit: ${tc.line_limit} lines`);
    if (tc.instructions) {
      console.log(`    guide: ${tc.instructions}`);
    }
    if (tc.frontmatter_defaults) {
      const defaults = Object.entries(tc.frontmatter_defaults)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      console.log(`    defaults: ${defaults}`);
    }
    console.log('');
  }

  console.log(`Default type: ${config.defaults.note_type}`);
  console.log('');
  console.log('When to use what:');
  console.log('  source     Raw material — articles, tweets, papers. Keep it close to the original.');
  console.log('  note       One durable idea. If it\'s two ideas, make two notes.');
  console.log('  synthesis  Compile multiple notes into new understanding. The most valuable type.');
  console.log('  output     Audience-specific deliverable. Ephemeral — always derived_from something durable.');
  console.log('');
  console.log('Usage: granite new "Title" --type <type>');
}
