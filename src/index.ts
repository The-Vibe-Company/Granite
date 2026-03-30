import { Command } from 'commander';
import { initVault } from './commands/init.js';
import { newNote } from './commands/new.js';
import { addNote } from './commands/add.js';
import { openNote } from './commands/open.js';
import { searchCommand } from './commands/search.js';
import { backlinksCommand } from './commands/backlinks.js';
import { suggestLinksCommand } from './commands/suggest-links.js';
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
  .description('Initialize a new vault in the current directory')
  .action(() => {
    initVault(process.cwd());
  });

program
  .command('new')
  .description('Create a new note')
  .argument('<title>', 'Note title')
  .option('-t, --type <type>', 'Note type (e.g. fleeting, permanent, reference)')
  .action((title: string, options: { type?: string }) => {
    newNote(title, options.type);
  });

program
  .command('add')
  .description('Quick-capture a fleeting note (reads stdin if no text given)')
  .argument('[text]', 'Note text (or pipe via stdin)')
  .action((text?: string) => {
    addNote(text);
  });

program
  .command('list')
  .alias('ls')
  .description('List notes')
  .option('-t, --type <type>', 'Filter by note type')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((options: { type?: string; json?: boolean }) => {
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
  .action((slug: string, options: { body?: string; append?: string; title?: string; tag?: string }) => {
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
  .command('search')
  .description('Full-text search across notes')
  .argument('<query>', 'Search query')
  .action((query: string) => {
    searchCommand(query);
  });

program
  .command('backlinks')
  .description('Show notes that link to a given note')
  .argument('<slug>', 'Note slug')
  .action((slug: string) => {
    backlinksCommand(slug);
  });

program
  .command('suggest-links')
  .description('Suggest wikilinks based on unlinked mentions')
  .argument('<slug>', 'Note slug')
  .action((slug: string) => {
    suggestLinksCommand(slug);
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
