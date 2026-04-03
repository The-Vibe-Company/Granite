export function jsonSuccess(data: unknown): string {
  return JSON.stringify({ success: true, data }, null, 2);
}

export function jsonError(error: string): string {
  return JSON.stringify({ success: false, error }, null, 2);
}

const VALID_STATUSES = ['inbox', 'active', 'archived'] as const;
const VALID_SOURCES = ['human', 'agent', 'extraction'] as const;
const VALID_REVIEW_STATES = ['draft', 'reviewed', 'locked'] as const;
const VALID_DURABILITY = ['canonical', 'working', 'ephemeral'] as const;

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

export function validateReviewState(value: string): asserts value is 'draft' | 'reviewed' | 'locked' {
  if (!(VALID_REVIEW_STATES as readonly string[]).includes(value)) {
    throw new Error(`Invalid review_state: "${value}". Expected one of: ${VALID_REVIEW_STATES.join(', ')}`);
  }
}

export function validateDurability(value: string): asserts value is 'canonical' | 'working' | 'ephemeral' {
  if (!(VALID_DURABILITY as readonly string[]).includes(value)) {
    throw new Error(`Invalid durability: "${value}". Expected one of: ${VALID_DURABILITY.join(', ')}`);
  }
}
