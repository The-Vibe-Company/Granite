import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import * as z from 'zod/v4';
import {
  renderDisposeNoteMarkdown,
  renderGardenPlanMarkdown,
  renderMutationResultMarkdown,
  renderQueryResultsMarkdown,
  renderSearchResultsMarkdown,
  renderUnderstandNoteMarkdown,
  renderWakeupMarkdown,
} from '../../../shared/mcp-markdown.js';

export interface CanonicalCloudMcpRuntime {
  wakeup(): Promise<any>;
  researchTopic(input: { query: string; limit?: number }): Promise<any[]>;
  captureKnowledge(input: {
    text?: string;
    title?: string;
    type?: string;
    body?: string;
    tags?: string[];
    aliases?: string[];
    status?: string;
    source?: string;
    review_state?: string;
    durability?: string;
    derived_from?: string[];
    fields?: Record<string, unknown>;
  }): Promise<any>;
  understandNote(input: { slug: string }): Promise<any>;
  reviseNote(input: {
    slug: string;
    title?: string;
    body?: string;
    append?: string;
    tags?: string[];
    aliases?: string[];
    status?: string;
    source?: string;
    review_state?: string;
    durability?: string;
    derived_from?: string[];
    fields?: Record<string, unknown>;
  }): Promise<any>;
  query(input: {
    type?: string;
    where?: Record<string, unknown>;
    sort_field?: string;
    sort_dir?: 'asc' | 'desc';
    limit?: number;
  }): Promise<any[]>;
  compileContext(input: { topic?: string; slug?: string; limit?: number }): Promise<any[]>;
  planGarden(input: { anchor_slug?: string; limit?: number }): Promise<any>;
  disposeNote(input: { slug: string; mode?: 'archive' | 'delete' }): Promise<any>;
}

export function createCloudMcpServer(runtime: CanonicalCloudMcpRuntime): McpServer {
  const server = new McpServer({
    name: 'granite-cloud-mcp',
    version: '0.1.0',
  }, {
    instructions: [
      '# Granite Cloud MCP',
      '',
      'This server exposes the canonical Granite MCP tools for a private cloud vault.',
      'It is stateless at the MCP transport edge; every request is independently authenticated by the Worker.',
    ].join('\n'),
  });

  server.registerTool('granite_wakeup', {
    title: 'Wake Up Granite',
    description: 'Load a compact snapshot of the cloud vault.',
  }, async () => textResult(renderWakeupMarkdown(await runtime.wakeup())));

  server.registerTool('granite_research_topic', {
    title: 'Research Topic',
    description: 'Search the cloud vault for notes related to a topic before writing.',
    inputSchema: {
      query: z.string(),
      limit: z.number().optional(),
    },
  }, async (input) => {
    const results = await runtime.researchTopic(input);
    return textResult(renderSearchResultsMarkdown(input.query, results));
  });

  server.registerTool('granite_capture_knowledge', {
    title: 'Capture Knowledge',
    description: 'Create a typed note in the cloud vault.',
    inputSchema: {
      text: z.string().optional(),
      title: z.string().optional(),
      body: z.string().optional(),
      type: z.string().optional(),
      tags: z.array(z.string()).optional(),
      aliases: z.array(z.string()).optional(),
      status: z.enum(['inbox', 'active', 'archived']).optional(),
      source: z.enum(['human', 'agent', 'extraction']).optional(),
      review_state: z.enum(['draft', 'reviewed', 'locked']).optional(),
      durability: z.enum(['canonical', 'working', 'ephemeral']).optional(),
      derived_from: z.array(z.string()).optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
    },
  }, async (input) => {
    if (!input.title && !input.text && !input.body) {
      throw new Error('granite_capture_knowledge requires either text, or title with body/text.');
    }
    const result = await runtime.captureKnowledge(input);
    return textResult(renderMutationResultMarkdown('Captured', result.note, result.recommendations));
  });

  server.registerTool('granite_understand_note', {
    title: 'Understand Note',
    description: 'Read a note with graph context from the cloud vault.',
    inputSchema: { slug: z.string() },
  }, async (input) => textResult(renderUnderstandNoteMarkdown(await runtime.understandNote(input))));

  server.registerTool('granite_revise_note', {
    title: 'Revise Note',
    description: 'Update an existing cloud note.',
    inputSchema: {
      slug: z.string(),
      title: z.string().optional(),
      body: z.string().optional(),
      append: z.string().optional(),
      tags: z.array(z.string()).optional(),
      aliases: z.array(z.string()).optional(),
      status: z.enum(['inbox', 'active', 'archived']).optional(),
      source: z.enum(['human', 'agent', 'extraction']).optional(),
      review_state: z.enum(['draft', 'reviewed', 'locked']).optional(),
      durability: z.enum(['canonical', 'working', 'ephemeral']).optional(),
      derived_from: z.array(z.string()).optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
    },
  }, async (input) => {
    const result = await runtime.reviseNote(input);
    return textResult(renderMutationResultMarkdown('Updated', result.note, result.recommendations));
  });

  server.registerTool('granite_query', {
    title: 'Query Notes',
    description: 'Run a deterministic structured query against the cloud vault.',
    inputSchema: {
      type: z.string().optional(),
      where: z.record(z.string(), z.unknown()).optional(),
      sort_field: z.string().optional(),
      sort_dir: z.enum(['asc', 'desc']).optional(),
      limit: z.number().optional(),
    },
  }, async (input) => textResult(renderQueryResultsMarkdown(await runtime.query(input))));

  server.registerTool('granite_compile_context', {
    title: 'Compile Context',
    description: 'Assemble relevant notes for a topic or anchor slug.',
    inputSchema: {
      topic: z.string().optional(),
      slug: z.string().optional(),
      limit: z.number().optional(),
    },
  }, async (input) => {
    const results = await runtime.compileContext(input);
    return textResult(renderQueryResultsMarkdown(results));
  });

  server.registerTool('granite_plan_garden', {
    title: 'Plan Garden',
    description: 'Compute deterministic opportunities to improve the cloud vault.',
    inputSchema: {
      anchor_slug: z.string().optional(),
      limit: z.number().optional(),
    },
  }, async (input) => textResult(renderGardenPlanMarkdown(await runtime.planGarden(input))));

  server.registerTool('granite_dispose_note', {
    title: 'Dispose Note',
    description: 'Archive by default, delete only when explicitly requested.',
    inputSchema: {
      slug: z.string(),
      mode: z.enum(['archive', 'delete']).optional(),
    },
  }, async (input) => textResult(renderDisposeNoteMarkdown(await runtime.disposeNote(input))));

  return server;
}

export async function handleCloudMcpRequest(request: Request, runtime: CanonicalCloudMcpRuntime): Promise<Response> {
  const server = createCloudMcpServer(runtime);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    return await withServerCleanup(response, async () => {
      await server.close();
    });
  } catch (error) {
    await server.close();
    throw error;
  }
}

function textResult(markdown: string) {
  return { content: [{ type: 'text' as const, text: markdown }] };
}

async function withServerCleanup(response: Response, cleanup: () => Promise<void>): Promise<Response> {
  let cleaned = false;
  async function runCleanup(): Promise<void> {
    if (cleaned) return;
    cleaned = true;
    await cleanup();
  }

  if (!response.body) {
    await runCleanup();
    return response;
  }

  const reader = response.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          await runCleanup();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        await runCleanup();
        throw error;
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await runCleanup();
      }
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
