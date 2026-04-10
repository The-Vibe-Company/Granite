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

const importedDocumentAssetSchema = z.object({
  file: z.string(),
  path: z.string(),
  relative_path: z.string(),
  markdown: z.string(),
  mime_type: z.string(),
  sha256: z.string(),
  resource_uri: z.string(),
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

const graphRoleSchema = z.object({
  role: z.enum(['hub', 'bridge', 'reference', 'isolated', 'draft', 'synthesis']),
  reason: z.string(),
  inbound_links: z.number(),
  outbound_links: z.number(),
  total_connections: z.number(),
});

const noteUnderstandingSchema = z.object({
  note: noteDetailsSchema,
  backlinks: z.array(backlinkSchema),
  link_suggestions: z.array(linkSuggestionSchema),
  recommendations: recommendationSchema,
  graph_role: graphRoleSchema,
});

const disposeNoteSchema = z.object({
  slug: z.string(),
  mode: z.enum(['archive', 'delete']),
  backlinks_removed: z.number(),
  derived_children: z.number(),
  note: noteDetailsSchema.nullable(),
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
        '## Public Interface',
        '',
        'Granite exposes a small public MCP surface:',
        '',
        '- **granite_wakeup** — load the map of the vault before doing work',
        '- **granite_research_topic** — discover relevant notes for a topic',
        '- **granite_capture_knowledge** — capture new knowledge into the vault',
        '- **granite_import_document** — attach a file and create a linked source note with caller-provided content',
        '- **granite_understand_note** — inspect a note in context, not in isolation',
        '- **granite_revise_note** — make targeted edits when workflow prompts are insufficient',
        '- **granite_dispose_note** — archive by default, delete only when intentional',
        '',
        'Use prompts for the higher-level workflows: refine notes, compile topics, process the inbox, and garden the vault.',
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
        '- **Read in context.** Prefer granite_understand_note over piecing together note, backlinks, and suggestions manually.',
        '- **Capture first, refine second.** Capture quickly, then use workflow prompts to turn captures into durable knowledge.',
        '- **Link aggressively.** Use [[wikilinks]] in note bodies and follow recommendations after each revision.',
        '- **Archive before delete.** Knowledge systems should prefer reversible lifecycle transitions.',
        '- **Prefer resources for raw reads.** Use granite://notes/{slug} for markdown, granite://assets/{filename} for imported documents, and granite://vault/types for type contracts.',
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
    return toolResult(result, result.aaak);
  });

  server.registerTool('granite_research_topic', {
    title: 'Research Granite Topic',
    description: 'Discover the most relevant notes for a topic before writing or answering. Use this when you need to research the vault, avoid duplicates, or gather context for a synthesis.',
    inputSchema: {
      query: z.string().describe('Topic, keyword set, or research angle to search for in the vault.'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum number of results to return. Defaults to 10.'),
    },
    outputSchema: z.object({
      query: z.string(),
      results: z.array(searchResultSchema),
    }),
    annotations: readOnlyAnnotations,
  }, async ({ query, limit }) => {
    const results = runtime.search(query, limit ?? 10);
    return toolResult({ query, results }, `Found ${results.length} result(s) for "${query}".`);
  });

  server.registerTool('granite_capture_knowledge', {
    title: 'Capture Granite Knowledge',
    description: 'Capture new knowledge into the vault. Use this for raw captures, semi-structured notes, or deliberately titled note drafts. Returns recommendations for what to connect or write next.',
    inputSchema: {
      text: z.string().optional().describe('Raw text to capture. Required unless title and body are both provided.'),
      title: z.string().optional().describe('Optional explicit title when creating a more deliberate draft.'),
      body: z.string().optional().describe('Optional explicit body when creating a more deliberate draft.'),
      type: z.string().optional().describe('Optional note type. Defaults to the vault default type.'),
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
    if (args.title) {
      const result = runtime.createNote({
        title: args.title,
        type: args.type,
        body: args.body ?? args.text,
        tags: args.tags,
        aliases: args.aliases,
        status: args.status,
        source: args.source,
        review_state: args.review_state,
        durability: args.durability,
        derived_from: args.derived_from,
      });
      return toolResult(result, buildWriteSummary('Captured', result, runtime));
    }

    if (!args.text) {
      throw new Error('granite_capture_knowledge requires either text, or title with body/text.');
    }

    const result = runtime.captureNote({
      text: args.body ?? args.text,
      type: args.type,
      tags: args.tags,
      aliases: args.aliases,
      status: args.status,
      source: args.source,
      review_state: args.review_state,
      durability: args.durability,
      derived_from: args.derived_from,
    });
    return toolResult(result, buildWriteSummary('Captured', result, runtime));
  });

  server.registerTool('granite_import_document', {
    title: 'Import Granite Document',
    description: 'Import a local document into the vault by attaching the file, creating a linked source note, and storing caller-provided document content in that note.',
    inputSchema: {
      file_path: z.string().describe('Absolute or relative path to the local document file to import.'),
      content: z.string().min(1).describe('Document text or extracted content to preserve in the source note body. Required.'),
      title: z.string().optional().describe('Optional explicit title for the source note. Defaults to a title derived from the filename.'),
      tags: z.array(z.string()).optional().describe('Tags to add immediately to the source note.'),
      aliases: z.array(z.string()).optional().describe('Aliases to add immediately to the source note.'),
    },
    outputSchema: z.object({
      note: noteDetailsSchema,
      document: importedDocumentAssetSchema,
      recommendations: recommendationSchema,
    }),
    annotations: writeAnnotations,
  }, async ({ file_path, content, title, tags, aliases }) => {
    const result = runtime.importDocument({ file_path, content, title, tags, aliases });
    const summary = [
      `Imported "${result.document.file}" as source "${result.note.title}" (${result.note.slug}).`,
      '',
      'Stored the provided document content in the note and attached the original file as a Granite asset.',
      '',
      `Recommendations: ${recommendationSummary(result.recommendations)}.`,
    ].join('\n');

    return {
      ...toolResult(result, summary),
      content: [
        { type: 'text', text: summary },
        createNoteResourceLink(result.note.title, result.note.resource_uri),
        createAssetResourceLink(result.document.file, result.document.resource_uri, result.document.mime_type),
      ],
    };
  });

  server.registerTool('granite_understand_note', {
    title: 'Understand Granite Note',
    description: 'Inspect a note in context. Returns the note, its outgoing links, backlinks, unlinked mentions, recommendations, and its likely role in the graph.',
    inputSchema: {
      slug: z.string().describe('Slug of the note to inspect.'),
    },
    outputSchema: noteUnderstandingSchema,
    annotations: readOnlyAnnotations,
  }, async ({ slug }) => {
    const result = runtime.understandNote(slug);
    return {
      ...toolResult(result, `Understood "${result.note.title}" (${result.note.slug}) as a ${result.graph_role.role} note.`),
      content: buildUnderstandNoteContent(result),
    };
  });

  server.registerTool('granite_revise_note', {
    title: 'Revise Granite Note',
    description: 'Make a targeted revision to an existing note. Use this when a workflow prompt tells you exactly what to change, or when you need a precise manual intervention.',
    inputSchema: {
      slug: z.string().describe('Slug of the note to revise.'),
      type: z.string().optional().describe('Optional new note type. Use this to promote a note into source, synthesis, or output.'),
      title: z.string().optional().describe('Replace the note title.'),
      body: z.string().optional().describe('Replace the entire note body.'),
      append: z.string().optional().describe('Append text to the existing note body.'),
      tags: z.array(z.string()).optional().describe('Tags to add.'),
      aliases: z.array(z.string()).optional().describe('Aliases to add.'),
      status: z.enum(['inbox', 'active', 'archived']).optional().describe('New note status.'),
      source: z.enum(['human', 'agent', 'extraction']).optional().describe('New note source.'),
      review_state: z.enum(['draft', 'reviewed', 'locked']).optional().describe('New review state.'),
      durability: z.enum(['canonical', 'working', 'ephemeral']).optional().describe('New durability.'),
      derived_from: z.array(z.string()).optional().describe('New derived_from references.'),
    },
    outputSchema: z.object({
      note: noteDetailsSchema,
      recommendations: recommendationSchema,
    }),
    annotations: writeAnnotations,
  }, async ({ slug, ...updates }) => {
    const result = runtime.reviseNote(slug, updates);
    return toolResult(result, buildWriteSummary('Revised', result, runtime));
  });

  server.registerTool('granite_dispose_note', {
    title: 'Dispose Granite Note',
    description: 'Remove a note from the active knowledge loop. Archive by default; delete only when you are intentionally discarding the note.',
    inputSchema: {
      slug: z.string().describe('Slug of the note to archive or delete.'),
      mode: z.enum(['archive', 'delete']).optional().describe('How to dispose of the note. Defaults to archive.'),
    },
    outputSchema: disposeNoteSchema,
    annotations: writeAnnotations,
  }, async ({ slug, mode }) => {
    const result = runtime.disposeNote(slug, mode ?? 'archive');
    return toolResult(result, `${mode ?? 'archive'}d "${slug}".`);
  });
}

function registerResources(server: McpServer, runtime: GraniteMcpRuntime): void {
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

  const assetTemplate = new ResourceTemplate('granite://assets/{filename}', {
    list: undefined,
    complete: {
      filename: async (value) => runtime.completeAssets(value),
    },
  });

  server.registerResource('granite-asset', assetTemplate, {
    title: 'Granite Asset',
    description: 'Read an imported Granite asset. Text files are returned as text; binary files are returned as base64 blobs.',
    mimeType: 'application/octet-stream',
  }, async (_uri, variables) => {
    const variable = variables.filename;
    const fileName = Array.isArray(variable) ? variable[0] : variable;
    if (!fileName) {
      throw new Error('Resource URI is missing the asset filename.');
    }

    return {
      contents: [runtime.readAsset(decodeURIComponent(fileName))],
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
    const linkedAsset = getLinkedAsset(note);

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
              linkedAsset ? 'This note is linked to an imported document. Read that document resource before summarizing or extracting facts.' : '',
              'When you are ready to apply the result, use granite_revise_note rather than low-level CRUD operations.',
            ].filter(Boolean).join(' '),
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
        ...(linkedAsset ? [{
          role: 'user' as const,
          content: {
            type: 'resource' as const,
            resource: runtime.readAsset(linkedAsset.file),
          },
        }] : []),
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
              'Use granite_understand_note before changing a note, granite_revise_note to apply precise edits, and granite_dispose_note to archive anything that should leave the active loop.',
              'If granite_understand_note shows that a source note has an imported document attached, read the linked granite://assets resource before summarizing, extracting facts, or promoting it.',
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

  server.registerPrompt('granite_compile_topic', {
    title: 'Compile Granite Topic',
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
              '2. If a related source note has an imported document attached, read the linked granite://assets resource before summarizing or extracting facts from that source',
              '3. Draft the synthesis body and create it with granite_capture_knowledge (set type: synthesis and provide an explicit title)',
              '4. Write a body that connects the key ideas, with [[wikilinks]] to sources',
              '5. Set derived_from to the source note slugs',
              '6. Run granite_understand_note on the new synthesis to inspect how well it is connected',
              '',
              `Related notes (${noteDetails.length} found for "${topic}"):`,
              '',
              ...noteDetails.map(n => n ? formatCompileTopicNote(n) : ''),
            ].join('\n'),
          },
        },
      ],
    };
  });

  server.registerPrompt('granite_garden_vault', {
    title: 'Garden Granite Vault',
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
              '## Structural Issues (from Granite diagnostics)',
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
              '2. For each orphan note, use granite_understand_note to inspect the note in context',
              '3. If granite_understand_note reveals an imported document on a source note, read the linked granite://assets resource before summarizing or extracting facts',
              '4. If orphan notes should be linked from other notes, revise those notes to add [[wikilinks]]',
              '5. Look for clusters of notes that could be compiled into a synthesis',
              '6. Check if any inbox notes need processing',
              '7. Report a summary of what you found and what you fixed',
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

function createAssetResourceLink(name: string, uri: string, mimeType: string) {
  return {
    type: 'resource_link' as const,
    name,
    uri,
    mimeType,
    description: 'Read the imported source document linked to this note.',
  };
}

function buildUnderstandNoteContent(result: {
  note: { title: string; slug: string; resource_uri: string; frontmatter: Record<string, unknown> };
  graph_role: { role: string };
}) {
  const content: Array<
    { type: 'text'; text: string }
    | ReturnType<typeof createNoteResourceLink>
    | ReturnType<typeof createAssetResourceLink>
  > = [
    { type: 'text', text: `Understood "${result.note.title}" (${result.note.slug}) as a ${result.graph_role.role} note.` },
    createNoteResourceLink(result.note.title, result.note.resource_uri),
  ];

  const linkedAsset = getLinkedAsset(result.note);
  if (linkedAsset) {
    content.push(createAssetResourceLink(linkedAsset.file, linkedAsset.resource_uri, linkedAsset.mime_type));
  }

  return content;
}

function getLinkedAsset(note: { frontmatter: Record<string, unknown> }) {
  const file = typeof note.frontmatter.document_file === 'string' ? note.frontmatter.document_file : null;
  const resourceUri = typeof note.frontmatter.document_resource_uri === 'string' ? note.frontmatter.document_resource_uri : null;
  const mimeType = typeof note.frontmatter.document_mime === 'string' ? note.frontmatter.document_mime : 'application/octet-stream';

  if (!file || !resourceUri) {
    return null;
  }

  return {
    file,
    resource_uri: resourceUri,
    mime_type: mimeType,
  };
}

function formatCompileTopicNote(note: { title: string; slug: string; type: string; body: string; frontmatter: Record<string, unknown> }) {
  const linkedAsset = getLinkedAsset(note);
  return [
    `### ${note.title} (${note.slug}, type: ${note.type})`,
    ...(linkedAsset ? [`Imported document: ${linkedAsset.resource_uri} (${linkedAsset.mime_type})`] : []),
    note.body.slice(0, 500) + (note.body.length > 500 ? '...' : ''),
    '',
  ].join('\n');
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
