import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import * as z from 'zod/v4';
import { GRANITE_VERSION } from '../version.js';
import type { GraniteMcpRuntime, NoteRecommendations } from './runtime.js';

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const fieldDefinitionSchema = z.object({
  type: z.enum(['text', 'date', 'number', 'boolean', 'wikilink', 'list', 'enum']),
  of: z.string().optional(),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  default: z.string().optional(),
  description: z.string().optional(),
});

const noteTypeInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  folder: z.string(),
  line_limit: z.number(),
  warn_only: z.boolean(),
  slug_format: z.enum(['title', 'date']),
  instructions: z.string().optional(),
  fields: z.record(z.string(), fieldDefinitionSchema).optional(),
});

const noteSummarySchema = z.object({
  slug: z.string(),
  title: z.string(),
  type: z.string(),
  created: z.string(),
  modified: z.string(),
  tags: z.array(z.string()),
  aliases: z.array(z.string()),
  status: z.enum(['inbox', 'active', 'archived']),
  source: z.enum(['human', 'agent', 'extraction']),
  review_state: z.enum(['draft', 'reviewed', 'locked']),
  durability: z.enum(['canonical', 'working', 'ephemeral']),
  derived_from: z.array(z.string()),
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
    source: z.enum(['mention', 'search']),
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

const doctorIssueSchema = z.object({
  level: z.enum(['error', 'warning', 'info']),
  file: z.string(),
  message: z.string(),
});

const vaultOverviewSchema = z.object({
  vault_root: z.string(),
  vault_name: z.string(),
  default_type: z.string(),
  auto_rebuild: z.boolean(),
  index_last_rebuild: z.string().optional(),
  note_count: z.number(),
  notes_by_type: z.record(z.string(), z.number()),
  recent_notes: z.array(noteSummarySchema),
});

export interface GraniteMcpHttpServerOptions {
  host: string;
  port: number;
  allowedOrigins?: string[];
  jsonResponse?: boolean;
}

export function createGraniteMcpServer(runtime: GraniteMcpRuntime): McpServer {
  const server = new McpServer(
    {
      name: 'granite',
      version: GRANITE_VERSION,
      title: 'Granite MCP Server',
    },
    {
      capabilities: { logging: {} },
      instructions: [
        'Granite exposes a local-first markdown vault.',
        'Prefer read tools and resources first, then write with granite_create_note or granite_update_note.',
        'Resources are read-only views; notes live on disk and the SQLite index is derived state.',
        'Use granite_recommend_note_actions to preserve Granite’s capture -> link -> recommend loop.',
      ].join(' '),
    },
  );

  registerTools(server, runtime);
  registerResources(server, runtime);
  registerPrompts(server, runtime);

  return server;
}

export async function startGraniteMcpStdioServer(runtime: GraniteMcpRuntime): Promise<void> {
  const server = createGraniteMcpServer(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Granite MCP server listening on stdio for ${runtime.vaultRoot}`);
}

export function startGraniteMcpHttpServer(runtime: GraniteMcpRuntime, options: GraniteMcpHttpServerOptions): void {
  const app = createGraniteMcpHttpApp(runtime, options);

  console.error(`Granite MCP server listening on http://${options.host}:${options.port}/mcp`);
  console.error(`Health check: http://${options.host}:${options.port}/health`);
  console.error(`Vault: ${runtime.vaultRoot}`);

  serve({
    fetch: app.fetch,
    hostname: options.host,
    port: options.port,
  });
}

export async function withResponseCleanup(
  response: Response,
  cleanup: () => Promise<void> | void,
): Promise<Response> {
  let cleanedUp = false;

  const cleanupOnce = async () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    await cleanup();
  };

  if (!response.body) {
    await cleanupOnce();
    return response;
  }

  const reader = response.body.getReader();
  const wrappedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await cleanupOnce();
          return;
        }

        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        await cleanupOnce();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await cleanupOnce();
      }
    },
  });

  return new Response(wrappedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function registerTools(server: McpServer, runtime: GraniteMcpRuntime): void {
  server.registerTool('granite_get_vault_overview', {
    title: 'Granite Vault Overview',
    description: 'Summarize the current Granite vault, including counts by type and recent notes.',
    inputSchema: {
      recent_limit: z.number().int().min(1).max(20).optional().describe('How many recent notes to include. Defaults to 10.'),
    },
    outputSchema: vaultOverviewSchema,
    annotations: readOnlyAnnotations,
  }, async ({ recent_limit }) => {
    const overview = runtime.getVaultOverview(recent_limit ?? 10);
    return toolResult(
      overview,
      `Vault "${overview.vault_name}" with ${overview.note_count} notes.`,
    );
  });

  server.registerTool('granite_list_note_types', {
    title: 'Granite Note Types',
    description: 'List the note types configured in the vault.',
    outputSchema: z.object({
      default_type: z.string(),
      note_types: z.array(noteTypeInfoSchema),
    }),
    annotations: readOnlyAnnotations,
  }, async () => {
    const noteTypes = runtime.listNoteTypes();
    return toolResult({
      default_type: runtime.getDefaultNoteType(),
      note_types: noteTypes,
    }, `Loaded ${noteTypes.length} Granite note types.`);
  });

  server.registerTool('granite_list_notes', {
    title: 'List Granite Notes',
    description: 'List notes from the Granite vault with optional filters.',
    inputSchema: {
      type: z.string().optional().describe('Filter by note type.'),
      status: z.enum(['inbox', 'active', 'archived']).optional().describe('Filter by note status.'),
      source: z.enum(['human', 'agent', 'extraction']).optional().describe('Filter by note source.'),
      since: z.string().optional().describe('Only notes modified on or after this ISO or YYYY-MM-DD value.'),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum number of notes to return. Defaults to 25.'),
    },
    outputSchema: z.object({
      notes: z.array(noteSummarySchema),
      total: z.number(),
    }),
    annotations: readOnlyAnnotations,
  }, async (args) => {
    const notes = runtime.listNotes(args);
    return toolResult({
      notes,
      total: notes.length,
    }, `Returned ${notes.length} note(s).`);
  });

  server.registerTool('granite_get_note', {
    title: 'Get Granite Note',
    description: 'Read a Granite note by slug, including frontmatter, body, and resolved outgoing links.',
    inputSchema: {
      slug: z.string().describe('The note slug.'),
    },
    outputSchema: noteDetailsSchema,
    annotations: readOnlyAnnotations,
  }, async ({ slug }) => {
    const note = runtime.getNote(slug);
    return {
      ...toolResult(note, `Loaded "${note.title}" (${note.slug}).`),
      content: [
        { type: 'text', text: `Loaded "${note.title}" (${note.slug}).` },
        createNoteResourceLink(note.title, note.resource_uri),
      ],
    };
  });

  server.registerTool('granite_search_notes', {
    title: 'Search Granite Notes',
    description: 'Run full-text search against the Granite index.',
    inputSchema: {
      query: z.string().describe('Full-text query for the SQLite FTS index.'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum number of search results. Defaults to 10.'),
    },
    outputSchema: z.object({
      query: z.string(),
      results: z.array(searchResultSchema),
    }),
    annotations: readOnlyAnnotations,
  }, async ({ query, limit }) => {
    const results = runtime.search(query, limit ?? 10);
    return toolResult({
      query,
      results,
    }, `Found ${results.length} result(s) for "${query}".`);
  });

  server.registerTool('granite_create_note', {
    title: 'Create Granite Note',
    description: 'Create a new note in the Granite vault.',
    inputSchema: {
      title: z.string().describe('Note title.'),
      type: z.string().optional().describe('Note type. Defaults to the vault default type.'),
      body: z.string().optional().describe('Optional note body. If omitted, Granite uses the type template.'),
      tags: z.array(z.string()).optional().describe('Tags to add immediately.'),
      aliases: z.array(z.string()).optional().describe('Aliases to add immediately.'),
      status: z.enum(['inbox', 'active', 'archived']).optional().describe('Initial note status.'),
      source: z.enum(['human', 'agent', 'extraction']).optional().describe('Initial note source.'),
      review_state: z.enum(['draft', 'reviewed', 'locked']).optional().describe('Initial review state.'),
      durability: z.enum(['canonical', 'working', 'ephemeral']).optional().describe('Initial durability.'),
      derived_from: z.array(z.string()).optional().describe('Source note IDs or slugs this note derives from.'),
    },
    outputSchema: z.object({
      note: noteDetailsSchema,
      recommendations: recommendationSchema,
    }),
    annotations: writeAnnotations,
  }, async (args) => {
    const result = runtime.createNote(args);
    return toolResult(result, `Created "${result.note.title}" (${result.note.slug}).`);
  });

  server.registerTool('granite_capture_note', {
    title: 'Capture Granite Note',
    description: 'Quick-capture a note from free-form text, similar to granite add.',
    inputSchema: {
      text: z.string().describe('Raw capture text.'),
      type: z.string().optional().describe('Optional note type override. Defaults to the vault default type.'),
      tags: z.array(z.string()).optional().describe('Tags to add immediately.'),
      aliases: z.array(z.string()).optional().describe('Aliases to add immediately.'),
      status: z.enum(['inbox', 'active', 'archived']).optional().describe('Initial note status.'),
      source: z.enum(['human', 'agent', 'extraction']).optional().describe('Initial note source.'),
      review_state: z.enum(['draft', 'reviewed', 'locked']).optional().describe('Initial review state.'),
      durability: z.enum(['canonical', 'working', 'ephemeral']).optional().describe('Initial durability.'),
      derived_from: z.array(z.string()).optional().describe('Source note IDs or slugs this note derives from.'),
    },
    outputSchema: z.object({
      note: noteDetailsSchema,
      recommendations: recommendationSchema,
    }),
    annotations: writeAnnotations,
  }, async (args) => {
    const result = runtime.captureNote(args);
    return toolResult(result, `Captured "${result.note.title}" (${result.note.slug}).`);
  });

  server.registerTool('granite_update_note', {
    title: 'Update Granite Note',
    description: 'Update frontmatter or body fields for an existing Granite note.',
    inputSchema: {
      slug: z.string().describe('Slug of the note to update.'),
      title: z.string().optional().describe('Replace the note title.'),
      body: z.string().optional().describe('Replace the entire note body.'),
      append: z.string().optional().describe('Append text to the existing note body.'),
      tags: z.array(z.string()).optional().describe('Tags to add.'),
      aliases: z.array(z.string()).optional().describe('Aliases to add.'),
      status: z.enum(['inbox', 'active', 'archived']).optional().describe('New note status.'),
      source: z.enum(['human', 'agent', 'extraction']).optional().describe('New note source.'),
      review_state: z.enum(['draft', 'reviewed', 'locked']).optional().describe('New review state.'),
      durability: z.enum(['canonical', 'working', 'ephemeral']).optional().describe('New durability.'),
      derived_from: z.array(z.string()).optional().describe('Source note IDs or slugs this note derives from.'),
    },
    outputSchema: z.object({
      note: noteDetailsSchema,
      recommendations: recommendationSchema,
    }),
    annotations: writeAnnotations,
  }, async ({ slug, ...updates }) => {
    const result = runtime.updateNote(slug, updates);
    return toolResult(result, `Updated "${result.note.title}" (${result.note.slug}).`);
  });

  server.registerTool('granite_get_backlinks', {
    title: 'Granite Backlinks',
    description: 'List notes that link to a given Granite note.',
    inputSchema: {
      slug: z.string().describe('Slug of the target note.'),
    },
    outputSchema: z.object({
      slug: z.string(),
      backlinks: z.array(backlinkSchema),
    }),
    annotations: readOnlyAnnotations,
  }, async ({ slug }) => {
    const backlinks = runtime.getBacklinks(slug);
    return toolResult({
      slug,
      backlinks,
    }, `Found ${backlinks.length} backlink(s) for "${slug}".`);
  });

  server.registerTool('granite_suggest_links', {
    title: 'Suggest Granite Links',
    description: 'Suggest missing wikilinks for a Granite note based on mentions.',
    inputSchema: {
      slug: z.string().describe('Slug of the note to inspect.'),
    },
    outputSchema: z.object({
      slug: z.string(),
      suggestions: z.array(linkSuggestionSchema),
    }),
    annotations: readOnlyAnnotations,
  }, async ({ slug }) => {
    const suggestions = runtime.suggestLinks(slug);
    return toolResult({
      slug,
      suggestions,
    }, `Found ${suggestions.length} suggested link(s) for "${slug}".`);
  });

  server.registerTool('granite_recommend_note_actions', {
    title: 'Recommend Granite Actions',
    description: 'Recommend follow-up links, tags, additions, and next notes for a Granite note.',
    inputSchema: {
      slug: z.string().describe('Slug of the note to analyze.'),
    },
    outputSchema: z.object({
      slug: z.string(),
      recommendations: recommendationSchema,
    }),
    annotations: readOnlyAnnotations,
  }, async ({ slug }) => {
    const recommendations = runtime.recommend(slug);
    return toolResult({
      slug,
      recommendations,
    }, recommendationSummary(recommendations));
  });

  server.registerTool('granite_run_doctor', {
    title: 'Run Granite Doctor',
    description: 'Validate vault health and report structural issues.',
    outputSchema: z.object({
      issues: z.array(doctorIssueSchema),
      counts: z.object({
        errors: z.number(),
        warnings: z.number(),
        info: z.number(),
      }),
    }),
    annotations: readOnlyAnnotations,
  }, async () => {
    const result = runtime.runDoctor();
    return toolResult(
      result,
      `${result.counts.errors} error(s), ${result.counts.warnings} warning(s), ${result.counts.info} info item(s).`,
    );
  });
}

function registerResources(server: McpServer, runtime: GraniteMcpRuntime): void {
  server.registerResource('granite-vault-config', 'granite://vault/config', {
    title: 'Granite Config',
    description: 'Raw granite.yml configuration for the current vault.',
    mimeType: 'text/yaml',
  }, async () => ({
    contents: [{
      uri: 'granite://vault/config',
      text: runtime.readVaultConfigRaw(),
      mimeType: 'text/yaml',
    }],
  }));

  server.registerResource('granite-vault-overview', 'granite://vault/overview', {
    title: 'Granite Vault Overview',
    description: 'Structured summary of the current vault.',
    mimeType: 'application/json',
  }, async () => ({
    contents: [{
      uri: 'granite://vault/overview',
      text: runtime.readVaultOverviewJson(),
      mimeType: 'application/json',
    }],
  }));

  server.registerResource('granite-note-types', 'granite://vault/types', {
    title: 'Granite Note Types',
    description: 'Structured list of the note types configured in the current vault.',
    mimeType: 'application/json',
  }, async () => ({
    contents: [{
      uri: 'granite://vault/types',
      text: runtime.readVaultTypesJson(),
      mimeType: 'application/json',
    }],
  }));

  const noteTemplate = new ResourceTemplate('granite://notes/{slug}', {
    list: undefined,
    complete: {
      slug: async (value) => runtime.completeSlugs(value),
    },
  });

  server.registerResource('granite-note', noteTemplate, {
    title: 'Granite Note',
    description: 'Read a Granite note as markdown with YAML frontmatter.',
    mimeType: 'text/markdown',
  }, async (uri, variables) => {
    const variable = variables.slug;
    const slug = Array.isArray(variable) ? variable[0] : variable;
    if (!slug) {
      throw new Error('Resource URI is missing the note slug.');
    }

    return {
      contents: [{
        uri: uri.toString(),
        text: runtime.readNoteMarkdown(decodeURIComponent(slug)),
        mimeType: 'text/markdown',
      }],
    };
  });
}

function registerPrompts(server: McpServer, runtime: GraniteMcpRuntime): void {
  server.registerPrompt('granite_refine_note', {
    title: 'Refine Granite Note',
    description: 'Create a prompt for turning a note into a cleaner durable note draft.',
    argsSchema: {
      slug: z.string().describe('Slug of the note to refine.'),
    },
  }, async ({ slug }) => {
    const note = runtime.getNote(slug);

    return {
      description: `Refine ${note.slug} into a durable Granite note.`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Refine the attached Granite note into a durable, well-structured note.',
              'Keep the meaning intact, avoid inventing facts, preserve useful wikilinks, and use Granite-style headings when appropriate.',
            ].join(' '),
          },
        },
        {
          role: 'user',
          content: {
            type: 'resource',
            resource: {
              uri: note.resource_uri,
              text: runtime.readNoteMarkdown(slug),
              mimeType: 'text/markdown',
            },
          },
        },
      ],
    };
  });

  server.registerPrompt('granite_review_connections', {
    title: 'Review Granite Connections',
    description: 'Create a prompt for improving note links, tags, and next steps.',
    argsSchema: {
      slug: z.string().describe('Slug of the note to inspect.'),
    },
  }, async ({ slug }) => {
    const note = runtime.getNote(slug);
    const backlinks = runtime.getBacklinks(slug);
    const recommendations = runtime.recommend(slug);

    return {
      description: `Review the connections around ${note.slug}.`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Review this Granite note and propose better links, tags, and the most useful follow-up note.',
              'Prefer concrete suggestions grounded in the vault context below.',
            ].join(' '),
          },
        },
        {
          role: 'user',
          content: {
            type: 'resource',
            resource: {
              uri: note.resource_uri,
              text: runtime.readNoteMarkdown(slug),
              mimeType: 'text/markdown',
            },
          },
        },
        {
          role: 'user',
          content: {
            type: 'text',
            text: JSON.stringify({ backlinks, recommendations }, null, 2),
          },
        },
      ],
    };
  });
}

