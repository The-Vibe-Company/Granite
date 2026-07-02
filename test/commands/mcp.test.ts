import { afterEach, describe, expect, it } from 'vitest';
import { parseMcpRole, parsePort, parseTransport, resolveAuthToken } from '../../src/commands/mcp.js';

const originalMcpPort = process.env.MCP_PORT;
const originalGraniteMcpToken = process.env.GRANITE_MCP_TOKEN;

describe('mcp command helpers', () => {
  afterEach(() => {
    if (originalMcpPort === undefined) {
      delete process.env.MCP_PORT;
    } else {
      process.env.MCP_PORT = originalMcpPort;
    }
    if (originalGraniteMcpToken === undefined) {
      delete process.env.GRANITE_MCP_TOKEN;
    } else {
      process.env.GRANITE_MCP_TOKEN = originalGraniteMcpToken;
    }
  });

  it('prefers the explicit port over MCP_PORT', () => {
    process.env.MCP_PORT = '4444';
    expect(parsePort('5555')).toBe(5555);
  });

  it('falls back to MCP_PORT and then the default port', () => {
    process.env.MCP_PORT = '4444';
    expect(parsePort()).toBe(4444);

    delete process.env.MCP_PORT;
    expect(parsePort()).toBe(3321);
  });

  it('rejects invalid transport values', () => {
    expect(() => parseTransport('streamable-http' as 'stdio')).toThrow('Invalid MCP transport');
  });

  it('parses MCP access roles', () => {
    expect(parseMcpRole()).toBe('write');
    expect(parseMcpRole('read')).toBe('read');
    expect(parseMcpRole('write')).toBe('write');
    expect(() => parseMcpRole('admin')).toThrow('Invalid MCP role');
  });

  it('resolves the MCP auth token from explicit options and GRANITE_MCP_TOKEN', () => {
    process.env.GRANITE_MCP_TOKEN = 'env-token';

    expect(resolveAuthToken('explicit-token')).toBe('explicit-token');
    expect(resolveAuthToken()).toBe('env-token');

    delete process.env.GRANITE_MCP_TOKEN;
    expect(resolveAuthToken()).toBeUndefined();
    expect(() => resolveAuthToken('   ')).toThrow('Invalid MCP auth token');
  });
});
