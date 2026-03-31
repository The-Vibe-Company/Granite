import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env.js';
import { authMiddleware } from './auth.js';
import { handleMcp } from './handlers/mcp.js';
import { handleSyncPush, handleSyncPull, handleSyncDevices } from './handlers/sync.js';

const app = new Hono<{ Bindings: Env }>();

// CORS for MCP clients (Claude Desktop, etc.)
app.use('/mcp', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version', 'Last-Event-ID'],
  exposeHeaders: ['MCP-Session-Id', 'MCP-Protocol-Version'],
}));

// Auth on protected routes
app.use('/mcp', authMiddleware);
app.use('/v1/sync/*', authMiddleware);

// MCP endpoint
app.post('/mcp', handleMcp);

// Sync relay endpoints
app.post('/v1/sync/push', handleSyncPush);
app.get('/v1/sync/pull', handleSyncPull);
app.get('/v1/sync/devices', handleSyncDevices);
app.get('/v1/sync/ping', (c) => c.json({ ok: true }));

// Health check (no auth)
app.get('/health', (c) => c.json({ status: 'ok', service: 'granite-cloud' }));

export default app;
