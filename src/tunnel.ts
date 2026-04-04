import { spawn, type ChildProcess } from 'node:child_process';

export type TunnelProvider = 'cloudflare' | 'tailscale';

export interface TunnelOptions {
  provider: TunnelProvider;
  port: number;
  host: string;
}

export interface TunnelResult {
  url: string;
  process: ChildProcess;
}

export async function startTunnel(options: TunnelOptions): Promise<TunnelResult> {
  if (options.provider === 'cloudflare') {
    return startCloudflareTunnel(options);
  }
  return startTailscaleFunnel(options);
}

export function stopTunnel(tunnelProcess: ChildProcess): void {
  if (!tunnelProcess.killed) {
    tunnelProcess.kill('SIGTERM');
  }
}

function spawnError(binary: string, installUrl: string, err: Error): Error {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    return new Error(`${binary} is not installed. Install it from ${installUrl}`);
  }
  return new Error(`Failed to start ${binary}: ${err.message}`);
}

// ---------------------------------------------------------------------------
// Cloudflare Tunnel (quick tunnel via `cloudflared tunnel --url`)
// ---------------------------------------------------------------------------

function startCloudflareTunnel(options: TunnelOptions): Promise<TunnelResult> {
  return new Promise((resolve, reject) => {
    const localUrl = `http://${options.host}:${options.port}`;
    const child = spawn('cloudflared', ['tunnel', '--url', localUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const onData = (chunk: Buffer) => {
      const match = chunk.toString().match(/https:\/\/[^\s]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timer);
        settle(() => resolve({ url: match[0], process: child }));
      }
    };

    child.stderr?.on('data', onData);
    child.stdout?.on('data', onData);

    child.on('error', (err) => {
      clearTimeout(timer);
      settle(() => reject(spawnError('cloudflared',
        'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
        err)));
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      settle(() => reject(new Error(`cloudflared exited with code ${code} before establishing tunnel`)));
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(() => reject(new Error('Timed out waiting for cloudflared to establish tunnel')));
    }, 30_000);
  });
}

// ---------------------------------------------------------------------------
// Tailscale Funnel (exposes port publicly via `tailscale funnel`)
// ---------------------------------------------------------------------------

async function getTailscaleHostname(): Promise<string> {
  return new Promise((resolve, reject) => {
    const status = spawn('tailscale', ['status', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let output = '';

    status.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    status.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(spawnError('tailscale', 'https://tailscale.com/download', err));
      }
    });

    status.on('exit', (code) => {
      if (settled) return;
      settled = true;

      if (code !== 0) {
        reject(new Error(`tailscale status exited with code ${code}. Is Tailscale running?`));
        return;
      }

      try {
        const parsed = JSON.parse(output);
        const dnsName: string = parsed.Self?.DNSName ?? '';
        const hostname = dnsName.replace(/\.$/, '');
        if (!hostname) {
          reject(new Error('Could not determine Tailscale hostname'));
        } else {
          resolve(hostname);
        }
      } catch {
        reject(new Error('Failed to parse tailscale status output'));
      }
    });
  });
}

async function startTailscaleFunnel(options: TunnelOptions): Promise<TunnelResult> {
  const hostname = await getTailscaleHostname();
  const publicUrl = `https://${hostname}:${options.port}`;

  return new Promise((resolve, reject) => {
    const child = spawn('tailscale', ['funnel', String(options.port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Failed to start tailscale funnel: ${err.message}`));
      }
    });

    // Tailscale funnel has no readiness signal — wait briefly then assume ready
    const timer = setTimeout(() => {
      settled = true;
      resolve({ url: publicUrl, process: child });
    }, 2_000);

    child.on('exit', (exitCode) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(
          `tailscale funnel exited with code ${exitCode}. ` +
          'Make sure Tailscale Funnel is enabled: https://tailscale.com/kb/1223/funnel',
        ));
      }
    });
  });
}
