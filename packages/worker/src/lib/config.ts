/**
 * Default note type → folder mapping shared between sync handlers and MCP runtime.
 * These match the defaults in the main Granite CLI config (src/core/config.ts).
 */
export const DEFAULT_TYPE_FOLDERS: Record<string, string> = {
  note: 'notes/notes',
  source: 'notes/sources',
  synthesis: 'notes/syntheses',
  output: 'notes/outputs',
};

/**
 * Resolve the folder for a given note type. Uses config-provided folder
 * if available, then the default mapping, then falls back to `notes/${type}`.
 */
export function resolveTypeFolder(type: string, configFolder?: string): string {
  return configFolder ?? DEFAULT_TYPE_FOLDERS[type] ?? `notes/${type}`;
}
