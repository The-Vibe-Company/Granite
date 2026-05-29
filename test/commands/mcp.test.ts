import { afterEach, describe, expect, it } from 'vitest';
import { parseMcpRole, parsePort, parseTransport } from '../../src/commands/mcp.js';

const originalMcpPort = process.env.MCP_PORT;

describe('mcp command helpers', () => {
  afterEach(() => {
    if (originalMcpPort === undefined) {
      delete process.env.MCP_PORT;
    } else {
      process.env.MCP_PORT = originalMcpPort;
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
});
