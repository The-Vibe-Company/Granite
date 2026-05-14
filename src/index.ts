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
import {
  daemonCommand,
  daemonStartCommand,
  daemonStopCommand,
  daemonStatusCommand,
  daemonLogsCommand,
} from './commands/daemon.js';
import { wakeupCommand } from './commands/wakeup.js';
import { attachCommand } from './commands/attach.js';
import { extractDocumentCommand } from './commands/extract.js';
import { importDocumentCommand } from './commands/import.js';
import {
  cloudAddCommand,
  cloudBillingCommand,
  cloudCreateCommand,
  cloudEditCommand,
  cloudImportCommand,
  cloudKeysCommand,
  cloudListCommand,
  cloudLoginCommand,
  cloudLogoutCommand,
  cloudCreateKeyCommand,
  cloudMcpUrlCommand,
  cloudMcpConfigCommand,
  cloudNewCommand,
  cloudRevokeKeyCommand,
  cloudSearchCommand,
  cloudShowCommand,
  cloudStatusCommand,
  cloudVaultsCommand,
} from './commands/cloud.js';
import { parseCloudTarget } from './core/cloud-target.js';
import { GRANITE_VERSION } from './version.js';

const program = new Command();

program
  .name('granite')
  .description('Granite — a local-first knowledge compiler. capture → compile → query → output → lint')
  .version(GRANITE_VERSION)
  .option('--vault <target>', 'Vault target: local path, cloud, or cloud:<vault_id>');

// ─── Setup ────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Create a new vault and start the knowledge loop')
  .option('--template <name>', 'Start from a template (e.g. founder-os)')
  .action((options: { template?: string }) => {
    const target = selectedVaultTarget();
    if (parseCloudTarget(target)) {
      console.error('granite init does not support cloud vaults.');
      process.exit(1);
    }
    initVault(target, { template: options.template });
  });

