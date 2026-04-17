import { Command, InvalidArgumentError } from 'commander';
import { initVault } from './commands/init.js';
import { newNote } from './commands/new.js';
import { addNote } from './commands/add.js';
import { openNote } from './commands/open.js';
import { showCommand } from './commands/show.js';
import { searchCommand } from './commands/search.js';
import { backlinksCommand } from './commands/backlinks.js';
import { suggestLinksCommand } from './commands/suggest-links.js';
import { recommendCommand } from './commands/recommend.js';
import { doctorCommand } from './commands/doctor.js';
import { serveCommand } from './commands/serve.js';
import { typesCommand } from './commands/types.js';
import { listCommand } from './commands/list.js';
import { editCommand } from './commands/edit.js';
import { statusCommand } from './commands/status.js';
import { mcpCommand, mcpStopCommand, mcpStatusCommand, parseTransport } from './commands/mcp.js';
import { wakeupCommand } from './commands/wakeup.js';
import { attachCommand } from './commands/attach.js';
import { extractDocumentCommand } from './commands/extract.js';
import { importDocumentCommand } from './commands/import.js';
import { GRANITE_VERSION } from './version.js';

const program = new Command();

program
  .name('granite')
  .description('Granite — a local-first knowledge compiler. capture → compile → query → output → lint')
  .version(GRANITE_VERSION);

// ─── Setup ────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Create a new vault and start the knowledge loop')
  .option('--template <name>', 'Start from a template (e.g. founder-os)')
  .action((options: { template?: string }) => {
    initVault(undefined, { template: options.template });
  });

program
  .command('status')
  .description('See where your vault stands and what to do next')
  .option('--json', 'Output as JSON')
  .action((options: { json?: boolean }) => {
    statusCommand(options);
  });

// ─── Capture ──────────────────────────────────────────────────────────

program
  .command('new')
  .description('Create a structured note — search first to avoid duplicates')
  .argument('<title>', 'Note title')
  .option('-t, --type <type>', 'Note type (note, source, synthesis, output)')
  .option('--source <source>', 'Who created it (human, agent, extraction)')
  .option('--status <status>', 'Lifecycle state (inbox, active, archived)')
  .option('--review-state <state>', 'Editorial state (draft, reviewed, locked)')
  .option('--durability <durability>', 'Knowledge permanence (canonical, working, ephemeral)')
  .option('--derived-from <refs>', 'Provenance: slugs this note derives from (comma-separated)')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((title: string, options: { type?: string; source?: string; status?: string; reviewState?: string; durability?: string; derivedFrom?: string; json?: boolean }) => {
    newNote(title, options);
  });

program
  .command('add')
  .description('Quick-capture raw text into the vault — the fastest way to get something in')
  .argument('[text]', 'Note text (or pipe via stdin)')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((text: string | undefined, options: { json?: boolean }) => {
    addNote(text, options);
  });

// ─── Query ────────────────────────────────────────────────────────────

program
  .command('list')
  .alias('ls')
  .description('Browse the vault — filter by type, status, source, or date')
  .option('-t, --type <type>', 'Filter by note type')
  .option('-s, --status <status>', 'Filter by status (inbox, active, archived)')
  .option('--source <source>', 'Filter by source (human, agent, extraction)')
  .option('--since <date>', 'Only notes modified since (YYYY-MM-DD)')
  .option('--json [fields]', 'Output as JSON; optionally select fields (e.g. --json slug,title,type)')
  .action((options: { type?: string; status?: string; source?: string; since?: string; json?: boolean | string }) => {
    listCommand(options);
  });

program
  .command('show')
  .alias('cat')
  .description('Read a note in full — frontmatter, body, and metadata')
  .argument('<slug>', 'Note slug')
  .option('--json', 'Output as JSON (agent-friendly)')
  .option('--body', 'Output body only (for piping)')
  .action((slug: string, options: { json?: boolean; body?: boolean }) => {
    showCommand(slug, options);
  });

program
  .command('search')
  .description('Research a topic across the vault — use before creating to avoid duplicates')
  .argument('<query>', 'Search query')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((query: string, options: { json?: boolean }) => {
    searchCommand(query, options);
  });

// ─── Compile ──────────────────────────────────────────────────────────

program
  .command('edit')
  .description('Refine a note — append, rewrite, promote status, add tags and links')
  .argument('<slug>', 'Note slug')
  .option('--body <text>', 'Replace the note body')
  .option('--append <text>', 'Append text to the note body')
  .option('--title <title>', 'Update the note title')
  .option('--tag <tags>', 'Add tags (comma-separated)')
  .option('--alias <aliases>', 'Add aliases (comma-separated)')
  .option('--status <status>', 'Set status (inbox, active, archived)')
  .option('--source <source>', 'Set source (human, agent, extraction)')
  .option('--review-state <state>', 'Set review state (draft, reviewed, locked)')
  .option('--durability <durability>', 'Set durability (canonical, working, ephemeral)')
  .option('--derived-from <refs>', 'Set derived_from references (comma-separated slugs)')
  .action((slug: string, options: { body?: string; append?: string; title?: string; tag?: string; alias?: string; status?: string; source?: string; reviewState?: string; durability?: string; derivedFrom?: string }) => {
    editCommand(slug, options);
  });

