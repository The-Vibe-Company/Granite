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

    createNote(tmpDir, config, 'note', 'MCP Note', 'Granite MCP test note.\n');

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

    expect(tools.tools.some(tool => tool.name === 'granite_capture_knowledge')).toBe(true);
    expect(tools.tools.some(tool => tool.name === 'granite_import_document')).toBe(true);
    expect(tools.tools.some(tool => tool.name === 'granite_understand_note')).toBe(true);
    expect(tools.tools.some(tool => tool.name === 'granite_create_note')).toBe(false);
    expect(resources.resources.some(resource => resource.uri === 'granite://vault/types')).toBe(true);
    expect(templates.resourceTemplates.some(template => template.uriTemplate === 'granite://notes/{slug}')).toBe(true);
    expect(templates.resourceTemplates.some(template => template.uriTemplate === 'granite://assets/{filename}')).toBe(true);
    expect(prompts.prompts.some(prompt => prompt.name === 'granite_refine_note')).toBe(true);
    expect(prompts.prompts.some(prompt => prompt.name === 'granite_compile_topic')).toBe(true);
    expect(prompts.prompts.some(prompt => prompt.name === 'granite_garden_vault')).toBe(true);
    expect(client.getInstructions()).toContain('Knowledge Compilation System');
  });

  it('serves note resources and prompt templates', async () => {
    const resource = await client.readResource({ uri: 'granite://notes/mcp-note' });
    const prompt = await client.getPrompt({
      name: 'granite_compile_topic',
      arguments: { topic: 'MCP' },
    });

    const noteText = resource.contents[0] && 'text' in resource.contents[0] ? resource.contents[0].text : '';

    expect(noteText).toContain('title: MCP Note');
    expect(prompt.messages).toHaveLength(1);
  });

  it('captures notes and understands them through the public MCP tools', async () => {
    const created = await client.callTool({
      name: 'granite_capture_knowledge',
      arguments: {
        title: 'Linked Result',
        type: 'note',
        body: 'This note points to [[MCP Note]].\n',
        source: 'agent',
      },
    });

    const createdData = extractStructuredContent(created) as {
      note: { slug: string; source: string };
    };

    expect(createdData.note.slug).toBe('linked-result');
    expect(createdData.note.source).toBe('agent');

    const understood = await client.callTool({
      name: 'granite_understand_note',
      arguments: { slug: 'mcp-note' },
    });

    const understoodData = extractStructuredContent(understood) as {
      backlinks: Array<{ source_slug: string }>;
      graph_role: { role: string };
    };

    expect(understoodData.backlinks.some(link => link.source_slug === 'linked-result')).toBe(true);
    expect(typeof understoodData.graph_role.role).toBe('string');
  });

  it('archives notes through granite_dispose_note', async () => {
    const disposed = await client.callTool({
      name: 'granite_dispose_note',
      arguments: { slug: 'mcp-note' },
    });

    const disposedData = extractStructuredContent(disposed) as {
      mode: string;
      note: { status: string } | null;
    };

    expect(disposedData.mode).toBe('archive');
    expect(disposedData.note?.status).toBe('archived');
  });

  it('imports documents and serves their asset resources through MCP', async () => {
    const inputFile = path.join(tmpDir, 'mcp-source.pdf');
    fs.writeFileSync(inputFile, '%PDF-1.4\nmcp source\n');

    const imported = await client.callTool({
      name: 'granite_import_document',
      arguments: {
        file_path: inputFile,
        content: 'MCP source content\n\nKey point: preserve the extracted text in the note.',
      },
    });

    const importedData = extractStructuredContent(imported) as {
      note: { slug: string; body: string; frontmatter: Record<string, unknown> };
      document: { file: string; resource_uri: string; mime_type: string };
    };

    expect(importedData.note.slug).toBe('mcp-source');
    expect(importedData.note.frontmatter.document_file).toBe(importedData.document.file);
    expect(importedData.note.body).toContain('MCP source content');

    const resource = await client.readResource({ uri: importedData.document.resource_uri });
    const content = resource.contents[0];

    expect(content && 'mimeType' in content ? content.mimeType : '').toBe('application/pdf');
    expect(content && 'blob' in content).toBe(true);
  });

  it('exposes the vault garden prompt with actionable review instructions', async () => {
    const prompt = await client.getPrompt({
      name: 'granite_garden_vault',
      arguments: {},
    });

    expect(prompt.messages).toHaveLength(1);
    const message = prompt.messages[0];
    expect(message.content.type).toBe('text');
    if (message.content.type !== 'text') {
      throw new Error('Expected text content for granite_garden_vault prompt.');
    }

    expect(message.content.text).toContain('Run a comprehensive health review of this Granite vault');
    expect(message.content.text).toContain('Orphan Notes');
    expect(message.content.text).toContain('mcp-note');
    expect(message.content.text).toContain('Fix any structural errors reported by doctor');
    expect(message.content.text).toContain('granite://assets');
    expect(message.content.text).toContain('imported document');
  });

  it('makes inbox and garden workflows doc-aware for imported source notes', async () => {
    const inputFile = path.join(tmpDir, 'workflow-source.pdf');
    fs.writeFileSync(inputFile, '%PDF-1.4\nworkflow\n');

    const imported = await client.callTool({
      name: 'granite_import_document',
      arguments: {
        file_path: inputFile,
        content: 'Workflow source content',
      },
    });

    const importedData = extractStructuredContent(imported) as {
      note: { slug: string };
    };

    const inboxPrompt = await client.getPrompt({
      name: 'granite_process_inbox',
      arguments: {},
    });
    const gardenPrompt = await client.getPrompt({
      name: 'granite_garden_vault',
      arguments: {},
    });

    const inboxMessage = inboxPrompt.messages[0];
    const gardenMessage = gardenPrompt.messages[0];

    expect(inboxMessage.content.type).toBe('text');
    expect(gardenMessage.content.type).toBe('text');
    if (inboxMessage.content.type !== 'text' || gardenMessage.content.type !== 'text') {
      throw new Error('Expected text content for inbox/garden prompts.');
    }

    expect(inboxMessage.content.text).toContain(importedData.note.slug);
    expect(inboxMessage.content.text).toContain('granite://assets');
    expect(inboxMessage.content.text).toContain('imported document attached');
    expect(gardenMessage.content.text).toContain('granite://assets');
    expect(gardenMessage.content.text).toContain('imported document');
  });

  it('makes compile topic doc-aware for imported source notes', async () => {
    const inputFile = path.join(tmpDir, 'workflow-source.pdf');
    fs.writeFileSync(inputFile, '%PDF-1.4\nworkflow source\n');

    await client.callTool({
      name: 'granite_import_document',
      arguments: {
        file_path: inputFile,
        content: 'Workflow source content',
        title: 'Workflow Source',
      },
    });

    const prompt = await client.getPrompt({
      name: 'granite_compile_topic',
      arguments: { topic: 'workflow' },
    });

    expect(prompt.messages).toHaveLength(1);
    const message = prompt.messages[0];
    expect(message.content.type).toBe('text');
    if (message.content.type !== 'text') {
      throw new Error('Expected text content for granite_compile_topic prompt.');
    }

    expect(message.content.text).toContain('granite://assets');
    expect(message.content.text).toContain('Workflow Source');
    expect(message.content.text).toContain('imported document attached');
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