program
  .command('status')
  .description('See where your vault stands and what to do next')
  .option('--json', 'Output as JSON')
  .action((options: { json?: boolean }) => {
    rejectCloudTarget('status');
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
  .action(async (title: string, options: { type?: string; source?: string; status?: string; reviewState?: string; durability?: string; derivedFrom?: string; json?: boolean }) => {
    const cloud = currentCloudTarget();
    if (cloud) {
      await cloudNewCommand(title, options, cloud.vaultId);
      return;
    }
    newNote(title, options);
  });

program
  .command('add')
  .description('Quick-capture raw text into the vault — the fastest way to get something in')
  .argument('[text]', 'Note text (or pipe via stdin)')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action(async (text: string | undefined, options: { json?: boolean }) => {
    const cloud = currentCloudTarget();
    if (cloud) {
      await cloudAddCommand(text, options, cloud.vaultId);
      return;
    }
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
  .action(async (options: { type?: string; status?: string; source?: string; since?: string; json?: boolean | string }) => {
    const cloud = currentCloudTarget();
    if (cloud) {
      await cloudListCommand(options, cloud.vaultId);
      return;
    }
    listCommand(options);
  });

program
  .command('show')
  .alias('cat')
  .description('Read a note in full — frontmatter, body, and metadata')
  .argument('<slug>', 'Note slug')
  .option('--json', 'Output as JSON (agent-friendly)')
  .option('--body', 'Output body only (for piping)')
  .action(async (slug: string, options: { json?: boolean; body?: boolean }) => {
    const cloud = currentCloudTarget();
    if (cloud) {
      await cloudShowCommand(slug, options, cloud.vaultId);
      return;
    }
    showCommand(slug, options);
  });

program
  .command('search')
  .description('Research a topic across the vault — use before creating to avoid duplicates')
  .argument('<query>', 'Search query')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action(async (query: string, options: { json?: boolean }) => {
    const cloud = currentCloudTarget();
    if (cloud) {
      await cloudSearchCommand(query, options, cloud.vaultId);
      return;
    }
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
  .action(async (slug: string, options: { body?: string; append?: string; title?: string; tag?: string; alias?: string; status?: string; source?: string; reviewState?: string; durability?: string; derivedFrom?: string }) => {
    const cloud = currentCloudTarget();
    if (cloud) {
      await cloudEditCommand(slug, options, cloud.vaultId);
      return;
    }
    editCommand(slug, options);
  });

program
  .command('open')
  .description('Open a note in your editor')
  .argument('<slug>', 'Note slug')
  .action((slug: string) => {
    rejectCloudTarget('open');
    openNote(slug);
  });

program
  .command('backlinks')
  .description("See a note's role in the graph — who links here and why")
  .argument('<slug>', 'Note slug')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((slug: string, options: { json?: boolean }) => {
    rejectCloudTarget('backlinks');
    backlinksCommand(slug, options);
  });

program
  .command('suggest-links')
  .description('Find unlinked mentions — strengthen the graph by adding missed [[wikilinks]]')
  .argument('<slug>', 'Note slug')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((slug: string, options: { json?: boolean }) => {
    rejectCloudTarget('suggest-links');
    suggestLinksCommand(slug, options);
  });

program
  .command('recommend')
  .description('The heart of the compile loop — what to link, tag, and write next')
  .argument('<slug>', 'Note slug')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((slug: string, options: { json?: boolean }) => {
    rejectCloudTarget('recommend');
    recommendCommand(slug, options);
  });

// ─── Lint ─────────────────────────────────────────────────────────────

program
  .command('doctor')
  .description('Health-check the vault — broken links, missing fields, line limit violations')
  .option('--json', 'Output as JSON')
  .action((options: { json?: boolean }) => {
    rejectCloudTarget('doctor');
    doctorCommand(options);
  });

program
  .command('types')
  .description('See the note types and the natural flow: source → note → synthesis → output')
  .action(() => {
    rejectCloudTarget('types');
    typesCommand();
  });

program
  .command('attach <file>')
  .description('Attach a file (image, video, PDF) to the vault and get markdown embed syntax')
  .option('--slug <slug>', 'Note slug to suggest appending to')
  .option('--json', 'Output as JSON')
  .action((file: string, options: { slug?: string; json?: boolean }) => {
    rejectCloudTarget('attach');
    attachCommand(file, options);
  });

program
  .command('extract <file>')
  .description('Extract raw text from a local document without importing it. Does not clean or summarize the document.')
  .option('--json', 'Output as JSON')
  .action(async (file: string, options: { json?: boolean }) => {
    rejectCloudTarget('extract');
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
    rejectCloudTarget('import');
    importDocumentCommand(file, options);
  });

program
  .command('wakeup')
  .description('Generate a compressed AAAK snapshot of the vault for LLM context loading')
  .option('--json', 'Output as JSON (includes structured data + AAAK)')
  .action((options: { json?: boolean }) => {
    rejectCloudTarget('wakeup');
    wakeupCommand(options);
  });

// ─── Serve ────────────────────────────────────────────────────────────

program
  .command('serve')
  .description('Start the local web UI — browse, search, and visualize the knowledge graph')
  .option('-p, --port <port>', 'Port number', '4321')
  .action((options: { port: string }) => {
    rejectCloudTarget('serve');
    serveCommand(options);
  });

const cloudCmd = program
  .command('cloud')
  .description('Configure and operate Granite Cloud vaults');

cloudCmd
  .command('login')
  .description('Store Granite Cloud API credentials for CLI use')
  .option('--api-key <key>', 'Granite Cloud API key. If omitted, opens the browser login flow.')
  .option('--base-url <url>', 'Granite Cloud base URL')
  .option('--vault <vault_id>', 'Default cloud vault ID')
  .option('--no-browser', 'Print the login URL without opening a browser')
  .action(async (options: { apiKey?: string; baseUrl?: string; vault?: string; browser?: boolean; noBrowser?: boolean }) => {
    await cloudLoginCommand({
      ...options,
      vault: options.vault ?? cloudSubcommandVaultId(),
      noBrowser: options.noBrowser === true || options.browser === false,
    });
  });

cloudCmd
  .command('logout')
  .description('Remove stored Granite Cloud credentials')
  .action(() => {
    cloudLogoutCommand();
  });

cloudCmd
  .command('status')
  .description('Show Granite Cloud configuration')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    await cloudStatusCommand(options);
  });

cloudCmd
  .command('vaults')
  .description('List cloud vaults')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    await cloudVaultsCommand(options);
  });

cloudCmd
  .command('keys')
  .description('List Granite Cloud API keys')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    await cloudKeysCommand(options);
  });

