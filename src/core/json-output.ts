export function jsonSuccess(data: unknown): string {
  return JSON.stringify({ success: true, data }, null, 2);
}

export function jsonError(error: string): string {
  return JSON.stringify({ success: false, error }, null, 2);
}

const VALID_STATUSES = ['inbox', 'active', 'archived'] as const;
const VALID_SOURCES = ['human', 'agent', 'extraction'] as const;

export function validateStatus(value: string): asserts value is 'inbox' | 'active' | 'archived' {
  if (!(VALID_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`Invalid status: "${value}". Expected one of: ${VALID_STATUSES.join(', ')}`);
  }
}

export function validateSource(value: string): asserts value is 'human' | 'agent' | 'extraction' {
  if (!(VALID_SOURCES as readonly string[]).includes(value)) {
    throw new Error(`Invalid source: "${value}". Expected one of: ${VALID_SOURCES.join(', ')}`);
  }
}
