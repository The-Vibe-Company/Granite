import { loadConfig } from '../core/config.js';
import { findVaultRoot } from '../core/vault.js';
import { HttpSpritesClient } from '../core/deploy/sprites-client.js';
import { startServer } from '../web/server.js';
import { discoverCloudInstances } from '../web/instances.js';
import type { CloudInstance } from '../web/instances.js';
import type { GraniteConfig } from '../core/types.js';
import { resolveSpritesToken } from '../core/deploy/credentials.js';

export async function serveCommand(options: { port: string; cloud?: boolean }): Promise<void> {
  // Vault resolution is lenient here: serve can run cloud-only.
  const vaultRoot = findVaultRoot();
  let config: GraniteConfig | null = null;
  if (vaultRoot) {
    config = loadConfig(vaultRoot);
  }

  let cloudInstances: CloudInstance[] = [];
  const spritesToken = resolveSpritesToken();
  if (options.cloud !== false && spritesToken) {
    try {
      cloudInstances = await discoverCloudInstances(new HttpSpritesClient({ token: spritesToken }));
    } catch (error) {
      console.error(`Warning: could not list cloud instances (${error instanceof Error ? error.message : String(error)}). Serving without them.`);
    }
  }

  if (!vaultRoot && cloudInstances.length === 0) {
    console.error('Not in a Granite vault and no cloud instances found. Run "granite init" first, or run "granite deploy login --token <token>" to browse your deployed instances.');
    process.exit(1);
  }

  const port = parseInt(process.env.PORT || options.port, 10) || 4321;
  startServer(vaultRoot, config, port, cloudInstances);
}