cloudCmd
  .command('key-create')
  .description('Create a Granite Cloud API key')
  .option('--name <name>', 'API key name')
  .option('--json', 'Output as JSON')
  .action(async (options: { name?: string; json?: boolean }) => {
    await cloudCreateKeyCommand(options);
  });

cloudCmd
  .command('key-revoke')
  .description('Revoke a Granite Cloud API key by prefix')
  .argument('<prefix>', 'API key prefix, e.g. gsk_...')
  .option('--json', 'Output as JSON')
  .action(async (prefix: string, options: { json?: boolean }) => {
    await cloudRevokeKeyCommand(prefix, options);
  });

cloudCmd
  .command('create')
  .description('Create a cloud vault and set it as default')
  .option('--name <name>', 'Vault name')
  .option('--json', 'Output as JSON')
  .action(async (options: { name?: string; json?: boolean }) => {
    await cloudCreateCommand(options);
  });

cloudCmd
  .command('billing')
  .description('Open the Granite Cloud Stripe billing portal')
  .option('--json', 'Output as JSON')
  .option('--no-browser', 'Print the portal URL without opening a browser')
  .action(async (options: { json?: boolean; noBrowser?: boolean }) => {
    await cloudBillingCommand(options);
  });

cloudCmd
  .command('import')
  .description('One-shot import a local vault into a cloud vault')
  .option('--from <path>', 'Local vault root. Defaults to current directory')
  .option('--name <name>', 'Cloud vault name when creating a new vault')
  .option('--vault <vault_id>', 'Import into an existing cloud vault')
  .option('--json', 'Output as JSON')
  .action(async (options: { from?: string; name?: string; vault?: string; json?: boolean }) => {
    await cloudImportCommand({
      ...options,
      vault: options.vault ?? cloudSubcommandVaultId(),
    });
  });

cloudCmd
  .command('mcp-url')
  .description('Print the hosted MCP endpoint URL')
  .option('--vault <vault_id>', 'Cloud vault ID')
  .action((options: { vault?: string }) => {
    cloudMcpUrlCommand(options.vault ?? cloudSubcommandVaultId());
  });

cloudCmd
  .command('mcp-config')
  .description('Print a client MCP configuration snippet with URL and Authorization header')
  .option('--client <name>', 'Client name: generic, cursor, claude', 'generic')
  .option('--vault <vault_id>', 'Cloud vault ID')
  .option('--json', 'Output as JSON')
  .action((options: { client?: string; vault?: string; json?: boolean }) => {
    cloudMcpConfigCommand({
      ...options,
      vault: options.vault ?? cloudSubcommandVaultId(),
    });
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
    const target = options.vault === undefined
      ? currentCloudTarget()
      : parseCloudTarget(options.vault);
    if (target) {
      cloudMcpUrlCommand(target.vaultId);
      return;
    }
    await mcpCommand(options);
  });

mcpCmd
  .command('stop')
  .description('Stop a background MCP server')
  .option('--vault <path>', 'Vault root')
  .action((options: { vault?: string }) => {
    prepareLocalOnlyCommand('mcp stop', options.vault);
    mcpStopCommand(options);
  });

