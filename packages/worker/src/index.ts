import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env.js';
import { authMiddleware } from './auth.js';
import { vaultMiddleware } from './middleware/vault.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { handleMcp } from './handlers/mcp.js';
import { handleSyncPush, handleSyncPull, handleSyncDevices } from './handlers/sync.js';
import authRoutes from './routes/auth.js';
import keysRoutes from './routes/keys.js';
import billingRoutes from './routes/billing.js';
import userRoutes from './routes/user.js';
import { requirePaidTier } from './middleware/tier-gate.js';
import { handleCleanup } from './cron/cleanup.js';

const app = new Hono<{ Bindings: Env }>();

// CORS for all routes
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version', 'Last-Event-ID', 'X-Vault-Id'],
  exposeHeaders: ['MCP-Session-Id', 'MCP-Protocol-Version', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
}));

// Health check (no auth)
app.get('/health', (c) => c.json({ status: 'ok', service: 'granite-cloud' }));

// Auth routes (no auth required — these handle OAuth flow)
app.route('/', authRoutes);

// Billing checkout/portal (auth required — must register before route mount)
app.use('/billing/checkout', authMiddleware);
app.use('/billing/portal', authMiddleware);

// Billing routes (webhook has no auth — verified via Stripe signature)
app.route('/', billingRoutes);

// --- Protected routes (require auth) ---

// API key management
app.use('/keys', authMiddleware);
app.use('/keys/*', authMiddleware);
app.route('/', keysRoutes);

// User profile & vault management
app.use('/me', authMiddleware);
app.use('/vaults', authMiddleware);
app.route('/', userRoutes);

// MCP endpoint (auth + paid tier + vault resolution)
app.use('/mcp', authMiddleware);
app.use('/mcp', requirePaidTier);
app.use('/mcp', vaultMiddleware);
app.post('/mcp', handleMcp);

// Sync relay endpoints (auth + paid tier + vault resolution + rate limit)
app.use('/v1/sync/*', authMiddleware);
app.use('/v1/sync/*', requirePaidTier);
app.use('/v1/sync/*', vaultMiddleware);
app.use('/v1/sync/push', rateLimitMiddleware);
app.post('/v1/sync/push', handleSyncPush);
app.get('/v1/sync/pull', handleSyncPull);
app.get('/v1/sync/devices', handleSyncDevices);
app.get('/v1/sync/ping', (c) => c.json({ ok: true }));

// 404 fallback
app.notFound((c) => c.json({ error: 'Not found' }, 404));

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleCleanup(env));
  },
};
