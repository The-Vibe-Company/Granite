import fs from 'node:fs';
import path from 'node:path';
import { getGraniteDir } from './vault.js';

export const GARDEN_ADJUDICATION_STORE_VERSION = 1;
export const GARDEN_ADJUDICATION_DEFAULT_BLOCKED_RECHECK_DAYS = 14;

export type GardenAdjudicationDecision = 'downrank';
export type GardenAdjudicationReasonCode =
  | 'intentional-structure'
  | 'already-current'
  | 'blocked'
  | 'low-value';

export interface GardenAdjudicationBaseline {
  target_modified_at: Record<string, string>;
  supporting_modified_at?: Record<string, string>;
}

export interface GardenAdjudicationEntry {
  opportunity_id: string;
  kind: string;
  target_slugs: string[];
  decision: GardenAdjudicationDecision;
  reason_code: GardenAdjudicationReasonCode;
  rationale?: string;
  recorded_at: string;
  updated_at: string;
  recheck_after_days?: number;
  baseline: GardenAdjudicationBaseline;
}

export interface GardenAdjudicationStore {
  version: number;
  entries: Record<string, GardenAdjudicationEntry>;
}

const GARDEN_ADJUDICATION_FILE = 'garden-adjudications.json';

export function getGardenAdjudicationsPath(vaultRoot: string): string {
  return path.join(getGraniteDir(vaultRoot), GARDEN_ADJUDICATION_FILE);
}

export function createEmptyGardenAdjudicationStore(): GardenAdjudicationStore {
  return {
    version: GARDEN_ADJUDICATION_STORE_VERSION,
    entries: {},
  };
}

export function readGardenAdjudicationStore(vaultRoot: string): GardenAdjudicationStore {
  const filePath = getGardenAdjudicationsPath(vaultRoot);
  if (!fs.existsSync(filePath)) {
    return createEmptyGardenAdjudicationStore();
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  return normalizeGardenAdjudicationStore(parsed);
}

export function writeGardenAdjudicationStore(vaultRoot: string, store: GardenAdjudicationStore): void {
  const filePath = getGardenAdjudicationsPath(vaultRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
  fs.renameSync(tempPath, filePath);
}

function normalizeGardenAdjudicationStore(value: unknown): GardenAdjudicationStore {
  if (!isRecord(value)) {
    throw new Error('Invalid garden adjudication store: expected an object.');
  }

  if (value.version !== GARDEN_ADJUDICATION_STORE_VERSION) {
    throw new Error(
      `Invalid garden adjudication store version: expected ${GARDEN_ADJUDICATION_STORE_VERSION}, got ${String(value.version)}.`,
    );
  }

  const entriesValue = value.entries;
  if (!isRecord(entriesValue)) {
    throw new Error('Invalid garden adjudication store: "entries" must be an object.');
  }

  const entries: Record<string, GardenAdjudicationEntry> = {};
  for (const [key, entry] of Object.entries(entriesValue)) {
    const normalized = normalizeGardenAdjudicationEntry(entry);
    entries[key] = normalized;
  }

  return {
    version: GARDEN_ADJUDICATION_STORE_VERSION,
    entries,
  };
}

function normalizeGardenAdjudicationEntry(value: unknown): GardenAdjudicationEntry {
  if (!isRecord(value)) {
    throw new Error('Invalid garden adjudication entry: expected an object.');
  }

  const opportunityId = requireString(value.opportunity_id, 'opportunity_id');
  const kind = requireString(value.kind, 'kind');
  const targetSlugs = requireStringArray(value.target_slugs, 'target_slugs');
  const decision = requireDecision(value.decision);
  const reasonCode = requireReasonCode(value.reason_code);
  const recordedAt = requireString(value.recorded_at, 'recorded_at');
  const updatedAt = requireString(value.updated_at, 'updated_at');
  const rationale = optionalTrimmedString(value.rationale, 'rationale');
  const recheckAfterDays = optionalPositiveInteger(value.recheck_after_days, 'recheck_after_days');
  const baseline = normalizeGardenAdjudicationBaseline(value.baseline);

  return {
    opportunity_id: opportunityId,
    kind,
    target_slugs: targetSlugs,
    decision,
    reason_code: reasonCode,
    rationale,
    recorded_at: recordedAt,
    updated_at: updatedAt,
    recheck_after_days: recheckAfterDays,
    baseline,
  };
}

function normalizeGardenAdjudicationBaseline(value: unknown): GardenAdjudicationBaseline {
  if (!isRecord(value)) {
    throw new Error('Invalid garden adjudication baseline: expected an object.');
  }

  return {
    target_modified_at: requireStringRecord(value.target_modified_at, 'baseline.target_modified_at'),
    supporting_modified_at: value.supporting_modified_at === undefined
      ? undefined
      : requireStringRecord(value.supporting_modified_at, 'baseline.supporting_modified_at'),
  };
}

function requireDecision(value: unknown): GardenAdjudicationDecision {
  if (value !== 'downrank') {
    throw new Error(`Invalid garden adjudication decision: ${String(value)}.`);
  }
  return value;
}

function requireReasonCode(value: unknown): GardenAdjudicationReasonCode {
  switch (value) {
    case 'intentional-structure':
    case 'already-current':
    case 'blocked':
    case 'low-value':
      return value;
    default:
      throw new Error(`Invalid garden adjudication reason_code: ${String(value)}.`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid garden adjudication field "${field}": expected a non-empty string.`);
  }
  return value;
}

function optionalTrimmedString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Invalid garden adjudication field "${field}": expected a string.`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid garden adjudication field "${field}": expected an array.`);
  }

  const out = value.map((entry, index) => requireString(entry, `${field}[${index}]`));
  if (out.length === 0) {
    throw new Error(`Invalid garden adjudication field "${field}": expected at least one value.`);
  }
  return out;
}

function requireStringRecord(value: unknown, field: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error(`Invalid garden adjudication field "${field}": expected an object.`);
  }

  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = requireString(entry, `${field}.${key}`);
  }
  return out;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid garden adjudication field "${field}": expected a positive integer.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
