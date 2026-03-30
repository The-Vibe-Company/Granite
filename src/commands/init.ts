import fs from 'node:fs';
import path from 'node:path';
import { writeDefaultConfig, CONFIG_FILENAME, loadConfig } from '../core/config.js';

export function initVault(dir: string): void {
  const targetDir = path.resolve(dir);

  if (fs.existsSync(path.join(targetDir, CONFIG_FILENAME))) {
    console.error(`Vault already exists in ${targetDir}`);
    process.exit(1);
  }

  // Write config
  writeDefaultConfig(targetDir);

  // Create .granite directory
  fs.mkdirSync(path.join(targetDir, '.granite'), { recursive: true });

  // Create default note type folders
  const config = loadConfig(targetDir);
  for (const typeConfig of Object.values(config.note_types)) {
    fs.mkdirSync(path.join(targetDir, typeConfig.folder), { recursive: true });
  }

  console.log(`Vault initialized in ${targetDir}`);
  console.log('');
  console.log('Created:');
  console.log(`  ${CONFIG_FILENAME}`);
  console.log('  .granite/');
  for (const [name, typeConfig] of Object.entries(config.note_types)) {
    console.log(`  ${typeConfig.folder}/  (${name})`);
  }
  console.log('');
  console.log('Next: mem new fleeting "My first note"');
}
