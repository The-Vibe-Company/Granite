import type { Context } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import * as z from 'zod/v4';
import {
  renderBacklinksMarkdown,
  renderLinkSuggestionsMarkdown,
  renderMutationResultMarkdown,
  renderNoteDetailsMarkdown,
  renderNotesMarkdown,
  renderNoteTypesMarkdown,
  renderSearchResultsMarkdown,
  renderVaultOverviewMarkdown,
} from '../../../../shared/mcp-markdown.js';
import type { Env, Tier } from '../env.js';
import { TIER_LIMITS } from '../env.js';
import { R2NoteStorage } from '../storage/r2.js';
import { D1IndexDatabase } from '../storage/d1.js';
import { CloudMcpRuntime } from '../runtime.js';

const noteSummarySchema = z.object({
  slug: z.string(),
  title: z.string(),
  type: z.string(),
  created: z.string(),
  modified: z.string(),
  tags: z.array(z.string()),
  aliases: z.array(z.string()),
  status: z.string(),
  source: z.string(),
  filepath: z.string(),
  resource_uri: z.string(),
});

const wikiLinkSchema = z.object({
  raw: z.string(),
  target: z.string(),
  display: z.string(),
  resolved: z.boolean(),
  resolved_slug: z.string().optional(),
});

const noteDetailsSchema = noteSummarySchema.extend({
  body: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  outgoing_links: z.array(wikiLinkSchema),
});

const searchResultSchema = z.object({
  slug: z.string(),
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
});

const backlinkSchema = z.object({
  source_slug: z.string(),
  source_title: z.string(),
  context: z.string(),
});

const linkSuggestionSchema = z.object({
  target_slug: z.string(),
  target_title: z.string(),
  mentions: z.number(),
});

const recommendationSchema = z.object({
  additions: z.array(z.object({ text: z.string() })),
  links: z.array(z.object({
    slug: z.string(),
    title: z.string(),
    type: z.string(),
    reason: z.string(),
    source: z.string(),
  })),
  tags: z.array(z.object({
    tag: z.string(),
    weight: z.number(),
    source_slugs: z.array(z.string()),
  })),
  next_steps: z.array(z.object({
    type: z.string(),
    title_hint: z.string().optional(),
    reason: z.string(),
  })),
});

const noteMutationSchema = z.object({
  note: noteDetailsSchema,
  recommendations: recommendationSchema,
});

const noteTypeSchema = z.object({
  name: z.string(),
  description: z.string(),
  folder: z.string(),
  slug_format: z.string(),
  instructions: z.string().optional(),
});

const vaultOverviewSchema = z.object({
  vault_name: z.string(),
  default_type: z.string(),
  note_count: z.number(),
  notes_by_type: z.record(z.string(), z.number()),
  recent_notes: z.array(noteSummarySchema),
});

const noteTypesResultSchema = z.object({
  note_types: z.array(noteTypeSchema),
});

const listNotesResultSchema = z.object({
  notes: z.array(noteSummarySchema),
});

const searchResultSetSchema = z.object({
  query: z.string(),
  results: z.array(searchResultSchema),
});

const backlinksResultSchema = z.object({
  slug: z.string(),
  backlinks: z.array(backlinkSchema),
});

const linkSuggestionsResultSchema = z.object({
  slug: z.string(),
  suggestions: z.array(linkSuggestionSchema),
});

export interface WorkerMcpRuntime {
  getVaultOverview(recentLimit?: number): Promise<z.infer<typeof vaultOverviewSchema>>;
  listNoteTypes(): Promise<Array<z.infer<typeof noteTypeSchema>>>;
  listNotes(input?: {
    type?: string;
    status?: string;
    source?: string;
    since?: string;
    limit?: number;
  }): Promise<Array<z.infer<typeof noteSummarySchema>>>;
  getNote(slug: string): Promise<z.infer<typeof noteDetailsSchema>>;
  search(query: string, limit?: number): Promise<Array<z.infer<typeof searchResultSchema>>>;
  getBacklinks(slug: string): Promise<Array<z.infer<typeof backlinkSchema>>>;
  suggestLinks(slug: string): Promise<Array<z.infer<typeof linkSuggestionSchema>>>;
  createNote(input: {
    title: string;
    type?: string;
    body?: string;
    tags?: string[];
    aliases?: string[];
    status?: string;
    source?: string;
  }): Promise<z.infer<typeof noteMutationSchema>>;
  captureNote(input: {
    text: string;
    type?: string;
    tags?: string[];
    status?: string;
    source?: string;
  }): Promise<z.infer<typeof noteMutationSchema>>;
  updateNote(slug: string, input: {
    title?: string;
    body?: string;
    append?: string;
    tags?: string[];
    aliases?: string[];
    status?: string;
    source?: string;
  }): Promise<z.infer<typeof noteMutationSchema>>;
  readVaultConfigRaw(): Promise<string>;
}

function getVaultId(c: Context<{ Bindings: Env }>): string {
  return c.get('vaultId') as string;
}

function createRuntime(c: Context<{ Bindings: Env }>): CloudMcpRuntime {
  const vaultId = getVaultId(c);
  const tier: Tier = c.get('tier');
  const storage = new R2NoteStorage(c.env.VAULT_BUCKET, vaultId);
  const db = new D1IndexDatabase(c.env.DB, vaultId);
  return new CloudMcpRuntime(storage, db, TIER_LIMITS[tier].maxStorageBytes);
}

function toolResult(markdown: string) {
  return {
    content: [{ type: 'text' as const, text: markdown }],
  };
}

