import { Command } from 'commander';
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

const program = new Command();

program
  .name('mem')
  .description('Granite — a local-first markdown memory system')
  .version('0.1.0');

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
  .option('-t, --type <type>', 'Note type (e.g. fleeting, permanent, reference)')
  .option('--source <source>', 'Set source (human, agent, extraction)')
  .option('--status <status>', 'Set status (inbox, active, archived)')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((title: string, options: { type?: string; source?: string; status?: string; json?: boolean }) => {
    newNote(title, options);
  });

program
  .command('add')
  .description('Quick-capture a fleeting note (reads stdin if no text given)')
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
  .action((slug: string, options: { body?: string; append?: string; title?: string; tag?: string; alias?: string; status?: string; source?: string }) => {
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

program.parse();
