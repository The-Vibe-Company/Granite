import { listManagedInstances, supportsWebApi } from '../core/deploy/deploy.js';
import type { SpritesClient } from '../core/deploy/sprites-client.js';

export interface CloudInstance {
  id: string;
  label: string;
  baseUrl: string;
  /** Bearer token for the instance's MCP/web API — never serialized to the browser. */
  token: string;
  version: string | null;
  webApi: boolean;
}

// Metadata-only discovery for `granite serve`: reads sprite markers but never
// health-probes the instances, so cold sprites are not woken at startup.
export async function discoverCloudInstances(client: SpritesClient): Promise<CloudInstance[]> {
  const instances = await listManagedInstances(client, { includeToken: true, checkHealth: false });

  return instances
    .filter(instance => Boolean(instance.mcp_token) && Boolean(instance.url))
    .map(instance => ({
      id: instance.instance,
      label: instance.instance === 'granite' ? 'granite (cloud)' : instance.instance,
      baseUrl: instance.url,
      token: instance.mcp_token as string,
      version: instance.granite_version,
      webApi: supportsWebApi(instance.granite_version),
    }));
}
