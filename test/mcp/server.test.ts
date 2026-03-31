import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeDefaultConfig, loadConfig } from '../../src/core/config.js';
import { createNote } from '../../src/core/note.js';
import type { GraniteConfig } from '../../src/core/types.js';
import { GraniteMcpRuntime } from '../../src/mcp/runtime.js';
import { createGraniteMcpServer, withResponseCleanup } from '../../src/mcp/server.js';

describe('granite MCP server', () => {
  let tmpDir: string;
  let config: GraniteConfig;
  let runtime: GraniteMcpRuntime;
  let server: ReturnType<typeof createGraniteMcpServer>;
  let client: Client;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-mcp-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);

    for (const typeConfig of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, typeConfig.folder), { recursive: true });
    }

    createNote(tmpDir, config, 'permanent', 'MCP Note', 'Granite MCP test note.\n');

    runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    server = createGraniteMcpServer(runtime);
    client = new Client({ name: 'granite-test-client', version: '1.0.0' });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    runtime.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exposes tools, resources, prompts, and instructions', async () => {
    const tools = await client.listTools();
    const resources = await client.listResources();
    const templates = await client.listResourceTemplates();
    const prompts = await client.listPrompts();

    expect(tools.tools.some(tool => tool.name === 'granite_create_note')).toBe(true);
    expect(resources.resources.some(resource => resource.uri === 'granite://vault/config')).toBe(true);
    expect(templates.resourceTemplates.some(template => template.uriTemplate === 'granite://notes/{slug}')).toBe(true);
    expect(prompts.prompts.some(prompt => prompt.name === 'granite_refine_note')).toBe(true);
    expect(client.getInstructions()).toContain('Granite exposes a local-first markdown vault.');
  });

  it('serves note resources and prompt templates', async () => {
    const resource = await client.readResource({ uri: 'granite://notes/mcp-note' });
    const prompt = await client.getPrompt({
      name: 'granite_review_connections',
      arguments: { slug: 'mcp-note' },
    });

    const noteText = resource.contents[0] && 'text' in resource.contents[0] ? resource.contents[0].text : '';

    expect(noteText).toContain('title: MCP Note');
    expect(prompt.messages).toHaveLength(3);
  });

  it('creates notes and updates backlinks through MCP tools', async () => {
    const created = await client.callTool({
      name: 'granite_create_note',
      arguments: {
        title: 'Linked Result',
        type: 'permanent',
        body: 'This note points to [[MCP Note]].\n',
        source: 'agent',
      },
    });

    const createdData = extractStructuredContent(created) as {
      note: { slug: string; source: string };
    };

    expect(createdData.note.slug).toBe('linked-result');
    expect(createdData.note.source).toBe('agent');

    const backlinks = await client.callTool({
      name: 'granite_get_backlinks',
      arguments: { slug: 'mcp-note' },
    });

    const backlinkData = extractStructuredContent(backlinks) as {
      backlinks: Array<{ source_slug: string }>;
    };

    expect(backlinkData.backlinks.some(link => link.source_slug === 'linked-result')).toBe(true);
  });

  it('closes cleanup hooks after an HTTP response body is consumed', async () => {
    let cleanupCount = 0;
    const response = new Response('granite');

    const wrapped = await withResponseCleanup(response, async () => {
      cleanupCount += 1;
    });

    expect(await wrapped.text()).toBe('granite');
    expect(cleanupCount).toBe(1);
  });
});

function extractStructuredContent(result: Awaited<ReturnType<Client['callTool']>>) {
  if (!('structuredContent' in result) || !result.structuredContent) {
    throw new Error('Tool result did not include structuredContent.');
  }
  return result.structuredContent;
}
