import path from 'node:path';
import { requireVaultRoot } from '../core/vault.js';
import { startGraniteMcpHttpServer, startGraniteMcpStdioServer } from '../mcp/server.js';
import { GraniteMcpRuntime } from '../mcp/runtime.js';

interface McpCommandOptions {
  vault?: string;
  transport?: 'stdio' | 'http';
  host?: string;
  port?: string;
  allowOrigin?: string[];
  jsonResponse?: boolean;
}

export async function mcpCommand(options: McpCommandOptions): Promise<void> {
  const transport = parseTransport(options.transport);
  const vaultRoot = resolveVaultRoot(options.vault);
  const runtime = new GraniteMcpRuntime(vaultRoot);

  const shutdown = () => {
    runtime.close();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  if (transport === 'http') {
    const port = parsePort(options.port);
    startGraniteMcpHttpServer(runtime, {
      host: options.host ?? '127.0.0.1',
      port,
      allowedOrigins: options.allowOrigin ?? [],
      jsonResponse: options.jsonResponse ?? false,
    });
    return;
  }

  await startGraniteMcpStdioServer(runtime);
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