export function createMcpServer(runtime: WorkerMcpRuntime): McpServer {
  const server = new McpServer({
    name: 'granite-cloud',
    version: '0.1.0',
  });

  server.registerTool('granite_get_vault_overview', {
    title: 'Get Granite Vault Overview',
    description: 'Get a summary of the vault.',
    inputSchema: {
      recent_limit: z.number().optional(),
    },
  }, async ({ recent_limit }) => {
    const overview = await runtime.getVaultOverview(recent_limit);
    return toolResult(renderVaultOverviewMarkdown(overview));
  });

  server.registerTool('granite_list_note_types', {
    title: 'List Granite Note Types',
    description: 'List all configured note types.',
  }, async () => {
    const types = await runtime.listNoteTypes();
    return toolResult(renderNoteTypesMarkdown(types));
  });

  server.registerTool('granite_list_notes', {
    title: 'List Granite Notes',
    description: 'List notes with optional filters.',
    inputSchema: {
      type: z.string().optional(),
      status: z.enum(['inbox', 'active', 'archived']).optional(),
      source: z.enum(['human', 'agent', 'extraction']).optional(),
      since: z.string().optional(),
      limit: z.number().optional(),
    },
  }, async (input) => {
    const notes = await runtime.listNotes(input);
    return toolResult(renderNotesMarkdown(notes));
  });

  server.registerTool('granite_get_note', {
    title: 'Get Granite Note',
    description: 'Get a note by slug with full details.',
    inputSchema: {
      slug: z.string(),
    },
  }, async ({ slug }) => {
    const note = await runtime.getNote(slug);
    return toolResult(renderNoteDetailsMarkdown(note));
  });

  server.registerTool('granite_search_notes', {
    title: 'Search Granite Notes',
    description: 'Full-text search across notes.',
    inputSchema: {
      query: z.string(),
      limit: z.number().optional(),
    },
  }, async ({ query, limit }) => {
    const results = await runtime.search(query, limit);
    return toolResult(renderSearchResultsMarkdown(query, results));
  });

  server.registerTool('granite_get_backlinks', {
    title: 'Get Granite Backlinks',
    description: 'Get notes that link to a given note.',
    inputSchema: {
      slug: z.string(),
    },
  }, async ({ slug }) => {
    const backlinks = await runtime.getBacklinks(slug);
    return toolResult(renderBacklinksMarkdown(slug, backlinks));
  });

  server.registerTool('granite_suggest_links', {
    title: 'Suggest Granite Links',
    description: 'Suggest wikilinks based on unlinked mentions.',
    inputSchema: {
      slug: z.string(),
    },
  }, async ({ slug }) => {
    const suggestions = await runtime.suggestLinks(slug);
    return toolResult(renderLinkSuggestionsMarkdown(slug, suggestions));
  });

  server.registerTool('granite_create_note', {
    title: 'Create Granite Note',
    description: 'Create a new note.',
    inputSchema: {
      title: z.string(),
      type: z.string().optional(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
      aliases: z.array(z.string()).optional(),
      status: z.enum(['inbox', 'active', 'archived']).optional(),
      source: z.enum(['human', 'agent', 'extraction']).optional(),
    },
  }, async (input) => {
    const result = await runtime.createNote(input);
    return toolResult(renderMutationResultMarkdown('Created', result.note, result.recommendations));
  });

  server.registerTool('granite_capture_note', {
    title: 'Capture Granite Note',
    description: 'Quick-capture a note from free-form text.',
    inputSchema: {
      text: z.string(),
      type: z.string().optional(),
      tags: z.array(z.string()).optional(),
      status: z.enum(['inbox', 'active', 'archived']).optional(),
      source: z.enum(['human', 'agent', 'extraction']).optional(),
    },
  }, async (input) => {
    const result = await runtime.captureNote(input);
    return toolResult(renderMutationResultMarkdown('Captured', result.note, result.recommendations));
  });

  server.registerTool('granite_update_note', {
    title: 'Update Granite Note',
    description: 'Update an existing note.',
    inputSchema: {
      slug: z.string(),
      title: z.string().optional(),
      body: z.string().optional(),
      append: z.string().optional(),
      tags: z.array(z.string()).optional(),
      aliases: z.array(z.string()).optional(),
      status: z.enum(['inbox', 'active', 'archived']).optional(),
      source: z.enum(['human', 'agent', 'extraction']).optional(),
    },
  }, async ({ slug, ...input }) => {
    const result = await runtime.updateNote(slug, input);
    return toolResult(renderMutationResultMarkdown('Updated', result.note, result.recommendations));
  });

  server.resource(
    'vault-config',
    'granite://vault/config',
    async (uri) => {
      const config = await runtime.readVaultConfigRaw();
      return { contents: [{ uri: uri.href, mimeType: 'text/yaml', text: config }] };
    },
  );

  server.resource(
    'vault-overview',
    'granite://vault/overview',
    {
      title: 'Granite Vault Overview',
      description: 'Read a compact markdown overview of the vault.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const overview = await runtime.getVaultOverview();
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'text/markdown',
          text: renderVaultOverviewMarkdown(overview),
        }],
      };
    },
  );

  return server;
}

export async function handleMcp(c: Context<{ Bindings: Env }>) {
  const runtime = createRuntime(c);
  const server = createMcpServer(runtime);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);

  const response = await transport.handleRequest(c.req.raw);

  if (response) {
    const headers = new Headers(response.headers);
    const origin = c.req.header('Origin');
    if (origin) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version, Last-Event-ID');
      headers.set('Access-Control-Expose-Headers', 'MCP-Session-Id, MCP-Protocol-Version');
    }

    return new Response(response.body, {
      status: response.status,
      headers,
    });
  }

  return c.json({ error: 'No response from MCP server' }, 500);
}
