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
import { mcpCommand, parseTransport } from './commands/mcp.js';
import { GRANITE_VERSION } from './version.js';

const program = new Command();

program
  .name('granite')
  .description('Granite — a local-first markdown memory system')
  .version(GRANITE_VERSION);

program
  .command('init')
  .description('Initialize the default vault in ~/.granite')
  .action(() => {
    initVault();
  });

program
  .command('new')
  .description('Create a new note')
  .argument('<title>', 'Note title')
  .option('-t, --type <type>', 'Note type (e.g. note, source, synthesis, output)')
  .option('--source <source>', 'Set source (human, agent, extraction)')
  .option('--status <status>', 'Set status (inbox, active, archived)')
  .option('--review-state <state>', 'Set review state (draft, reviewed, locked)')
  .option('--durability <durability>', 'Set durability (canonical, working, ephemeral)')
  .option('--derived-from <refs>', 'Set derived_from references (comma-separated note IDs or slugs)')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((title: string, options: { type?: string; source?: string; status?: string; reviewState?: string; durability?: string; derivedFrom?: string; json?: boolean }) => {
    newNote(title, options);
  });

program
  .command('add')
  .description('Quick-capture a note using the default note type (reads stdin if no text given)')
  .argument('[text]', 'Note text (or pipe via stdin)')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((text: string | undefined, options: { json?: boolean }) => {
    addNote(text, options);
  });

program
  .command('list')
  .alias('ls')
  .description('List notes')
  .option('-t, --type <type>', 'Filter by note type')
  .option('-s, --status <status>', 'Filter by status (inbox, active, archived)')
  .option('--source <source>', 'Filter by source (human, agent, extraction)')
  .option('--since <date>', 'Filter notes modified since date (YYYY-MM-DD)')
  .option('--json [fields]', 'Output as JSON; optionally specify fields (e.g. --json slug,title,type)')
  .action((options: { type?: string; status?: string; source?: string; since?: string; json?: boolean | string }) => {
    listCommand(options);
  });

program
  .command('edit')
  .description('Edit a note (opens $EDITOR, or use flags for programmatic edits)')
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
  .option('--derived-from <refs>', 'Set derived_from references (comma-separated note IDs or slugs)')
  .action((slug: string, options: { body?: string; append?: string; title?: string; tag?: string; alias?: string; status?: string; source?: string; reviewState?: string; durability?: string; derivedFrom?: string }) => {
    editCommand(slug, options);
  });

program
  .command('open')
  .description('Open a note in your editor (alias for edit)')
  .argument('<slug>', 'Note slug')
  .action((slug: string) => {
    openNote(slug);
  });

program
  .command('show')
  .alias('cat')
  .description('Display a note by slug')
  .argument('<slug>', 'Note slug')
  .option('--json', 'Output as JSON (agent-friendly)')
  .option('--body', 'Output body only (no frontmatter)')
  .action((slug: string, options: { json?: boolean; body?: boolean }) => {
    showCommand(slug, options);
  });

program
  .command('search')
  .description('Full-text search across notes')
  .argument('<query>', 'Search query')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((query: string, options: { json?: boolean }) => {
    searchCommand(query, options);
  });

program
  .command('backlinks')
  .description('Show notes that link to a given note')
  .argument('<slug>', 'Note slug')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((slug: string, options: { json?: boolean }) => {
    backlinksCommand(slug, options);
  });

program
  .command('suggest-links')
  .description('Suggest wikilinks based on unlinked mentions')
  .argument('<slug>', 'Note slug')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((slug: string, options: { json?: boolean }) => {
    suggestLinksCommand(slug, options);
  });

program
  .command('recommend')
  .description('Suggest links, tags, and the next note to create')
  .argument('<slug>', 'Note slug')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((slug: string, options: { json?: boolean }) => {
    recommendCommand(slug, options);
  });

program
  .command('types')
  .description('List available note types')
  .action(() => {
    typesCommand();
  });

program
  .command('doctor')
  .description('Validate vault health')
  .action(() => {
    doctorCommand();
  });

program
  .command('serve')
  .description('Start the local web UI')
  .option('-p, --port <port>', 'Port number', '4321')
  .action((options: { port: string }) => {
    serveCommand(options);
  });

program
  .command('mcp')
  .description('Start Granite as an MCP server')
  .option('--vault <path>', 'Vault root. Defaults to the current Granite vault or $GRANITE_VAULT')
  .option('--transport <transport>', 'Transport to use: stdio or http', parseTransportOption, 'stdio')
  .option('--host <host>', 'Host for HTTP transport', '127.0.0.1')
  .option('--port <port>', 'Port for HTTP transport', '3321')
  .option('--allow-origin <origin>', 'Allow an HTTP Origin for browser-based HTTP clients', collectValues, [])
  .option('--json-response', 'Prefer JSON HTTP responses instead of SSE streams')
  .action(async (options: {
    vault?: string;
    transport?: 'stdio' | 'http';
    host?: string;
    port?: string;
    allowOrigin?: string[];
    jsonResponse?: boolean;
  }) => {
    await mcpCommand(options);
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