function toolResult<T>(structuredContent: T, summary: string) {
  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: asStructuredContent(structuredContent),
  };
}

function createNoteResourceLink(name: string, uri: string) {
  return {
    type: 'resource_link' as const,
    name,
    uri,
    mimeType: 'text/markdown',
    description: 'Read the markdown resource for this note.',
  };
}

function recommendationSummary(recommendations: NoteRecommendations): string {
  return [
    `${recommendations.links.length} link suggestion(s)`,
    `${recommendations.tags.length} tag suggestion(s)`,
    `${recommendations.next_steps.length} next-step suggestion(s)`,
  ].join(', ');
}

function asStructuredContent<T>(value: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function createGraniteMcpHttpApp(runtime: GraniteMcpRuntime, options: GraniteMcpHttpServerOptions): Hono {
  const app = new Hono();
  const allowedHosts = buildAllowedHosts(options.host, options.port);
  const allowedOrigins = buildAllowedOrigins(options.host, options.port, options.allowedOrigins ?? []);

  app.use('/mcp', async (c, next) => {
    const requestHost = (c.req.header('host') ?? '').toLowerCase();
    if (allowedHosts.size > 0 && !allowedHosts.has(requestHost)) {
      return c.json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Forbidden host header.' },
        id: null,
      }, 403);
    }

    const origin = c.req.header('origin');
    if (origin && !allowedOrigins.has(origin)) {
      return c.json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Forbidden origin.' },
        id: null,
      }, 403);
    }

    if (c.req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, allowedOrigins),
      });
    }

    await next();
  });

  app.get('/health', c => c.json({ status: 'ok', name: 'granite-mcp', version: GRANITE_VERSION }));

  app.all('/mcp', async (c) => {
    const origin = c.req.header('origin');
    const server = createGraniteMcpServer(runtime);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: options.jsonResponse ?? false,
    });

    try {
      await server.connect(transport);
      const response = await transport.handleRequest(c.req.raw);
      const managedResponse = await withResponseCleanup(response, async () => {
        await server.close();
      });
      return withCors(managedResponse, origin, allowedOrigins);
    } catch (error) {
      await server.close();
      throw error;
    }
  });

  return app;
}

