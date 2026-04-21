#!/usr/bin/env node
// Spawns the installed `granite mcp` binary over stdio against a throwaway vault
// and exercises the new schemas + validation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const GRANITE_BIN = '/Users/stan/.nvm/versions/node/v22.17.0/bin/granite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-live-verify-'));

// Minimal config with a STRICT meeting type that has a required field
const cfg = {
  vault_name: 'verify',
  version: 1,
  defaults: { note_type: 'note' },
  note_types: {
    note: {
      folder: 'notes',
      description: 'Atomic idea',
      template: '## Summary\n\n## Details\n',
      line_limit: 200,
      warn_only: true,
    },
    meeting: {
      folder: 'meetings',
      description: 'Strict meeting',
      template: '## Summary\n\n## Decisions\n\n## Action items\n',
      line_limit: 300,
      warn_only: false,
      fields: {
        date: { type: 'date', required: true, description: 'Meeting date' },
      },
      frontmatter_defaults: { durability: 'canonical' },
    },
  },
  index: { auto_rebuild: true },
};

fs.writeFileSync(path.join(tmp, 'granite.yml'), yaml.dump(cfg));
fs.mkdirSync(path.join(tmp, 'notes'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'meetings'), { recursive: true });

const transport = new StdioClientTransport({
  command: GRANITE_BIN,
  args: ['mcp', '--vault', tmp],
  stderr: 'inherit',
});
const client = new Client({ name: 'verify', version: '1.0' });
await client.connect(transport);

function h(title) { console.log('\n══', title, '══'); }

h('1. listTools: does granite_capture_knowledge expose `fields` and enum type?');
const tools = await client.listTools();
const cap = tools.tools.find(t => t.name === 'granite_capture_knowledge');
const rev = tools.tools.find(t => t.name === 'granite_revise_note');
const capProps = cap.inputSchema.properties;
const revProps = rev.inputSchema.properties;
console.log('capture.fields schema present:', !!capProps.fields);
console.log('capture.type schema:', JSON.stringify(capProps.type));
console.log('revise.fields schema present:', !!revProps.fields);
console.log('revise.type schema:', JSON.stringify(revProps.type));

h('2. Instructions header contains TYPES pointer + signature?');
console.log('instructions head:\n', (client.getInstructions() ?? '').split('\n').slice(0, 25).join('\n'));

h('3. wakeup markdown contains TYPES pointer?');
const wk = await client.callTool({ name: 'granite_wakeup', arguments: {} });
const wkText = wk.content?.find(c => c.type === 'text')?.text ?? '';
console.log('TYPES line in wakeup markdown:', wkText.match(/^TYPES: .*/m)?.[0]);

h('4. Strict meeting WITHOUT required fields → should be rejected');
const missingResult = await client.callTool({
  name: 'granite_capture_knowledge',
  arguments: {
    title: 'Sync without date',
    type: 'meeting',
    body: '## Summary\n## Decisions\n## Action items\n',
  },
});
console.log('isError:', missingResult.isError);
const missingText = missingResult.content?.find(c => c.type === 'text')?.text ?? '';
console.log('message:', missingText.slice(0, 200));

h('5. Strict meeting WITH fields.date → should succeed and carry validation');
const okResult = await client.callTool({
  name: 'granite_capture_knowledge',
  arguments: {
    title: 'Sync with date',
    type: 'meeting',
    body: '## Summary\n## Decisions\n## Action items\n',
    fields: { date: '2026-04-17' },
  },
});
console.log('isError:', okResult.isError);
const okText = okResult.content?.find(c => c.type === 'text')?.text ?? '';
console.log('markdown contains date:', okText.includes('2026-04-17'));
console.log('markdown contains validation-failure markers:', /missing_required_field|validation_failed/.test(okText));

h('6. Revise that pushes strict body past line_limit → should throw, no mutation');
const before = fs.readFileSync(path.join(tmp, 'meetings', 'sync-with-date.md'), 'utf-8');
const huge = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
const revResult = await client.callTool({
  name: 'granite_revise_note',
  arguments: { slug: 'sync-with-date', append: huge },
});
console.log('isError:', revResult.isError);
const revText = revResult.content?.find(c => c.type === 'text')?.text ?? '';
console.log('message:', revText.slice(0, 200));
const after = fs.readFileSync(path.join(tmp, 'meetings', 'sync-with-date.md'), 'utf-8');
console.log('file bytes unchanged:', before.length === after.length);

h('7. Read granite://vault/types — check for template/body_sections/example/defaults');
const res = await client.readResource({ uri: 'granite://vault/types' });
const text = res.contents[0]?.text ?? '';
console.log('contains "Body template":', text.includes('### Body template'));
console.log('contains "Body sections":', text.includes('### Body sections'));
console.log('contains "Frontmatter defaults":', text.includes('### Frontmatter defaults'));

await client.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n✅ done');
