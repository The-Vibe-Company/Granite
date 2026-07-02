import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeDefaultConfig } from '../../src/core/config.js';
import { GraniteMcpRuntime } from '../../src/mcp/runtime.js';
import {
  createGraniteMcpHttpApp,
  requiresMcpHttpAuth,
  startGraniteMcpHttpServer,
} from '../../src/mcp/server.js';

describe('granite MCP HTTP auth', () => {
  let tmpDir: string;
  let runtime: GraniteMcpRuntime;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-mcp-auth-'));
    writeDefaultConfig(tmpDir);
    runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
  });

  afterEach(() => {
    runtime.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects MCP requests without the configured bearer token', async () => {
    const app = createGraniteMcpHttpApp(runtime, {
      host: '0.0.0.0',
      port: 3321,
      authToken: 'secret-token',
      jsonResponse: true,
    });

    const response = await app.request('/mcp', initializeRequest());

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unauthorized.' },
      id: null,
    });
  });

  it('rejects MCP requests with an invalid bearer token', async () => {
    const app = createGraniteMcpHttpApp(runtime, {
      host: '0.0.0.0',
      port: 3321,
      authToken: 'secret-token',
      jsonResponse: true,
    });

    const response = await app.request('/mcp', initializeRequest('wrong-token'));

    expect(response.status).toBe(401);
  });

  it('accepts MCP requests with the configured bearer token', async () => {
    const app = createGraniteMcpHttpApp(runtime, {
      host: '0.0.0.0',
      port: 3321,
      authToken: 'secret-token',
      jsonResponse: true,
    });

    const response = await app.request('/mcp', initializeRequest('secret-token'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        serverInfo: {
          name: 'granite',
        },
      },
    });
  });

  it('allows OPTIONS preflight without a bearer token', async () => {
    const app = createGraniteMcpHttpApp(runtime, {
      host: '0.0.0.0',
      port: 3321,
      allowedOrigins: ['https://client.example'],
      authToken: 'secret-token',
    });

    const response = await app.request('/mcp', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://client.example',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('refuses to bind a public HTTP server without a bearer token', () => {
    expect(() => startGraniteMcpHttpServer(runtime, {
      host: '0.0.0.0',
      port: 3321,
    })).toThrow('outside localhost without --auth-token or GRANITE_MCP_TOKEN');
  });

  it('requires auth for every non-loopback HTTP bind host', () => {
    expect(requiresMcpHttpAuth('0.0.0.0')).toBe(true);
    expect(requiresMcpHttpAuth('::')).toBe(true);
    expect(requiresMcpHttpAuth('[::]')).toBe(true);
    expect(requiresMcpHttpAuth('192.168.1.20')).toBe(true);
    expect(requiresMcpHttpAuth('10.0.0.5')).toBe(true);
    expect(requiresMcpHttpAuth('100.64.0.10')).toBe(true);
    expect(requiresMcpHttpAuth('granite.example.com')).toBe(true);

    expect(requiresMcpHttpAuth('localhost')).toBe(false);
    expect(requiresMcpHttpAuth('127.0.0.1')).toBe(false);
    expect(requiresMcpHttpAuth('127.10.20.30')).toBe(false);
    expect(requiresMcpHttpAuth('::1')).toBe(false);
    expect(requiresMcpHttpAuth('[::1]')).toBe(false);
  });
});

function initializeRequest(token?: string): RequestInit {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: {
          name: 'granite-test-client',
          version: '1.0.0',
        },
      },
    }),
  };
}
