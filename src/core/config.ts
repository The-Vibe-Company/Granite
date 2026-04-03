import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { GraniteConfig } from './types.js';

const CONFIG_FILENAME = 'granite.yml';

const DEFAULT_CONFIG: GraniteConfig = {
  vault_name: 'My Vault',
  version: 1,
  note_types: {
    note: {
      folder: 'notes/notes',
      description: 'Refined, linked notes — one idea per note',
      template: '## Summary\n\n## Details\n\n## Links\n',
      line_limit: 200,
      warn_only: false,
      instructions: 'One atomic idea per note. Write a clear summary, then expand in details. Link to related notes with [[wikilinks]]. If the note grows too long, split it.',
      frontmatter_defaults: {
        durability: 'canonical',
      },
    },
    source: {
      folder: 'notes/sources',
      description: 'Imported or observed source material kept close to the original',
      template: '## Summary\n\n## Key Facts\n\n- \n\n## Raw Content\n\n## Links\n',
      line_limit: 400,
      warn_only: true,
      instructions: 'Keep the source close to the original. Capture provenance in frontmatter, summarize the essentials, and link to durable notes or syntheses.',
      frontmatter_defaults: {
        durability: 'canonical',
      },
    },
    synthesis: {
      folder: 'notes/syntheses',
      description: 'Compiled knowledge that connects multiple notes or sources',
      template: '## Scope\n\n## Executive Summary\n\n## Main Themes\n\n## Open Questions\n\n## Links\n',
      line_limit: 300,
      warn_only: true,
      instructions: 'Use syntheses for durable compiled knowledge. Keep the scope explicit, summarize clearly, and point back to the notes or sources in derived_from.',
      frontmatter_defaults: {
        durability: 'canonical',
      },
    },
    output: {
      folder: 'notes/outputs',
      description: 'Audience-specific outputs such as briefs, reports, or slides',
      template: '## Goal\n\n## Audience\n\n## Output\n\n## References\n',
      line_limit: 300,
      warn_only: true,
      instructions: 'Outputs are situational deliverables. Keep them readable, point back to the durable knowledge they derive from, and make them easy to regenerate or archive.',
      frontmatter_defaults: {
        durability: 'ephemeral',
      },
    },
  },
  defaults: {
    note_type: 'note',
    editor: '$EDITOR',
  },
  index: {
    auto_rebuild: true,
  },
};

export function getDefaultConfig(): GraniteConfig {
  return structuredClone(DEFAULT_CONFIG);
}

export function writeDefaultConfig(dir: string): void {
  const configPath = path.join(dir, CONFIG_FILENAME);
  const content = yaml.dump(DEFAULT_CONFIG, { lineWidth: 120, noRefs: true });
  fs.writeFileSync(configPath, content, 'utf-8');
}

export function loadConfig(vaultRoot: string): GraniteConfig {
  const configPath = path.join(vaultRoot, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    throw new Error(`No ${CONFIG_FILENAME} found in ${vaultRoot}. Run "granite init" first.`);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = yaml.load(raw) as GraniteConfig;
  return parsed;
}

export { CONFIG_FILENAME };
