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
      fields: {
        document_file: {
          type: 'text',
          description: 'Attached document filename stored in the vault assets directory.',
        },
        document_path: {
          type: 'text',
          description: 'Vault-relative path to the attached document.',
        },
        document_mime: {
          type: 'text',
          description: 'MIME type of the attached document.',
        },
        document_sha256: {
          type: 'text',
          description: 'SHA-256 hash of the attached document.',
        },
        document_resource_uri: {
          type: 'text',
          description: 'Granite MCP resource URI for the attached document.',
        },
      },
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

export function writeTemplateConfig(dir: string, templateName: string): void {
  const configPath = path.join(dir, CONFIG_FILENAME);
  const templatePath = resolveTemplatePath(templateName);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Unknown template "${templateName}". Not found at ${templatePath}.`);
  }
  const raw = fs.readFileSync(templatePath, 'utf-8');
  // Validate before writing to fail fast on malformed templates.
  const parsed = yaml.load(raw) as GraniteConfig;
  validateConfig(parsed);
  fs.writeFileSync(configPath, raw, 'utf-8');
}

function getTemplatesDir(): string {
  // Resolve relative to this file — works in both src (dev) and dist (built).
  const fileUrl = new URL('.', import.meta.url);
  const thisDir = decodeURIComponent(fileUrl.pathname);
  // Prod (bundled): dist/index.js → dist/templates/
  // Dev (tsx src/core/config.ts): src/core/ → ../../templates
  const candidates = [
    path.resolve(thisDir, 'templates'),
    path.resolve(thisDir, '../templates'),
    path.resolve(thisDir, '../../templates'),
    path.resolve(process.cwd(), 'templates'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function resolveTemplatePath(name: string): string {
  return path.join(getTemplatesDir(), `${name}.yml`);
}

export function loadConfig(vaultRoot: string): GraniteConfig {
  const configPath = path.join(vaultRoot, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    throw new Error(`No ${CONFIG_FILENAME} found in ${vaultRoot}. Run "granite init" first.`);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = yaml.load(raw) as GraniteConfig;
  validateConfig(parsed);
  return parsed;
}

export function validateConfig(config: GraniteConfig): void {
  const typeNames = new Set(Object.keys(config.note_types));

  for (const [typeName, typeConfig] of Object.entries(config.note_types)) {
    const fieldNames = new Set(Object.keys(typeConfig.fields ?? {}));

    for (const [fieldName, fieldDef] of Object.entries(typeConfig.fields ?? {})) {
      if (fieldDef.type === 'wikilink' && fieldDef.target_types) {
        for (const target of fieldDef.target_types) {
          if (!typeNames.has(target)) {
            throw new Error(
              `Invalid config: type "${typeName}" field "${fieldName}" references unknown target_type "${target}"`,
            );
          }
        }
      }
    }

    for (const indexed of typeConfig.indexed_fields ?? []) {
      if (!fieldNames.has(indexed)) {
        throw new Error(
          `Invalid config: type "${typeName}" indexed_fields references undefined field "${indexed}"`,
        );
      }
    }

    validateHooks(typeName, 'on_create', typeConfig.on_create ?? [], fieldNames);
    validateHooks(typeName, 'on_update', typeConfig.on_update ?? [], fieldNames);

    if (typeConfig.lifecycle) {
      const states = new Set(typeConfig.lifecycle.states);
      for (const t of typeConfig.lifecycle.transitions) {
        if (!states.has(t.from) || !states.has(t.to)) {
          throw new Error(
            `Invalid config: type "${typeName}" lifecycle transition ${t.from}→${t.to} references undeclared state`,
          );
        }
      }
    }
  }
}

function validateHooks(
  typeName: string,
  phase: 'on_create' | 'on_update',
  hooks: import('./types.js').Hook[],
  fieldNames: Set<string>,
): void {
  for (const hook of hooks) {
    if (hook.action === 'resolve_wikilinks') {
      for (const f of hook.fields) {
        if (!fieldNames.has(f)) {
          throw new Error(
            `Invalid config: type "${typeName}" ${phase} resolve_wikilinks references undefined field "${f}"`,
          );
        }
      }
    }
    if (hook.action === 'hash_source' || hook.action === 'set_default') {
      if (!isKnownHookField(hook.field, fieldNames)) {
        throw new Error(
          `Invalid config: type "${typeName}" ${phase} ${hook.action} references undefined field "${hook.field}"`,
        );
      }
    }
    if (hook.action === 'hash_source') {
      if (!isKnownHookField(hook.target, fieldNames)) {
        throw new Error(
          `Invalid config: type "${typeName}" ${phase} hash_source references undefined target field "${hook.target}"`,
        );
      }
    }
  }
}

const WELL_KNOWN_HOOK_FIELDS = new Set([
  'document_file',
  'document_path',
  'document_mime',
  'document_sha256',
  'document_resource_uri',
]);

function isKnownHookField(field: string, declared: Set<string>): boolean {
  return declared.has(field) || WELL_KNOWN_HOOK_FIELDS.has(field);
}

export { CONFIG_FILENAME };
