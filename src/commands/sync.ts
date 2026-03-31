import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { SyncManager } from '../core/sync/manager.js';
import { listConflicts, clearResolvedConflicts } from '../core/sync/conflict.js';

export async function syncCommand(options: { json?: boolean }): Promise<void> {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const manager = new SyncManager(vaultRoot, config);

  const result = await manager.sync();

  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log(`Sync complete: ${result.pushed} pushed, ${result.pulled} pulled`);
  if (result.conflicts > 0) {
    console.log(`  ${result.conflicts} conflict(s) resolved (backups in .granite/conflicts/)`);
  }
}

export async function syncStatusCommand(options: { json?: boolean }): Promise<void> {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const manager = new SyncManager(vaultRoot, config);

  const status = manager.status();
  const conflictFiles = manager.conflicts();

  if (options.json) {
    console.log(JSON.stringify({ ...status, conflicts: conflictFiles.length }));
    return;
  }

  console.log(`Device:          ${status.device_name} (${status.device_id.slice(0, 8)}...)`);
  console.log(`Last sync:       ${status.last_sync ?? 'never'}`);
  console.log(`Pending changes: ${status.pending_changes}`);
  console.log(`Server seq:      ${status.server_seq}`);
  if (conflictFiles.length > 0) {
    console.log(`Conflicts:       ${conflictFiles.length} file(s) in .granite/conflicts/`);
  }
}

export async function syncDevicesCommand(options: { json?: boolean }): Promise<void> {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const manager = new SyncManager(vaultRoot, config);

  const devices = await manager.devices();

  if (options.json) {
    console.log(JSON.stringify(devices));
    return;
  }

  if (devices.length === 0) {
    console.log('No devices registered yet.');
    return;
  }

  for (const d of devices) {
    console.log(`  ${d.device_name} (${d.device_id.slice(0, 8)}...) — last seen ${d.last_seen}`);
  }
}

export function syncConflictsCommand(options: { clear?: boolean; json?: boolean }): void {
  const vaultRoot = requireVaultRoot();

  if (options.clear) {
    const cleared = clearResolvedConflicts(vaultRoot);
    if (options.json) {
      console.log(JSON.stringify({ cleared }));
    } else {
      console.log(`Cleared ${cleared} conflict file(s).`);
    }
    return;
  }

  const files = listConflicts(vaultRoot);

  if (options.json) {
    console.log(JSON.stringify({ conflicts: files }));
    return;
  }

  if (files.length === 0) {
    console.log('No conflicts.');
    return;
  }

  console.log(`${files.length} conflict file(s):`);
  for (const f of files) {
    console.log(`  ${f}`);
  }
}
