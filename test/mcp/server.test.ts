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
import { createDocxFixture } from '../helpers/document-fixtures.js';

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
    expect(tools.tools.some(tool => tool.name === 'granite_extract_document')).toBe(true);
    expect(tools.tools.some(tool => tool.name === 'granite_import_document')).toBe(true);
    expect(tools.tools.some(tool => tool.name === 'granite_understand_note')).toBe(true);
    expect(tools.tools.some(tool => tool.name === 'granite_create_note')).toBe(false);
    expect(tools.tools.some(tool => tool.name === 'granite_plan_garden')).toBe(true);
    expect(tools.tools.some(tool => tool.name === 'granite_adjudicate_garden_opportunity')).toBe(true);
    expect(tools.tools.some(tool => tool.name === 'granite_list_garden_adjudications')).toBe(true);
    expect(resources.resources.some(resource => resource.uri === 'granite://vault/types')).toBe(true);
    expect(templates.resourceTemplates.some(template => template.uriTemplate === 'granite://notes/{slug}')).toBe(true);
    expect(templates.resourceTemplates.some(template => template.uriTemplate === 'granite://assets/{filename}')).toBe(true);
    expect(prompts.prompts.some(prompt => prompt.name === 'granite_refine_note')).toBe(true);
    expect(prompts.prompts.some(prompt => prompt.name === 'granite_compile_topic')).toBe(true);
    expect(prompts.prompts.some(prompt => prompt.name === 'granite_garden_vault')).toBe(false);
    expect(client.getInstructions()).toContain('Knowledge Compilation System');
  });

  it('serves note resources and prompt templates', async () => {
    const resource = await client.readResource({ uri: 'granite://notes/mcp-note' });
    const typeResource = await client.readResource({ uri: 'granite://vault/types' });
    const prompt = await client.getPrompt({
      name: 'granite_compile_topic',
      arguments: { topic: 'MCP' },
    });

    const noteText = resource.contents[0] && 'text' in resource.contents[0] ? resource.contents[0].text : '';
    const typeText = typeResource.contents[0] && 'text' in typeResource.contents[0] ? typeResource.contents[0].text : '';

    expect(noteText).toContain('title: MCP Note');
    expect(typeResource.contents[0] && 'mimeType' in typeResource.contents[0] ? typeResource.contents[0].mimeType : '').toBe('text/markdown');
    expect(typeText).toContain('# Note Types');
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
    expect(extractTextContent(created)).toContain('# Created Note');
    expect(extractTextContent(created).trim().startsWith('{')).toBe(false);

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
    expect(extractTextContent(understood)).toContain('# Note Context');
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

  it('extracts documents through MCP without importing them', async () => {
    const inputFile = path.join(tmpDir, 'mcp-source.docx');
    createDocxFixture(inputFile, ['MCP extraction works']);

    const extracted = await client.callTool({
      name: 'granite_extract_document',
      arguments: {
        file_path: inputFile,
      },
    });

    const extractedData = extractStructuredContent(extracted) as {
      status: string;
      doc_type: string;
      extractor: string;
      raw_text: string;
    };

    expect(extractedData.status).toBe('ready');
    expect(extractedData.doc_type).toBe('docx');
    expect(extractedData.extractor).toBe('mammoth');
    expect(extractedData.raw_text).toContain('MCP extraction works');
    expect(extractTextContent(extracted)).toContain('# Document Extraction');
    expect(extractTextContent(extracted)).toContain('## Raw Text');
  });

  it('returns wakeup as markdown while preserving structured content', async () => {
    const wakeup = await client.callTool({
      name: 'granite_wakeup',
      arguments: {},
    });

    const wakeupData = extractStructuredContent(wakeup) as {
      total: number;
      aaak: string;
    };

    expect(wakeupData.total).toBeGreaterThan(0);
    expect(wakeupData.aaak.length).toBeGreaterThan(0);
    expect(extractTextContent(wakeup)).toContain('# Vault Wakeup');
    expect(extractTextContent(wakeup)).toContain('## AAAK');
  });

  it('makes the inbox workflow doc-aware for imported source notes', async () => {
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

    const inboxMessage = inboxPrompt.messages[0];

    expect(inboxMessage.content.type).toBe('text');
    if (inboxMessage.content.type !== 'text') {
      throw new Error('Expected text content for inbox prompt.');
    }

    expect(inboxMessage.content.text).toContain(importedData.note.slug);
    expect(inboxMessage.content.text).toContain('granite_extract_document');
    expect(inboxMessage.content.text).toContain('imported document attached');
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

    expect(message.content.text).toContain('granite_extract_document');
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

function extractTextContent(result: Awaited<ReturnType<Client['callTool']>>) {
  const textContent = result.content.find(item => item.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('Tool result did not include text content.');
  }
  return textContent.text;
}

