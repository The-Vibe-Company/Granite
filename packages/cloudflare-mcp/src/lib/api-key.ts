import { nanoid } from 'nanoid';

const API_KEY_PREFIX = 'gsk_';

export function generateApiKey(): string {
  return API_KEY_PREFIX + nanoid(43);
}

// Returns first 10 chars after prefix for safe display without exposing full key
export function getKeyPrefix(apiKey: string): string {
  return apiKey.slice(0, API_KEY_PREFIX.length + 10);
}

export async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
