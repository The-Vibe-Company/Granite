/**
 * Default note type → folder mapping shared between sync handlers and MCP runtime.
 * These match the defaults in the main Granite CLI config (src/core/config.ts).
 */
export const DEFAULT_TYPE_FOLDERS: Record<string, string> = {
  fleeting: 'notes/fleeting',
  permanent: 'notes/permanent',
  reference: 'notes/reference',
  person: 'notes/people',
  meeting: 'notes/meetings',
  project: 'notes/projects',
  decision: 'notes/decisions',
};

/**
 * Resolve the folder for a given note type. Uses config-provided folder
 * if available, then the default mapping, then falls back to `notes/${type}`.
 */
export function resolveTypeFolder(type: string, configFolder?: string): string {
  return configFolder ?? DEFAULT_TYPE_FOLDERS[type] ?? `notes/${type}`;
}
