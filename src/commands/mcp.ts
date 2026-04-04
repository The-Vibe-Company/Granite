import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { requireVaultRoot } from '../core/vault.js';
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

function graniteDir(vaultRoot: string): string {
  return path.join(vaultRoot, '.granite');
}

function pidPath(vaultRoot: string): string {
  return path.join(graniteDir(vaultRoot), 'mcp.pid');
}

function urlPath(vaultRoot: string): string {
  return path.join(graniteDir(vaultRoot), 'mcp.url');
}

function readPid(vaultRoot: string): number | null {
  try {
    const raw = fs.readFileSync(pidPath(vaultRoot), 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isNaN(pid)) return null;
    // Check if the process is still running
    try { process.kill(pid, 0); return pid; } catch { return null; }
  } catch {
    return null;
  }
}

function writePid(vaultRoot: string, pid: number): void {
  const dir = graniteDir(vaultRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pidPath(vaultRoot), String(pid), 'utf-8');
}

function writeUrl(vaultRoot: string, url: string): void {
  const dir = graniteDir(vaultRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(urlPath(vaultRoot), url, 'utf-8');
}

function cleanupFiles(vaultRoot: string): void {
  try { fs.unlinkSync(pidPath(vaultRoot)); } catch {}
  try { fs.unlinkSync(urlPath(vaultRoot)); } catch {}
}

// ---- Commands --------------------------------------------------------------

export async function mcpCommand(options: McpCommandOptions): Promise<void> {
  const tunnel = options.tunnel;
  // --tunnel implies --transport http
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

    const args = process.argv.slice(1).filter(a => a !== '--background' && a !== '--bg');
    const logFile = path.join(graniteDir(vaultRoot), 'mcp.log');
    fs.mkdirSync(graniteDir(vaultRoot), { recursive: true });
    const out = fs.openSync(logFile, 'a');

    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, GRANITE_MCP_DAEMONIZED: '1' },
    });

    child.unref();
    writePid(vaultRoot, child.pid!);
    console.error(`MCP server starting in background (PID ${child.pid})`);
    console.error(`Log: ${logFile}`);
    console.error(`Stop with: granite mcp stop`);
    process.exit(0);
  }

  const runtime = new GraniteMcpRuntime(vaultRoot);
  const isDaemon = process.env.GRANITE_MCP_DAEMONIZED === '1';

  const shutdown = () => {
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

    if (isDaemon) {
      writePid(vaultRoot, process.pid);
      writeUrl(vaultRoot, localUrl);
    }

    if (tunnel) {
      try {
        console.error(`\nStarting ${tunnel} tunnel...`);
        const result = await startTunnel({ provider: tunnel, port, host });
        const publicMcpUrl = `${result.url}/mcp`;
        console.error(`\n🚇 Tunnel active!\n`);
        console.error(`  Public MCP endpoint: ${publicMcpUrl}`);
        console.error(`  Provider: ${tunnel}`);
        console.error(`\nUse this URL in your remote MCP client configuration.\n`);

        if (isDaemon) writeUrl(vaultRoot, publicMcpUrl);

        // Cleanup tunnel on exit
        const shutdownWithTunnel = () => {
          stopTunnel(result.process);
          if (isDaemon) cleanupFiles(vaultRoot);
          runtime.close();
          process.exit(0);
        };
        process.removeListener('SIGINT', shutdown);
        process.removeListener('SIGTERM', shutdown);
        process.once('SIGINT', shutdownWithTunnel);
        process.once('SIGTERM', shutdownWithTunnel);
      } catch (err) {
        console.error(`\nFailed to start tunnel: ${err instanceof Error ? err.message : err}`);
        if (isDaemon) cleanupFiles(vaultRoot);
        runtime.close();
        process.exit(1);
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