mcpCmd
  .command('status')
  .description('Show status of background MCP server')
  .option('--vault <path>', 'Vault root')
  .action((options: { vault?: string }) => {
    prepareLocalOnlyCommand('mcp status', options.vault);
    mcpStatusCommand(options);
  });

// ─── Daemon ────────────────────────────────────────────────────────────
// One background service exposing both MCP (HTTP) and the web UI.

const daemonCmd = program
  .command('daemon')
  .description('Run Granite as a background service (MCP + web UI in one process)')
  .option('--vault <path>', 'Vault root. Defaults to the current Granite vault or $GRANITE_VAULT')
  .option('--host <host>', 'Host both servers bind to', '127.0.0.1')
  .option('--mcp-port <port>', 'MCP HTTP port', '3321')
  .option('--web-port <port>', 'Web UI port', '4321')
  .action(async (options: { vault?: string }) => {
    prepareLocalOnlyCommand('daemon', options.vault);
    await daemonCommand(options);
  });

daemonCmd
  .command('start')
  .description('Start the daemon in the background')
  .option('--vault <path>', 'Vault root')
  .option('--host <host>', 'Host both servers bind to', '127.0.0.1')
  .option('--mcp-port <port>', 'MCP HTTP port', '3321')
  .option('--web-port <port>', 'Web UI port', '4321')
  .action((options: { vault?: string }) => {
    prepareLocalOnlyCommand('daemon start', options.vault);
    daemonStartCommand(options);
  });

daemonCmd
  .command('stop')
  .description('Stop the background daemon')
  .option('--vault <path>', 'Vault root')
  .action((options: { vault?: string }) => {
    prepareLocalOnlyCommand('daemon stop', options.vault);
    daemonStopCommand(options);
  });

daemonCmd
  .command('status')
  .description('Show status of the background daemon')
  .option('--vault <path>', 'Vault root')
  .action((options: { vault?: string }) => {
    prepareLocalOnlyCommand('daemon status', options.vault);
    daemonStatusCommand(options);
  });

daemonCmd
  .command('logs')
  .description('Tail the daemon log file')
  .option('--vault <path>', 'Vault root')
  .option('-n, --lines <count>', 'Number of tail lines', '100')
  .action((options: { vault?: string; lines?: string }) => {
    prepareLocalOnlyCommand('daemon logs', options.vault);
    daemonLogsCommand(options);
  });

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

function selectedVaultTarget(): string | undefined {
  const target = program.opts<{ vault?: string }>().vault;
  if (target && !parseCloudTarget(target)) {
    process.env.GRANITE_VAULT = target;
  }
  return target;
}

function cloudSubcommandOptionValue(name: string): string | undefined {
  const cloudIndex = process.argv.indexOf('cloud');
  if (cloudIndex < 0) return undefined;
  const longOption = `--${name}`;
  for (let index = cloudIndex + 1; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === longOption) return process.argv[index + 1];
    if (arg.startsWith(`${longOption}=`)) return arg.slice(longOption.length + 1);
  }
  return undefined;
}

function cloudSubcommandVaultId(): string | undefined {
  const localVault = cloudSubcommandOptionValue('vault');
  if (localVault) return localVault;
  return parseCloudTarget(program.opts<{ vault?: string }>().vault)?.vaultId;
}

function currentCloudTarget(): ReturnType<typeof parseCloudTarget> {
  return parseCloudTarget(selectedVaultTarget());
}

function rejectCloudTarget(command: string): void {
  if (currentCloudTarget()) {
    console.error(`granite ${command} does not support cloud vaults yet.`);
    process.exit(1);
  }
}

function prepareLocalOnlyCommand(command: string, explicitVault?: string): void {
  if (explicitVault !== undefined) {
    if (parseCloudTarget(explicitVault)) {
      console.error(`granite ${command} does not support cloud vaults yet.`);
      process.exit(1);
    }
    return;
  }
  rejectCloudTarget(command);
}

try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
