import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig } from '../core/config.js';
import { requireVaultRoot, getGraniteDir } from '../core/vault.js';
import { startGraniteMcpHttpServer } from '../mcp/server.js';
import { GraniteMcpRuntime } from '../mcp/runtime.js';
import { startServer as startWebServer } from '../web/server.js';

// ---- Types ----------------------------------------------------------------

export interface DaemonCommandOptions {
  vault?: string;
  mcpPort?: string;
  webPort?: string;
  host?: string;
}

interface DaemonState {
  pid: number;
  vault: string;
  mcp_url: string;
  web_url: string;
  started_at: string;
}

// ---- PID / state file helpers --------------------------------------------

function pidPath(vaultRoot: string): string {
  return path.join(getGraniteDir(vaultRoot), 'daemon.pid');
}

function statePath(vaultRoot: string): string {
  return path.join(getGraniteDir(vaultRoot), 'daemon.state.json');
}

function logPath(vaultRoot: string): string {
  return path.join(getGraniteDir(vaultRoot), 'daemon.log');
}

function ensureGraniteDir(vaultRoot: string): void {
  fs.mkdirSync(getGraniteDir(vaultRoot), { recursive: true });
}

function readPid(vaultRoot: string): number | null {
  try {
    const raw = fs.readFileSync(pidPath(vaultRoot), 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isNaN(pid)) return null;
    try { process.kill(pid, 0); return pid; } catch { return null; }
  } catch {
    return null;
  }
}

function readState(vaultRoot: string): DaemonState | null {
  try {
    const raw = fs.readFileSync(statePath(vaultRoot), 'utf-8');
    return JSON.parse(raw) as DaemonState;
  } catch {
    return null;
  }
}

function writeState(vaultRoot: string, state: DaemonState): void {
  ensureGraniteDir(vaultRoot);
  fs.writeFileSync(pidPath(vaultRoot), String(state.pid), 'utf-8');
  fs.writeFileSync(statePath(vaultRoot), JSON.stringify(state, null, 2), 'utf-8');
}

function cleanupFiles(vaultRoot: string): void {
  try { fs.unlinkSync(pidPath(vaultRoot)); } catch {}
  try { fs.unlinkSync(statePath(vaultRoot)); } catch {}
}

