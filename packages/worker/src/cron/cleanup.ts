import type { Env } from '../env.js';

const RATE_LIMIT_RETENTION_HOURS = 2;
const CHANGELOG_RETENTION_DAYS = 30;

export async function handleCleanup(env: Env): Promise<void> {
  await env.DB.prepare(`
    DELETE FROM auth_sessions WHERE expires_at < datetime('now')
  `).run();

  await env.DB.prepare(`
    DELETE FROM rate_limits WHERE created_at < datetime('now', '-${RATE_LIMIT_RETENTION_HOURS} hours')
  `).run();

  const result = await env.DB.prepare(`
    DELETE FROM sync_changelog WHERE timestamp < datetime('now', '-${CHANGELOG_RETENTION_DAYS} days')
  `).run();

  console.log(`Cleanup: ${result.meta.changes} old changelog entries removed`);
}
