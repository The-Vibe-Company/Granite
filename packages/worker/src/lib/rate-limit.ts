import type { User } from '../env.js';

/**
 * Determine the rate limit identifier for a request.
 * Authenticated users are identified by user_id, anonymous by IP.
 */
export function getRateLimitIdentifier(
  user: User | null,
  cfConnectingIp: string | null,
  xForwardedFor: string | null,
): string {
  if (user) return user.id;
  const ip = cfConnectingIp || xForwardedFor?.split(',')[0]?.trim() || 'unknown';
  return `ip:${ip}`;
}
