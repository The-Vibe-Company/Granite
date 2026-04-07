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
        '# Granite — Knowledge Compilation System',
        '',
        'You are operating a local-first markdown knowledge base. You are the primary writer and gardener of this vault — the human rarely edits notes directly.',
        '',
        '## Core Loop',
        '',
        'Granite follows a continuous knowledge compilation loop:',
        '',
        '1. **Capture** — Ingest raw information quickly (granite_capture_note or granite_create_note). Don\'t over-structure at this stage.',
        '2. **Compile** — Turn raw captures and sources into durable, linked notes and syntheses. Use granite_recommend_note_actions to find what to connect.',
        '3. **Query** — Search and traverse the vault (granite_search_notes, granite_get_backlinks, granite_suggest_links) to answer questions by researching across notes.',
        '4. **Output** — Generate audience-specific deliverables (type: output) that derive from durable notes. Always set derived_from.',
        '5. **Lint** — Run granite_run_doctor and granite_recommend_note_actions regularly to find gaps, broken links, and opportunities to strengthen the vault.',
        '',
        'Every interaction should advance the vault. Queries become notes. Outputs feed back in. Knowledge compounds.',
        '',
        '## Note Types',
        '',
        '- **note**: Atomic, durable ideas — one idea per note, well-linked. The backbone of the vault.',
        '- **source**: Imported material kept close to the original. Capture provenance, summarize essentials.',
        '- **synthesis**: Compiled knowledge connecting multiple notes or sources. The most valuable type.',
        '- **output**: Situational deliverables (reports, briefs). Ephemeral by default, always derived_from something durable.',
        '',
        'The natural flow is: source → note → synthesis → output',
        '',
        '## Working Principles',
        '',
        '- **Read before writing.** Use granite_search_notes and granite_list_notes to understand what already exists before creating new notes. Avoid duplicates.',
        '- **Link aggressively.** Use [[wikilinks]] in note bodies. After writing, check granite_suggest_links to find missed connections.',
        '- **Act on recommendations.** Every create/update returns recommendations — follow them. They are the compiler\'s suggestions for what to connect or write next.',
        '- **Use the right type.** Don\'t dump everything into notes. Sources stay as sources. Syntheses emerge when you have enough connected notes.',
        '- **Set metadata intentionally.** Use source: agent when you write, source: human when the human dictates. Use review_state: draft for first passes. Set durability to match the note\'s role.',
        '- **Prefer read tools and resources first.** Resources (granite://vault/overview, granite://notes/{slug}) are lightweight reads. Use tools for writes and complex queries.',
      ].join('\n'),
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
    description: 'Start here. Get a snapshot of the vault: note counts by type, recent activity, and configuration. Use this to orient yourself before reading or writing notes.',
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
    description: 'List the note types configured in the vault, including their templates, line limits, and instructions. Check this before creating a note to use the right type.',
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
    description: 'Browse the vault with filters. Use this to find existing notes before creating new ones (avoid duplicates), to review inbox notes that need processing, or to find notes by type/status/source.',
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
    description: 'Read a note in full: frontmatter, body, and resolved outgoing wikilinks. Use this to understand a note before updating it, to follow links in the knowledge graph, or to gather context for a synthesis.',
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
    description: 'Full-text search across all notes. Use this to research a topic before answering questions, to find related notes before creating a new one, or to discover connections across the vault.',
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
    description: 'Create a structured note. Use this when you have a clear title and know the type. For raw captures, prefer granite_capture_note instead. Always search first to avoid duplicates. Returns recommendations — act on them to strengthen the vault.',
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
    return toolResult(result, buildWriteSummary('Created', result, runtime));
  });

  server.registerTool('granite_capture_note', {
    title: 'Capture Granite Note',
    description: 'Quick-capture from raw text — the fastest way to get information into the vault. The title is auto-generated. Use this for rapid ingestion (conversations, ideas, observations). The note lands in inbox status, ready to be refined later. Returns recommendations for immediate linking.',
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
    return toolResult(result, buildWriteSummary('Captured', result, runtime));
  });

  server.registerTool('granite_update_note', {
    title: 'Update Granite Note',
    description: 'Update an existing note. Use this to refine captures into durable notes, add tags and links, change status (inbox→active→archived), append new information, or promote review_state. Use append to add without replacing the body.',
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
    return toolResult(result, buildWriteSummary('Updated', result, runtime));
  });

  server.registerTool('granite_get_backlinks', {
    title: 'Granite Backlinks',
    description: 'Find all notes that link to a given note. Use this to understand a note\'s role in the knowledge graph, to find context for a synthesis, or to check the impact before modifying a note.',
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
    description: 'Find unlinked mentions — places where a note references another note\'s title or alias without a [[wikilink]]. Use this after creating or updating a note to strengthen the knowledge graph.',
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
    description: 'The heart of Granite\'s compile loop. Returns suggested links, tags, content additions, and next notes to create. Call this after every write operation and act on the results — this is how the vault grows into a connected knowledge base instead of a pile of files.',
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

  server.registerTool('granite_attach', {
    title: 'Attach File to Vault',
    description: 'Copy an image, screenshot, video, or PDF into the vault assets folder and get markdown embed syntax. Use this when you need to attach a visual to a note. Returns the markdown syntax to paste into a note body.',
    inputSchema: {
      file_path: z.string().describe('Absolute path to the file to attach'),
      slug: z.string().optional().describe('Optional note slug to suggest appending the image to'),
    },
    outputSchema: z.object({
      file: z.string(),
      path: z.string(),
      markdown: z.string(),
      slug: z.string().nullable(),
    }),
    annotations: writeAnnotations,
  }, async ({ file_path, slug }) => {
    const result = runtime.attach(file_path, slug);
    return toolResult(
      result,
      `Attached ${result.file}. Embed with: ${result.markdown}`,
    );
  });

  server.registerTool('granite_wakeup', {
    title: 'Granite Wakeup',
    description: 'Load a compressed AAAK snapshot of the entire vault into context. Call this at the start of every session to know what exists, how notes cluster, and what changed recently. Costs ~200-500 tokens instead of reading every note.',
    outputSchema: z.object({
      total: z.number(),
      by_type: z.record(z.string(), z.number()),
      modified: z.string(),
      clusters: z.array(z.object({
        tag: z.string(),
        slugs: z.array(z.string()),
        hub: z.string().nullable(),
      })),
      people: z.array(z.object({ slug: z.string(), title: z.string() })),
      recent: z.array(z.object({ slug: z.string(), age: z.string() })),
      stale: z.array(z.object({ slug: z.string(), reason: z.string() })),
      aaak: z.string(),
    }),
    annotations: readOnlyAnnotations,
  }, async () => {
    const result = runtime.wakeup();
    return toolResult(
      result,
      result.aaak,
    );
  });

  server.registerTool('granite_run_doctor', {
    title: 'Run Granite Doctor',
    description: 'Lint the vault. Finds broken wikilinks, missing frontmatter fields, notes exceeding line limits, and other structural issues. Run this periodically to maintain vault integrity — part of the lint phase of the knowledge loop.',
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
    description: 'Turn a raw capture or draft into a durable, well-structured note. Use this on inbox notes to promote them to active status.',
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
    description: 'Analyze a note\'s place in the knowledge graph and propose better links, tags, and the most valuable follow-up note to create.',
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

  server.registerPrompt('granite_process_inbox', {
    title: 'Process Granite Inbox',
    description: 'Review all inbox notes and decide what to do with each: refine into a durable note, merge into an existing note, archive, or delete. This is the compile phase of the knowledge loop.',
  }, async () => {
    const inboxNotes = runtime.listNotes({ status: 'inbox', limit: 50 });
    const overview = runtime.getVaultOverview(5);

    return {
      description: 'Process the inbox: triage, refine, and compile captured notes.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Process the Granite inbox. For each inbox note below, decide:',
              '',
              '1. **Refine** — If it contains a durable idea, refine it into a well-structured note (update body, set status: active, review_state: reviewed).',
              '2. **Merge** — If it overlaps with an existing note, append the new information to that note and archive the inbox note.',
              '3. **Promote to source** — If it\'s raw reference material, update its type to source and refine it.',
              '4. **Archive** — If it\'s been processed or is no longer relevant, set status: archived.',
              '',
              'After processing each note, run granite_suggest_links to find connections, and granite_recommend_note_actions to see what to write next.',
              '',
              `Vault context: ${overview.note_count} notes total (${Object.entries(overview.notes_by_type).map(([t, c]) => `${c} ${t}s`).join(', ')}).`,
              '',
              `Inbox notes to process (${inboxNotes.length}):`,
              '',
              ...inboxNotes.map(n => `- **${n.slug}**: "${n.title}" (type: ${n.type}, created: ${n.created})`),
            ].join('\n'),
          },
        },
      ],
    };
  });

  server.registerPrompt('granite_compile_synthesis', {
    title: 'Compile Granite Synthesis',
    description: 'Analyze a set of related notes and compile them into a synthesis note — the most valuable operation in the knowledge loop. Creates durable compiled knowledge from scattered notes.',
    argsSchema: {
      topic: z.string().describe('The topic or theme to synthesize notes around.'),
    },
  }, async ({ topic }) => {
    const searchResults = runtime.search(topic, 20);
    const noteDetails = searchResults.map(r => {
      try { return runtime.getNote(r.slug); } catch { return null; }
    }).filter(Boolean);

    return {
      description: `Compile a synthesis on "${topic}" from ${noteDetails.length} related notes.`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Compile a synthesis note on "${topic}" from the related notes below.`,
              '',
              'A good synthesis:',
              '- Connects ideas across multiple sources and notes',
              '- Identifies patterns, tensions, and open questions',
              '- Uses [[wikilinks]] to link back to every source note',
              '- Sets derived_from to the slugs of the notes it draws from',
              '- Is more valuable than any individual note because it creates new understanding',
              '',
              'Steps:',
              '1. Read the related notes below',
              '2. Create a synthesis note (type: synthesis) with granite_create_note',
              '3. Write a body that connects the key ideas, with [[wikilinks]] to sources',
              '4. Set derived_from to the source note slugs',
              '5. Run granite_recommend_note_actions on the new synthesis',
              '',
              `Related notes (${noteDetails.length} found for "${topic}"):`,
              '',
              ...noteDetails.map(n => n ? [
                `### ${n.title} (${n.slug}, type: ${n.type})`,
                n.body.slice(0, 500) + (n.body.length > 500 ? '...' : ''),
                '',
              ].join('\n') : ''),
            ].join('\n'),
          },
        },
      ],
    };
  });

  server.registerPrompt('granite_vault_health_review', {
    title: 'Granite Vault Health Review',
    description: 'Run a comprehensive vault review: structural health, content gaps, orphan notes, and suggestions for strengthening the knowledge graph. The lint phase of the knowledge loop.',
  }, async () => {
    const doctorResult = runtime.runDoctor();
    const overview = runtime.getVaultOverview(10);
    const notes = runtime.listNotes({ limit: 200 });

    // Find notes with no backlinks (potential orphans)
    const orphanCandidates: string[] = [];
    for (const note of notes.slice(0, 50)) {
      const backlinks = runtime.getBacklinks(note.slug);
      if (backlinks.length === 0) {
        orphanCandidates.push(`${note.slug} ("${note.title}", type: ${note.type})`);
      }
    }

    return {
      description: 'Comprehensive vault health review.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Run a comprehensive health review of this Granite vault and take action to improve it.',
              '',
              '## Structural Issues (from granite_run_doctor)',
              '',
              doctorResult.issues.length === 0
                ? 'No structural issues found.'
                : doctorResult.issues.map(i => `- [${i.level}] ${i.file}: ${i.message}`).join('\n'),
              '',
              '## Vault Overview',
              '',
              `${overview.note_count} notes: ${Object.entries(overview.notes_by_type).map(([t, c]) => `${c} ${t}s`).join(', ')}`,
              '',
              '## Orphan Notes (no backlinks)',
              '',
              orphanCandidates.length === 0
                ? 'No orphans found in the first 50 notes.'
                : orphanCandidates.map(o => `- ${o}`).join('\n'),
              '',
              '## Actions to Take',
              '',
              '1. Fix any structural errors reported by doctor',
              '2. For each orphan note, use granite_suggest_links and granite_recommend_note_actions to find connections',
              '3. If orphan notes should be linked from other notes, update those notes to add [[wikilinks]]',
              '4. Look for clusters of notes that could be compiled into a synthesis',
              '5. Check if any inbox notes need processing',
              '6. Report a summary of what you found and what you fixed',
            ].join('\n'),
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

function buildWriteSummary(verb: string, result: { note: { title: string; slug: string; type: string }; recommendations: NoteRecommendations }, runtime: GraniteMcpRuntime): string {
  const lines = [`${verb} "${result.note.title}" (${result.note.slug}).`];

  const instructions = runtime.getTypeInstructions(result.note.type);
  if (instructions) {
    lines.push('', `Type guidance for "${result.note.type}": ${instructions}`);
  }

  const recSummary = recommendationSummary(result.recommendations);
  if (recSummary) {
    lines.push('', `Recommendations: ${recSummary}. Act on these to strengthen the vault.`);
  }

  return lines.join('\n');
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
