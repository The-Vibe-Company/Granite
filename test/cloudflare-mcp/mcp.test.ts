import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCloudMcpServer, type CanonicalCloudMcpRuntime } from '../../packages/cloudflare-mcp/src/mcp.js';

describe('granite cloudflare MCP server', () => {
  let server: ReturnType<typeof createCloudMcpServer>;
  let client: Client;

  beforeEach(async () => {
    server = createCloudMcpServer(createRuntimeStub());
    client = new Client({ name: 'granite-cloudflare-test-client', version: '1.0.0' });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('exposes canonical Granite MCP tools only', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map(tool => tool.name).sort();

    expect(names).toEqual([
      'granite_capture_knowledge',
      'granite_compile_context',
      'granite_dispose_note',
      'granite_plan_garden',
      'granite_query',
      'granite_research_topic',
      'granite_revise_note',
      'granite_understand_note',
      'granite_wakeup',
    ]);
    expect(names).not.toContain('granite_get_note');
    expect(names).not.toContain('granite_create_note');
  });

  it('renders wakeup, research, and note understanding as markdown', async () => {
    const wakeup = await client.callTool({ name: 'granite_wakeup', arguments: {} });
    const research = await client.callTool({ name: 'granite_research_topic', arguments: { query: 'worker' } });
    const understand = await client.callTool({ name: 'granite_understand_note', arguments: { slug: 'cloud-note' } });

    expect(extractTextContent(wakeup)).toContain('# Vault Wakeup');
    expect(extractTextContent(research)).toContain('# Search Results');
    expect(extractTextContent(understand)).toContain('# Note Context');
    expect(extractTextContent(understand)).toContain('cloud-note');
  });

  it('renders write, query, garden, and dispose tools as markdown', async () => {
    const capture = await client.callTool({
      name: 'granite_capture_knowledge',
      arguments: { title: 'Fresh Cloud Note', body: 'Fresh body.' },
    });
    const rawCapture = await client.callTool({
      name: 'granite_capture_knowledge',
      arguments: { text: 'Raw cloud capture.\n\nDetails.' },
    });
    const query = await client.callTool({ name: 'granite_query', arguments: { type: 'note' } });
    const garden = await client.callTool({ name: 'granite_plan_garden', arguments: {} });
    const dispose = await client.callTool({ name: 'granite_dispose_note', arguments: { slug: 'cloud-note' } });

    expect(extractTextContent(capture)).toContain('# Captured Note');
    expect(extractTextContent(rawCapture)).toContain('# Captured Note');
    expect(extractTextContent(query)).toContain('# Query Results');
    expect(extractTextContent(garden)).toContain('# Garden Plan');
    expect(extractTextContent(dispose)).toContain('# Disposed Note');
  });
});

function createRuntimeStub(): CanonicalCloudMcpRuntime {
  const note = {
    slug: 'cloud-note',
    title: 'Cloud Note',
    type: 'note',
    created: '2026-04-10T08:00:00.000Z',
    modified: '2026-04-10T09:00:00.000Z',
    tags: ['granite'],
    aliases: [],
    status: 'active',
    source: 'human',
    review_state: 'reviewed',
    durability: 'canonical',
    derived_from: [],
    filepath: 'notes/cloud-note.md',
    resource_uri: 'granite://notes/cloud-note',
  };

  const details = {
    ...note,
    body: 'Cloud note body.\n',
    frontmatter: {
      id: 'cloud-1',
      title: 'Cloud Note',
      type: 'note',
      created: note.created,
      modified: note.modified,
      tags: note.tags,
      aliases: [],
      status: 'active',
      source: 'human',
      review_state: 'reviewed',
      durability: 'canonical',
      derived_from: [],
    },
    outgoing_links: [],
  };

  return {
    async wakeup() {
      return {
        total: 1,
        by_type: { note: 1 },
        modified: note.modified,
        clusters: [],
        people: [],
        recent: [{ slug: note.slug, age: 'now' }],
        stale: [],
        aaak: 'Cloud vault has one note.',
      };
    },
    async researchTopic() {
      return [{ slug: note.slug, title: note.title, snippet: 'Cloud note body.', score: 1 }];
    },
    async captureKnowledge(input) {
      return { note: { ...details, title: input.title ?? input.text ?? 'Captured', slug: 'fresh-cloud-note' }, recommendations: emptyRecommendations() };
    },
    async understandNote() {
      return {
        note: details,
        backlinks: [],
        link_suggestions: [],
        recommendations: emptyRecommendations(),
        graph_role: { role: 'leaf', reason: 'test', inbound_links: 0, outbound_links: 0, total_connections: 0 },
      };
    },
    async reviseNote() {
      return { note: details, recommendations: emptyRecommendations() };
    },
    async query() {
      return [{ ...note, fields: {} }];
    },
    async compileContext() {
      return [{ ...note, fields: {} }];
    },
    async planGarden() {
      return {
        scope: {
          kind: 'vault',
          generated_at: '2026-04-10T09:00:00.000Z',
          notes_considered: 1,
          clusters_considered: 0,
        },
        operator_hint: 'No opportunities.',
        opportunities: [],
      };
    },
    async disposeNote() {
      return { slug: note.slug, mode: 'archive', backlinks_removed: 0, derived_children: 0, note: details };
    },
  };
}

function emptyRecommendations() {
  return { additions: [], links: [], tags: [], next_steps: [] };
}

function extractTextContent(result: Awaited<ReturnType<Client['callTool']>>) {
  const textContent = result.content.find(item => item.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('Tool result did not include text content.');
  }
  return textContent.text;
}
