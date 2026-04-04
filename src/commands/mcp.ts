import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { requireVaultRoot, getGraniteDir } from '../core/vault.js';
import { startGraniteMcpHttpServer, startGraniteMcpStdioServer } from '../mcp/server.js';
import { GraniteMcpRuntime } from '../mcp/runtime.js';
import { startTunnel, stopTunnel, type TunnelProvider } from '../tunnel.js';

interface McpCommandOptions {
  vault?: string;
  transport?: 'stdio' | 'http';
  host?: string;
  port?: string;
  allowOrigin?: string[];
  jsonResponse?: boolean;
  tunnel?: TunnelProvider;
  background?: boolean;
}

// ---- PID / URL file helpers ------------------------------------------------

function pidPath(vaultRoot: string): string {
  return path.join(getGraniteDir(vaultRoot), 'mcp.pid');
}

function urlPath(vaultRoot: string): string {
  return path.join(getGraniteDir(vaultRoot), 'mcp.url');
}

function ensureGraniteDir(vaultRoot: string): void {
  fs.mkdirSync(getGraniteDir(vaultRoot), { recursive: true });
}

function readPid(vaultRoot: string): number | null {
  try {
    const raw = fs.readFileSync(pidPath(vaultRoot), 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isNaN(pid)) return null;
    // signal 0 probes liveness without actually sending a signal
    try { process.kill(pid, 0); return pid; } catch { return null; }
  } catch {
    return null;
  }
}

function writeDaemonState(vaultRoot: string, pid: number, url: string): void {
  ensureGraniteDir(vaultRoot);
  fs.writeFileSync(pidPath(vaultRoot), String(pid), 'utf-8');
  fs.writeFileSync(urlPath(vaultRoot), url, 'utf-8');
}

function cleanupFiles(vaultRoot: string): void {
  try { fs.unlinkSync(pidPath(vaultRoot)); } catch {}
  try { fs.unlinkSync(urlPath(vaultRoot)); } catch {}
}

// ---- Commands --------------------------------------------------------------

export async function mcpCommand(options: McpCommandOptions): Promise<void> {
  const tunnel = options.tunnel;
  const transport = tunnel ? 'http' : parseTransport(options.transport);
  const vaultRoot = resolveVaultRoot(options.vault);

  // --background: re-spawn ourselves as a detached child
  if (options.background) {
    if (transport !== 'http') {
      console.error('--background requires --transport http or --tunnel');
      process.exit(1);
    }

    const running = readPid(vaultRoot);
    if (running) {
      console.error(`MCP server already running (PID ${running}). Use "granite mcp stop" first.`);
      process.exit(1);
    }

    // Use env var to detect daemon mode — avoids fragile argv stripping
    const logFile = path.join(getGraniteDir(vaultRoot), 'mcp.log');
    ensureGraniteDir(vaultRoot);
    const fd = fs.openSync(logFile, 'a');

    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, GRANITE_MCP_DAEMONIZED: '1' },
    });

    child.unref();
    fs.closeSync(fd);

    if (!child.pid) {
      console.error('Failed to start background process');
      process.exit(1);
    }

    writeDaemonState(vaultRoot, child.pid, '(starting...)');
    console.error(`MCP server starting in background (PID ${child.pid})`);
    console.error(`Log: ${logFile}`);
    console.error(`Stop with: granite mcp stop`);
    process.exit(0);
  }

  // In daemon mode, --background flag is still in argv but we skip it via env var
  const isDaemon = process.env.GRANITE_MCP_DAEMONIZED === '1';
  const runtime = new GraniteMcpRuntime(vaultRoot);
  let tunnelProcess: import('node:child_process').ChildProcess | null = null;

  const shutdown = () => {
    if (tunnelProcess) stopTunnel(tunnelProcess);
    if (isDaemon) cleanupFiles(vaultRoot);
    runtime.close();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  if (transport === 'http') {
    const port = parsePort(options.port);
    const host = options.host ?? '127.0.0.1';
    const localUrl = `http://${host}:${port}/mcp`;

    startGraniteMcpHttpServer(runtime, {
      host,
      port,
      allowedOrigins: options.allowOrigin ?? [],
      jsonResponse: options.jsonResponse ?? false,
    });

    if (isDaemon) writeDaemonState(vaultRoot, process.pid, localUrl);

    if (tunnel) {
      try {
        console.error(`\nStarting ${tunnel} tunnel...`);
        const result = await startTunnel({ provider: tunnel, port, host });
        tunnelProcess = result.process;
        const publicMcpUrl = `${result.url}/mcp`;
        console.error(`\n🚇 Tunnel active!\n`);
        console.error(`  Public MCP endpoint: ${publicMcpUrl}`);
        console.error(`  Provider: ${tunnel}`);
        console.error(`\nUse this URL in your remote MCP client configuration.\n`);

        if (isDaemon) writeDaemonState(vaultRoot, process.pid, publicMcpUrl);
      } catch (err) {
        console.error(`\nFailed to start tunnel: ${err instanceof Error ? err.message : err}`);
        shutdown();
      }
    }

    return;
  }

  await startGraniteMcpStdioServer(runtime);
}

export function mcpStopCommand(options: { vault?: string }): void {
  const vaultRoot = resolveVaultRoot(options.vault);
  const pid = readPid(vaultRoot);
  if (!pid) {
    console.error('No running MCP server found.');
    process.exit(1);
  }
  process.kill(pid, 'SIGTERM');
  cleanupFiles(vaultRoot);
  console.error(`MCP server stopped (PID ${pid}).`);
}

export function mcpStatusCommand(options: { vault?: string }): void {
  const vaultRoot = resolveVaultRoot(options.vault);
  const pid = readPid(vaultRoot);
  if (!pid) {
    console.error('MCP server is not running.');
    process.exit(1);
  }
  let url = '';
  try { url = fs.readFileSync(urlPath(vaultRoot), 'utf-8').trim(); } catch {}
  console.error(`MCP server is running (PID ${pid})`);
  if (url) console.error(`  Endpoint: ${url}`);
}

function resolveVaultRoot(explicitVault?: string): string {
  const fromEnv = process.env.GRANITE_VAULT;
  if (explicitVault) {
    return path.resolve(explicitVault);
  }
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return requireVaultRoot();
}

export function parseTransport(value?: string): 'stdio' | 'http' {
  const transport = value ?? 'stdio';
  if (transport !== 'stdio' && transport !== 'http') {
    throw new Error(`Invalid MCP transport: ${transport}. Expected "stdio" or "http".`);
  }
  return transport;
}

export function parsePort(value?: string): number {
  const raw = (value ?? process.env.MCP_PORT ?? '3321').trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid MCP port: ${raw}`);
  }

  const parsed = Number.parseInt(raw, 10);
  if (parsed <= 0) {
    throw new Error(`Invalid MCP port: ${raw}`);
  }
  return parsed;
}
