import type { Env } from '../env.js';

/**
 * Cron handler: clean up expired sessions, old rate limit records, and old changelog entries.
 * Runs every hour via Cloudflare Cron Triggers.
 */
export async function handleCleanup(env: Env): Promise<void> {
  // Clean up expired auth sessions
  await env.DB.prepare(`
    DELETE FROM auth_sessions WHERE expires_at < datetime('now')
  `).run();

  // Clean up old rate limit records (2h retention, beyond the 1h window)
  await env.DB.prepare(`
    DELETE FROM rate_limits WHERE created_at < datetime('now', '-2 hours')
  `).run();

  // Clean up old sync changelog entries (keep last 30 days)
  const result = await env.DB.prepare(`
    DELETE FROM sync_changelog WHERE timestamp < datetime('now', '-30 days')
  `).run();

  console.log(`Cleanup complete: ${result.meta.changes} old changelog entries removed`);
}