function parsePort(value: string | undefined, fallback: number): number {
  const raw = (value ?? '').trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid port: ${raw}`);
  const parsed = Number.parseInt(raw, 10);
  if (parsed <= 0 || parsed > 65535) throw new Error(`Invalid port: ${raw}`);
  return parsed;
}

function resolveVaultRoot(explicitVault?: string): string {
  const fromEnv = process.env.GRANITE_VAULT;
  if (explicitVault) return path.resolve(explicitVault);
  if (fromEnv) return path.resolve(fromEnv);
  return requireVaultRoot();
}

// ---- Commands -------------------------------------------------------------

/**
 * Run the daemon in the foreground (or, if GRANITE_DAEMONIZED=1, inside the
 * detached child process). Starts both MCP (HTTP) and the web site.
 */
export async function daemonCommand(options: DaemonCommandOptions): Promise<void> {
  const vaultRoot = resolveVaultRoot(options.vault);
  const config = loadConfig(vaultRoot);
  const host = options.host ?? '127.0.0.1';
  const mcpPort = parsePort(options.mcpPort ?? process.env.MCP_PORT, 3321);
  const webPort = parsePort(options.webPort ?? process.env.PORT, 4321);
  const isDaemon = process.env.GRANITE_DAEMONIZED === '1';

  const runtime = new GraniteMcpRuntime(vaultRoot);
  const mcpUrl = `http://${host}:${mcpPort}/mcp`;
  const webUrl = `http://${host}:${webPort}`;

  const shutdown = () => {
    try { runtime.close(); } catch {}
    if (isDaemon) cleanupFiles(vaultRoot);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // MCP HTTP
  startGraniteMcpHttpServer(runtime, { host, port: mcpPort, allowedOrigins: [], jsonResponse: false });

  // Web
  startWebServer(vaultRoot, config, webPort);

  if (isDaemon) {
    writeState(vaultRoot, {
      pid: process.pid,
      vault: vaultRoot,
      mcp_url: mcpUrl,
      web_url: webUrl,
      started_at: new Date().toISOString(),
    });
  }

  console.error(`\nGranite daemon running`);
  console.error(`  Vault: ${vaultRoot}`);
  console.error(`  MCP:   ${mcpUrl}`);
  console.error(`  Web:   ${webUrl}`);
}

/**
 * Spawn the daemon as a detached background process and return immediately.
 */
export function daemonStartCommand(options: DaemonCommandOptions): void {
  // Guard: inside the detached child, GRANITE_DAEMONIZED is set. If we
  // somehow re-enter `start` there, bail instead of forking again.
  if (process.env.GRANITE_DAEMONIZED === '1') return;

  const vaultRoot = resolveVaultRoot(options.vault);
  const running = readPid(vaultRoot);
  if (running) {
    const state = readState(vaultRoot);
    console.error(`Granite daemon already running (PID ${running}).`);
    if (state) {
      console.error(`  MCP: ${state.mcp_url}`);
      console.error(`  Web: ${state.web_url}`);
    }
    console.error(`Use "granite daemon stop" first if you want to restart.`);
    process.exit(1);
  }

  ensureGraniteDir(vaultRoot);
  const logFile = logPath(vaultRoot);
  const fd = fs.openSync(logFile, 'a');

  // Rewrite argv so the child runs the FOREGROUND daemon (not `start` again).
  // Remove just the "start" token; keep every option around it — the parent
  // `daemon` command accepts the same ports/host flags.
  const origArgs = process.argv.slice(1);
  const startIdx = origArgs.findIndex(a => a === 'start');
  const childArgs = startIdx >= 0
    ? [...origArgs.slice(0, startIdx), ...origArgs.slice(startIdx + 1)]
    : origArgs;

  // In dev (`npx tsx src/index.ts …`), argv[1] is a .ts file that node alone
  // can't execute. We preserve the same runner by spawning `npx tsx` instead
  // of process.execPath. In prod (compiled dist/index.js), just use node.
  const runningTs = /\.ts$/.test(process.argv[1] ?? '');
  const runner = runningTs ? 'npx' : process.execPath;
  const runnerArgs = runningTs ? ['tsx', ...childArgs] : childArgs;

  const child = spawn(runner, runnerArgs, {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, GRANITE_DAEMONIZED: '1', GRANITE_VAULT: vaultRoot },
  });

  child.unref();
  fs.closeSync(fd);

  if (!child.pid) {
    console.error('Failed to start daemon.');
    process.exit(1);
  }

  console.error(`Granite daemon starting (PID ${child.pid}).`);
  console.error(`  Log: ${logFile}`);
  console.error(`  Stop with: granite daemon stop`);
  console.error(`  Status:    granite daemon status`);
  process.exit(0);
}

export function daemonStopCommand(options: { vault?: string }): void {
  const vaultRoot = resolveVaultRoot(options.vault);
  const pid = readPid(vaultRoot);
  if (!pid) {
    console.error('Granite daemon is not running.');
    process.exit(1);
  }
  process.kill(pid, 'SIGTERM');
  cleanupFiles(vaultRoot);
  console.error(`Granite daemon stopped (PID ${pid}).`);
}

export function daemonStatusCommand(options: { vault?: string }): void {
  const vaultRoot = resolveVaultRoot(options.vault);
  const pid = readPid(vaultRoot);
  if (!pid) {
    console.error('Granite daemon is not running.');
    process.exit(1);
  }
  const state = readState(vaultRoot);
  console.error(`Granite daemon running (PID ${pid})`);
  if (state) {
    console.error(`  Vault:   ${state.vault}`);
    console.error(`  MCP:     ${state.mcp_url}`);
    console.error(`  Web:     ${state.web_url}`);
    console.error(`  Started: ${state.started_at}`);
  }
  console.error(`  Log:     ${logPath(vaultRoot)}`);
}

export function daemonLogsCommand(options: { vault?: string; lines?: string }): void {
  const vaultRoot = resolveVaultRoot(options.vault);
  const lf = logPath(vaultRoot);
  if (!fs.existsSync(lf)) {
    console.error('No log file yet.');
    process.exit(1);
  }
  const n = Math.max(1, parseInt(options.lines ?? '100', 10) || 100);
  const raw = fs.readFileSync(lf, 'utf-8');
  const lines = raw.split('\n');
  const tail = lines.slice(Math.max(0, lines.length - n)).join('\n');
  process.stdout.write(tail);
}
