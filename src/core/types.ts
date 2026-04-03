export type NoteStatus = 'inbox' | 'active' | 'archived';
export type NoteSource = 'human' | 'agent' | 'extraction';
export type ReviewState = 'draft' | 'reviewed' | 'locked';
export type Durability = 'canonical' | 'working' | 'ephemeral';

export interface NoteFrontmatterDefaults {
  status?: NoteStatus;
  source?: NoteSource;
  review_state?: ReviewState;
  durability?: Durability;
  derived_from?: string[];
}

export interface NoteTypeConfig {
  folder: string;
  description: string;
  template: string;
  line_limit: number;
  warn_only: boolean;
  instructions?: string;
  slug_format?: 'title' | 'date';
  fields?: Record<string, FieldDefinition>;
  frontmatter_defaults?: NoteFrontmatterDefaults;
}

export interface FieldDefinition {
  type: 'text' | 'date' | 'number' | 'boolean' | 'wikilink' | 'list' | 'enum';
  of?: string;
  options?: string[];
  required?: boolean;
  default?: string;
  description?: string;
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
}

export interface NoteFrontmatter {
  id: string;
  title: string;
  type: string;
  created: string;
  modified: string;
  tags: string[];
  aliases: string[];
  status: NoteStatus;
  source: NoteSource;
  review_state: ReviewState;
  durability: Durability;
  derived_from: string[];
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

