import type { Context } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import * as z from 'zod/v4';
import type { Env, Tier } from '../env.js';
import { TIER_LIMITS } from '../env.js';
import { R2NoteStorage } from '../storage/r2.js';
import { D1IndexDatabase } from '../storage/d1.js';
import { CloudMcpRuntime } from '../runtime.js';

function getVaultId(c: Context<{ Bindings: Env }>): string {
  return c.get('vaultId') as string;
}

function createRuntime(c: Context<{ Bindings: Env }>): CloudMcpRuntime {
  const vaultId = getVaultId(c);
  const tier: Tier = c.get('tier');
  const storage = new R2NoteStorage(c.env.VAULT_BUCKET, vaultId);
  const db = new D1IndexDatabase(c.env.DB, vaultId);
  return new CloudMcpRuntime(storage, db, TIER_LIMITS[tier].maxNotesPerVault);
}

function createMcpServer(runtime: CloudMcpRuntime): McpServer {
  const server = new McpServer({
    name: 'granite-cloud',
    version: '0.1.0',
  });

  // --- Read-only tools ---

  server.tool(
    'granite_get_vault_overview',
    'Get a summary of the vault',
    { recent_limit: z.number().optional() },
    async ({ recent_limit }) => {
      const overview = await runtime.getVaultOverview(recent_limit);
      return { content: [{ type: 'text', text: JSON.stringify(overview, null, 2) }] };
    },
  );

  server.tool(
    'granite_list_note_types',
    'List all configured note types',
    {},
    async () => {
      const types = await runtime.listNoteTypes();
      return { content: [{ type: 'text', text: JSON.stringify(types, null, 2) }] };
    },
  );

  server.tool(
    'granite_list_notes',
    'List notes with optional filters',
    {
      type: z.string().optional(),
      status: z.enum(['inbox', 'active', 'archived']).optional(),
      source: z.enum(['human', 'agent', 'extraction']).optional(),
      since: z.string().optional(),
      limit: z.number().optional(),
    },
    async (input) => {
      const notes = await runtime.listNotes(input);
      return { content: [{ type: 'text', text: JSON.stringify(notes, null, 2) }] };
    },
  );

  server.tool(
    'granite_get_note',
    'Get a note by slug with full details',
    { slug: z.string() },
    async ({ slug }) => {
      const note = await runtime.getNote(slug);
      return { content: [{ type: 'text', text: JSON.stringify(note, null, 2) }] };
    },
  );

  server.tool(
    'granite_search_notes',
    'Full-text search across notes',
    { query: z.string(), limit: z.number().optional() },
    async ({ query, limit }) => {
      const results = await runtime.search(query, limit);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    },
  );

  server.tool(
    'granite_get_backlinks',
    'Get notes that link to a given note',
    { slug: z.string() },
    async ({ slug }) => {
      const backlinks = await runtime.getBacklinks(slug);
      return { content: [{ type: 'text', text: JSON.stringify(backlinks, null, 2) }] };
    },
  );

  server.tool(
    'granite_suggest_links',
    'Suggest wikilinks based on unlinked mentions',
    { slug: z.string() },
    async ({ slug }) => {
      const suggestions = await runtime.suggestLinks(slug);
      return { content: [{ type: 'text', text: JSON.stringify(suggestions, null, 2) }] };
    },
  );

  // --- Write tools ---

  server.tool(
    'granite_create_note',
    'Create a new note',
    {
      title: z.string(),
      type: z.string().optional(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
      aliases: z.array(z.string()).optional(),
      status: z.enum(['inbox', 'active', 'archived']).optional(),
      source: z.enum(['human', 'agent', 'extraction']).optional(),
    },
    async (input) => {
      const result = await runtime.createNote(input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'granite_capture_note',
    'Quick-capture a note from free-form text',
    {
      text: z.string(),
      type: z.string().optional(),
      tags: z.array(z.string()).optional(),
      status: z.enum(['inbox', 'active', 'archived']).optional(),
      source: z.enum(['human', 'agent', 'extraction']).optional(),
    },
    async (input) => {
      const result = await runtime.captureNote(input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'granite_update_note',
    'Update an existing note',
    {
      slug: z.string(),
      title: z.string().optional(),
      body: z.string().optional(),
      append: z.string().optional(),
      tags: z.array(z.string()).optional(),
      aliases: z.array(z.string()).optional(),
      status: z.enum(['inbox', 'active', 'archived']).optional(),
      source: z.enum(['human', 'agent', 'extraction']).optional(),
    },
    async ({ slug, ...input }) => {
      const result = await runtime.updateNote(slug, input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // --- Resources ---

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
    async (uri) => {
      const overview = await runtime.getVaultOverview();
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(overview, null, 2) }] };
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
    // Add CORS headers
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
