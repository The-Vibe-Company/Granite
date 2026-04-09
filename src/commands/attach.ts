import { requireVaultRoot } from '../core/vault.js';
import { jsonSuccess } from '../core/json-output.js';
import { attachAsset } from '../core/assets.js';

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
  let asset: ReturnType<typeof attachAsset>;
  try {
    asset = attachAsset(vaultRoot, filePath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (options.json) {
    console.log(jsonSuccess({
      file: asset.file,
      path: asset.path,
      markdown: asset.markdown,
      slug: options.slug ?? null,
    }));
    return;
  }

  console.log(`Attached: ${asset.path}`);
  console.log(`Markdown: ${asset.markdown}`);
  if (options.slug) {
    console.log(`Add to note: granite edit ${options.slug} --append '${asset.markdown}'`);
  }
}