program
  .command('open')
  .description('Open a note in your editor')
  .argument('<slug>', 'Note slug')
  .action((slug: string) => {
    openNote(slug);
  });

program
  .command('backlinks')
  .description("See a note's role in the graph — who links here and why")
  .argument('<slug>', 'Note slug')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((slug: string, options: { json?: boolean }) => {
    backlinksCommand(slug, options);
  });

program
  .command('suggest-links')
  .description('Find unlinked mentions — strengthen the graph by adding missed [[wikilinks]]')
  .argument('<slug>', 'Note slug')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((slug: string, options: { json?: boolean }) => {
    suggestLinksCommand(slug, options);
  });

program
  .command('recommend')
  .description('The heart of the compile loop — what to link, tag, and write next')
  .argument('<slug>', 'Note slug')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((slug: string, options: { json?: boolean }) => {
    recommendCommand(slug, options);
  });

// ─── Lint ─────────────────────────────────────────────────────────────

program
  .command('doctor')
  .description('Health-check the vault — broken links, missing fields, line limit violations')
  .option('--json', 'Output as JSON')
  .action((options: { json?: boolean }) => {
    doctorCommand(options);
  });

program
  .command('types')
  .description('See the note types and the natural flow: source → note → synthesis → output')
  .action(() => {
    typesCommand();
  });

program
  .command('attach <file>')
  .description('Attach a file (image, video, PDF) to the vault and get markdown embed syntax')
  .option('--slug <slug>', 'Note slug to suggest appending to')
  .option('--json', 'Output as JSON')
  .action((file: string, options: { slug?: string; json?: boolean }) => {
    attachCommand(file, options);
  });

program
  .command('extract <file>')
  .description('Extract raw text from a local document without importing it. Does not clean or summarize the document.')
  .option('--json', 'Output as JSON')
  .action(async (file: string, options: { json?: boolean }) => {
    await extractDocumentCommand(file, options);
  });

program
  .command('import <file>')
  .description('Import a document as a source note plus linked asset, with required caller-provided content. Does not read or clean the document.')
  .requiredOption('--content <content>', 'Caller-provided document text to store in the source note')
  .option('--title <title>', 'Explicit note title. Defaults to a title derived from the filename')
  .option('--tag <tags>', 'Add tags immediately (comma-separated)')
  .option('--alias <aliases>', 'Add aliases immediately (comma-separated)')
  .option('--json', 'Output as JSON')
  .action((file: string, options: { content: string; title?: string; tag?: string; alias?: string; json?: boolean }) => {
    importDocumentCommand(file, options);
  });

program
  .command('wakeup')
  .description('Generate a compressed AAAK snapshot of the vault for LLM context loading')
  .option('--json', 'Output as JSON (includes structured data + AAAK)')
  .action((options: { json?: boolean }) => {
    wakeupCommand(options);
  });

// ─── Serve ────────────────────────────────────────────────────────────

program
  .command('serve')
  .description('Start the local web UI — browse, search, and visualize the knowledge graph')
  .option('-p, --port <port>', 'Port number', '4321')
  .action((options: { port: string }) => {
    serveCommand(options);
  });

const mcpCmd = program
  .command('mcp')
  .description('Start Granite as an MCP server')
  .option('--vault <path>', 'Vault root. Defaults to the current Granite vault or $GRANITE_VAULT')
  .option('--transport <transport>', 'Transport to use: stdio or http', parseTransportOption, 'stdio')
  .option('--host <host>', 'Host for HTTP transport', '127.0.0.1')
  .option('--port <port>', 'Port for HTTP transport', '3321')
  .option('--allow-origin <origin>', 'Allow an HTTP Origin for browser-based HTTP clients', collectValues, [])
  .option('--json-response', 'Prefer JSON HTTP responses instead of SSE streams')
  .option('--tunnel <provider>', 'Expose MCP over internet via tunnel (cloudflare or tailscale)')
  .option('--background', 'Run MCP server as a background daemon')
  .action(async (options: {
    vault?: string;
    transport?: 'stdio' | 'http';
    host?: string;
    port?: string;
    allowOrigin?: string[];
    jsonResponse?: boolean;
    tunnel?: 'cloudflare' | 'tailscale';
    background?: boolean;
  }) => {
    await mcpCommand(options);
  });

mcpCmd
  .command('stop')
  .description('Stop a background MCP server')
  .option('--vault <path>', 'Vault root')
  .action((options: { vault?: string }) => {
    mcpStopCommand(options);
  });

mcpCmd
  .command('status')
  .description('Show status of background MCP server')
  .option('--vault <path>', 'Vault root')
  .action((options: { vault?: string }) => {
    mcpStatusCommand(options);
  });

await program.parseAsync();

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseTransportOption(value: string): 'stdio' | 'http' {
  try {
    return parseTransport(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}
