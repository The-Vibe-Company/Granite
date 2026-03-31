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
  const transport = options.transport ?? 'stdio';
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

function parsePort(value?: string): number {
  const parsed = Number.parseInt(process.env.MCP_PORT || value || '3321', 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid MCP port: ${value ?? process.env.MCP_PORT}`);
  }
  return parsed;
}