function buildAllowedHosts(host: string, port: number): Set<string> {
  const normalizedHost = host.toLowerCase();
  if (normalizedHost === '0.0.0.0' || normalizedHost === '::' || normalizedHost === '[::]') {
    return new Set<string>();
  }

  const allowed = new Set<string>([`${normalizedHost}:${port}`]);

  if (normalizedHost === '127.0.0.1' || normalizedHost === 'localhost') {
    allowed.add(`127.0.0.1:${port}`);
    allowed.add(`localhost:${port}`);
  }

  if (normalizedHost === '::1' || normalizedHost === '[::1]') {
    allowed.add(`[::1]:${port}`);
  }

  return allowed;
}

function buildAllowedOrigins(host: string, port: number, extraOrigins: string[]): Set<string> {
  const allowed = new Set<string>(extraOrigins);
  const normalizedHost = host.toLowerCase();

  if (normalizedHost === '::1' || normalizedHost === '[::1]') {
    allowed.add(`http://[::1]:${port}`);
  } else if (normalizedHost !== '0.0.0.0' && normalizedHost !== '::' && normalizedHost !== '[::]') {
    allowed.add(`http://${normalizedHost}:${port}`);
  }

  if (normalizedHost === '127.0.0.1' || normalizedHost === 'localhost') {
    allowed.add(`http://127.0.0.1:${port}`);
    allowed.add(`http://localhost:${port}`);
  }

  return allowed;
}

function withCors(response: Response, origin: string | undefined, allowedOrigins: Set<string>): Response {
  const headers = new Headers(response.headers);

  for (const [key, value] of corsHeaders(origin, allowedOrigins)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsHeaders(origin: string | undefined, allowedOrigins: Set<string>): Headers {
  const headers = new Headers();
  if (origin && allowedOrigins.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, MCP-Protocol-Version, Last-Event-ID');
    headers.set('Access-Control-Expose-Headers', 'MCP-Session-Id, MCP-Protocol-Version');
    headers.set('Vary', 'Origin');
  }
  return headers;
}
