export interface NoteTypeConfig {
  folder: string;
  description: string;
  template: string;
  line_limit: number;
  warn_only: boolean;
  instructions?: string;
  slug_format?: 'title' | 'date';
  fields?: Record<string, FieldDefinition>;
}

export interface FieldDefinition {
  type: 'text' | 'date' | 'number' | 'boolean' | 'wikilink' | 'list' | 'enum';
  of?: string;
  options?: string[];
  required?: boolean;
  default?: string;
  description?: string;
}

export interface SyncConfig {
  enabled: boolean;
  server: string;
  api_key: string;
  device_name: string;
  auto_sync: boolean;
  interval: number;
}

export interface GraniteConfig {
  vault_name: string;
  version: number;
  note_types: Record<string, NoteTypeConfig>;
  defaults: {
    note_type: string;
    editor: string;
  };
  index: {
    auto_rebuild: boolean;
  };
  sync?: SyncConfig;
}

export interface NoteFrontmatter {
  id: string;
  title: string;
  type: string;
  created: string;
  modified: string;
  tags: string[];
  aliases: string[];
  status: 'inbox' | 'active' | 'archived';
  source: 'human' | 'agent' | 'extraction';
  [key: string]: unknown;
}

export interface Note {
  slug: string;
  filepath: string;
  frontmatter: NoteFrontmatter;
  body: string;
  outgoing_links: WikiLink[];
}

export interface WikiLink {
  raw: string;
  target: string;
  display: string;
  resolved: boolean;
  resolved_slug?: string;
}

export interface SearchResult {
  slug: string;
  title: string;
  snippet: string;
  score: number;
}

export interface BacklinkEntry {
  source_slug: string;
  source_title: string;
  context: string;
}

export interface DoctorIssue {
  level: 'error' | 'warning' | 'info';
  file: string;
  message: string;
}

// --- Sync types ---

export type SyncOperation = 'create' | 'update' | 'delete' | 'rename';

export interface ChangelogEntry {
  seq: number;
  note_id: string;
  operation: SyncOperation;
  timestamp: string;
  device_id: string;
  checksum: string;
  synced: boolean;
}

export interface SyncPushPayload {
  device_id: string;
  last_server_seq: number;
  changes: SyncChange[];
}

export interface SyncChange {
  note_id: string;
  operation: SyncOperation;
  timestamp: string;
  checksum: string;
  slug: string;
  frontmatter?: NoteFrontmatter;
  body?: string;
}

export interface SyncPullResponse {
  changes: SyncChange[];
  server_seq: number;
}

export interface SyncStatus {
  device_id: string;
  device_name: string;
  last_sync: string | null;
  pending_changes: number;
  server_seq: number;
}

export interface SyncConflict {
  note_id: string;
  local_modified: string;
  remote_modified: string;
  resolved: boolean;
  conflict_file: string;
}
