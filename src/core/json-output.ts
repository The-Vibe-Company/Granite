export function jsonSuccess(data: unknown): string {
  return JSON.stringify({ success: true, data }, null, 2);
}

export function jsonError(error: string): string {
  return JSON.stringify({ success: false, error }, null, 2);
}
