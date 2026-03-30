import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { startServer } from '../web/server.js';

export function serveCommand(options: { port: string }): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const port = parseInt(process.env.PORT || options.port, 10) || 4321;
  startServer(vaultRoot, config, port);
}
