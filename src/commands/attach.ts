import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { jsonSuccess } from '../core/json-output.js';

interface AttachOptions {
  slug?: string;
  json?: boolean;
}

/**
 * Copy a file into the vault's assets/ directory.
 * Returns the markdown image/link syntax to embed in a note.
 */
export function attachCommand(filePath: string, options: AttachOptions = {}): void {
  const vaultRoot = requireVaultRoot();

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const assetsDir = path.join(vaultRoot, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  const fileName = path.basename(filePath);
  const destPath = path.join(assetsDir, fileName);

  // If file already exists, add a timestamp suffix
  let finalName = fileName;
  if (fs.existsSync(destPath)) {
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    const timestamp = Date.now();
    finalName = `${base}-${timestamp}${ext}`;
  }

  const finalPath = path.join(assetsDir, finalName);
  fs.copyFileSync(filePath, finalPath);

  const ext = path.extname(finalName).toLowerCase();
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
  const videoExts = ['.mp4', '.webm'];

  let markdown: string;
  if (imageExts.includes(ext)) {
    markdown = `![${finalName}](assets/${finalName})`;
  } else if (videoExts.includes(ext)) {
    markdown = `[${finalName}](assets/${finalName})`;
  } else {
    markdown = `[${finalName}](assets/${finalName})`;
  }

  if (options.json) {
    console.log(jsonSuccess({
      file: finalName,
      path: finalPath,
      markdown,
      slug: options.slug ?? null,
    }));
    return;
  }

  console.log(`Attached: ${finalPath}`);
  console.log(`Markdown: ${markdown}`);
  if (options.slug) {
    console.log(`Add to note: granite edit ${options.slug} --append '${markdown}'`);
  }
}
