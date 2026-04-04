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

/**
 * Start a tunnel exposing a local HTTP port to the public internet.
 * Supports Cloudflare Tunnel (`cloudflared`) and Tailscale Funnel.
 */
export async function startTunnel(options: TunnelOptions): Promise<TunnelResult> {
  if (options.provider === 'cloudflare') {
    return startCloudflareTunnel(options);
  }
  return startTailscaleFunnel(options);
}

/**
 * Stop a running tunnel process gracefully.
 */
export function stopTunnel(tunnelProcess: ChildProcess): void {
  if (!tunnelProcess.killed) {
    tunnelProcess.kill('SIGTERM');
  }
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

    let resolved = false;

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      // cloudflared prints the public URL to stderr like:
      //   https://xxx-yyy-zzz.trycloudflare.com
      const match = text.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        resolve({ url: match[0], process: child });
      }
    };

    child.stderr?.on('data', onData);
    child.stdout?.on('data', onData);

    child.on('error', (err) => {
      if (!resolved) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(
            'cloudflared is not installed. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
          ));
        } else {
          reject(new Error(`Failed to start cloudflared: ${err.message}`));
        }
      }
    });

    child.on('exit', (code) => {
      if (!resolved) {
        reject(new Error(`cloudflared exited with code ${code} before establishing tunnel`));
      }
    });

    // Timeout after 30s
    setTimeout(() => {
      if (!resolved) {
        child.kill('SIGTERM');
        reject(new Error('Timed out waiting for cloudflared to establish tunnel'));
      }
    }, 30_000);
  });
}

// ---------------------------------------------------------------------------
// Tailscale Funnel (exposes port publicly via `tailscale funnel`)
// ---------------------------------------------------------------------------

function startTailscaleFunnel(options: TunnelOptions): Promise<TunnelResult> {
  return new Promise((resolve, reject) => {
    // First, get the Tailscale hostname to construct the public URL
    const status = spawn('tailscale', ['status', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let statusOutput = '';
    status.stdout?.on('data', (chunk: Buffer) => {
      statusOutput += chunk.toString();
    });

    status.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(
          'tailscale is not installed. Install it from https://tailscale.com/download',
        ));
      } else {
        reject(new Error(`Failed to run tailscale: ${err.message}`));
      }
    });

    status.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`tailscale status exited with code ${code}. Is Tailscale running?`));
        return;
      }

      let hostname: string;
      try {
        const parsed = JSON.parse(statusOutput);
        const dnsName: string = parsed.Self?.DNSName ?? '';
        // DNSName is like "machine.tailnet-name.ts.net." — strip trailing dot
        hostname = dnsName.replace(/\.$/, '');
      } catch {
        reject(new Error('Failed to parse tailscale status output'));
        return;
      }

      if (!hostname) {
        reject(new Error('Could not determine Tailscale hostname'));
        return;
      }

      const publicUrl = `https://${hostname}:${options.port}`;

      // Start funnel: `tailscale funnel <port>`
      const child = spawn('tailscale', ['funnel', String(options.port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to start tailscale funnel: ${err.message}`));
      });

      // Give it a moment to start, then resolve
      const timeout = setTimeout(() => {
        resolve({ url: publicUrl, process: child });
      }, 2_000);

      child.on('exit', (exitCode) => {
        clearTimeout(timeout);
        reject(new Error(
          `tailscale funnel exited with code ${exitCode}. ` +
          'Make sure Tailscale Funnel is enabled: https://tailscale.com/kb/1223/funnel',
        ));
      });
    });
  });
}
