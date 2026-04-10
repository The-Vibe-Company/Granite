import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractDocumentCommand } from '../../src/commands/extract.js';
import { createDocxFixture, createPptxFixture, createXlsxFixture } from '../helpers/document-fixtures.js';

describe('extract command', () => {
  let tmpDir: string;
  let previousPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-extract-'));
    previousPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = previousPath;
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts raw text from DOCX without importing anything', async () => {
    const inputFile = path.join(tmpDir, 'sample.docx');
    createDocxFixture(inputFile, ['Hello Granite', 'Second paragraph']);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await extractDocumentCommand(inputFile, { json: true });

    const output = logSpy.mock.calls.at(-1)?.[0];
    const payload = JSON.parse(String(output)) as { success: boolean; data: { status: string; doc_type: string; extractor: string; raw_text: string } };

    expect(payload.success).toBe(true);
    expect(payload.data.status).toBe('ready');
    expect(payload.data.doc_type).toBe('docx');
    expect(payload.data.extractor).toBe('mammoth');
    expect(payload.data.raw_text).toContain('Hello Granite');
    expect(payload.data.raw_text).toContain('Second paragraph');
  });

  it('extracts raw text from XLSX without importing anything', async () => {
    const inputFile = path.join(tmpDir, 'sheet.xlsx');
    createXlsxFixture(inputFile, [['Name', 'Role'], ['Stan', 'Founder']]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await extractDocumentCommand(inputFile, { json: true });

    const output = logSpy.mock.calls.at(-1)?.[0];
    const payload = JSON.parse(String(output)) as { success: boolean; data: { status: string; doc_type: string; extractor: string; raw_text: string } };

    expect(payload.success).toBe(true);
    expect(payload.data.status).toBe('ready');
    expect(payload.data.doc_type).toBe('xlsx');
    expect(payload.data.extractor).toBe('sheetjs');
    expect(payload.data.raw_text).toContain('Sheet: Sheet1');
    expect(payload.data.raw_text).toContain('Name\tRole');
    expect(payload.data.raw_text).toContain('Stan\tFounder');
  });

  it('extracts raw text from PPTX without importing anything', async () => {
    const inputFile = path.join(tmpDir, 'deck.pptx');
    createPptxFixture(inputFile, [['First slide', 'Key point'], ['Second slide']]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await extractDocumentCommand(inputFile, { json: true });

    const output = logSpy.mock.calls.at(-1)?.[0];
    const payload = JSON.parse(String(output)) as { success: boolean; data: { status: string; doc_type: string; extractor: string; raw_text: string } };

    expect(payload.success).toBe(true);
    expect(payload.data.status).toBe('ready');
    expect(payload.data.doc_type).toBe('pptx');
    expect(payload.data.extractor).toBe('ooxml-pptx');
    expect(payload.data.raw_text).toContain('Slide: slide1');
    expect(payload.data.raw_text).toContain('First slide');
    expect(payload.data.raw_text).toContain('Key point');
    expect(payload.data.raw_text).toContain('Slide: slide2');
  });

  it('returns install instructions when Ferrules is missing for PDF extraction', async () => {
    const inputFile = path.join(tmpDir, 'scan.pdf');
    fs.writeFileSync(inputFile, '%PDF-1.4\nscan\n');
    process.env.PATH = tmpDir;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await extractDocumentCommand(inputFile, { json: true });

    const output = logSpy.mock.calls.at(-1)?.[0];
    const payload = JSON.parse(String(output)) as {
      success: boolean;
      data: {
        status: string;
        extractor: string;
        missing_dependency: string;
        install_source_url: string;
        verify_command: string;
        install_instructions: { platform: string; steps: string[]; notes: string[] };
        user_prompt: string;
      };
    };

    expect(payload.success).toBe(true);
    expect(payload.data.status).toBe('needs_dependency');
    expect(payload.data.extractor).toBe('ferrules');
    expect(payload.data.missing_dependency).toBe('ferrules');
    expect(payload.data.install_source_url).toBe('https://github.com/aminediro/ferrules/releases');
    expect(payload.data.verify_command).toBe('ferrules --version');
    expect(payload.data.install_instructions.steps).toHaveLength(4);
    expect(payload.data.user_prompt).toContain('Ferrules');
  });

  it('returns raw PDF text when Ferrules succeeds', async () => {
    const inputFile = path.join(tmpDir, 'paper.pdf');
    fs.writeFileSync(inputFile, '%PDF-1.4\npaper\n');
    const ferrulesPath = path.join(tmpDir, 'ferrules');
    fs.writeFileSync(
      ferrulesPath,
      [
        '#!/bin/sh',
        'FILE="$1"',
        'shift',
        'OUT_DIR=""',
        'if [ "$1" = "--output-dir" ]; then',
        '  OUT_DIR="$2"',
        'fi',
        'cat > "$OUT_DIR/$(basename "$FILE" .pdf)-results.json" <<\'JSON\'',
        '{"markdown":"Ferrules extracted PDF text"}',
        'JSON',
      ].join('\n'),
      'utf-8',
    );
    fs.chmodSync(ferrulesPath, 0o755);
    process.env.PATH = `${tmpDir}:${previousPath ?? ''}`;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await extractDocumentCommand(inputFile, { json: true });

    const output = logSpy.mock.calls.at(-1)?.[0];
    const payload = JSON.parse(String(output)) as { success: boolean; data: { status: string; doc_type: string; extractor: string; raw_text: string } };

    expect(payload.success).toBe(true);
    expect(payload.data.status).toBe('ready');
    expect(payload.data.doc_type).toBe('pdf');
    expect(payload.data.extractor).toBe('ferrules');
    expect(payload.data.raw_text).toBe('Ferrules extracted PDF text');
  });
});
