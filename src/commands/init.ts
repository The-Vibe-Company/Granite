import fs from 'node:fs';
import path from 'node:path';
import { writeDefaultConfig, CONFIG_FILENAME, loadConfig } from '../core/config.js';
import { getDefaultVaultRoot, getIndexDbPath } from '../core/vault.js';

export function initVault(dir = getDefaultVaultRoot()): void {
  const targetDir = path.resolve(dir);
  fs.mkdirSync(targetDir, { recursive: true });

  if (fs.existsSync(path.join(targetDir, CONFIG_FILENAME))) {
    console.error(`Vault already exists in ${targetDir}`);
    process.exit(1);
  }

  // Write config
  writeDefaultConfig(targetDir);

  fs.mkdirSync(path.dirname(getIndexDbPath(targetDir)), { recursive: true });

  // Create default note type folders
  const config = loadConfig(targetDir);
  for (const typeConfig of Object.values(config.note_types)) {
    fs.mkdirSync(path.join(targetDir, typeConfig.folder), { recursive: true });
  }

  console.log(`Vault initialized in ${targetDir}`);
  console.log('');
  console.log('Created:');
  console.log(`  ${CONFIG_FILENAME}`);
  const indexDir = path.relative(targetDir, path.dirname(getIndexDbPath(targetDir)));
  if (indexDir) {
    console.log(`  ${indexDir}/`);
  }
  for (const [name, typeConfig] of Object.entries(config.note_types)) {
    console.log(`  ${typeConfig.folder}/  (${name})`);
  }
  console.log('');
  console.log('Next: mem new "My first note" --type fleeting');
}
