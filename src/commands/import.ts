import { loadConfig } from '../core/config.js';
import { importDocument } from '../core/import-document.js';
import { syncVaultIndexAfterNoteWrite } from '../core/index-db.js';
import { jsonSuccess } from '../core/json-output.js';
import { recommendNote, formatRecommendations } from '../core/recommendations.js';
import { requireVaultRoot } from '../core/vault.js';

interface ImportOptions {
  title?: string;
  tag?: string;
  alias?: string;
  json?: boolean;
}

export function importDocumentCommand(filePath: string, options: ImportOptions = {}): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  let imported: ReturnType<typeof importDocument>;
  try {
    imported = importDocument(vaultRoot, config, filePath, {
      title: options.title,
      tags: splitCsv(options.tag),
      aliases: splitCsv(options.alias),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  syncVaultIndexAfterNoteWrite(vaultRoot, config, imported.note, { rebuild: true });
  const recommendations = recommendNote(vaultRoot, config, imported.note, { strategy: 'incremental' });

  if (options.json) {
    console.log(jsonSuccess({
      slug: imported.note.slug,
      title: imported.note.frontmatter.title,
      type: imported.note.frontmatter.type,
      status: imported.note.frontmatter.status,
      source: imported.note.frontmatter.source,
      review_state: imported.note.frontmatter.review_state,
      durability: imported.note.frontmatter.durability,
      filepath: imported.note.filepath,
      asset: imported.asset,
      recommendations,
    }));
    return;
  }

  console.log(imported.note.filepath);
  console.log(`Document: ${imported.asset.path}`);

  const recommendationLines = formatRecommendations(recommendations);
  if (recommendationLines.length > 0) {
    console.log('');
    console.log('Recommendations:');
    for (const line of recommendationLines) {
      console.log(line);
    }
  }

  console.log('');
  console.log(`Imported as source "${imported.note.frontmatter.title}" (${imported.note.slug})`);
  console.log(`Next: Refine → granite edit ${imported.note.slug} | Read in context → granite recommend ${imported.note.slug}`);
}

function splitCsv(value?: string): string[] {
  return value
    ? value.split(',').map(part => part.trim()).filter(Boolean)
    : [];
}
