export interface CloudTarget {
  kind: 'cloud';
  vaultId?: string;
}

export function parseCloudTarget(value: string | undefined): CloudTarget | null {
  if (!value) return null;
  if (value === 'cloud') return { kind: 'cloud' };
  if (value.startsWith('cloud:')) {
    const vaultId = value.slice('cloud:'.length).trim();
    return { kind: 'cloud', vaultId: vaultId || undefined };
  }
  return null;
}
