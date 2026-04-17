import fs from 'node:fs';
import path from 'node:path';
import { writeDefaultConfig, writeTemplateConfig, CONFIG_FILENAME, loadConfig } from '../core/config.js';
import { getDefaultVaultRoot, getIndexDbPath } from '../core/vault.js';

export interface InitVaultOptions {
  template?: string;
}

export function initVault(dir = getDefaultVaultRoot(), options: InitVaultOptions = {}): void {
  const targetDir = path.resolve(dir);
  fs.mkdirSync(targetDir, { recursive: true });

  if (fs.existsSync(path.join(targetDir, CONFIG_FILENAME))) {
    console.error(`Vault already exists in ${targetDir}`);
    process.exit(1);
  }

  if (options.template) {
    writeTemplateConfig(targetDir, options.template);
  } else {
    writeDefaultConfig(targetDir);
  }

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
  console.log('The knowledge loop: capture → compile → query → output → lint');
  console.log('');
  console.log('  source → note → synthesis → output');
  console.log('');
  console.log('Get started:');
  console.log('  granite add "Your first thought"          # Capture something');
  console.log('  granite new "Topic" --type source          # Import source material');
  console.log('  granite status                             # See what to do next');
}
