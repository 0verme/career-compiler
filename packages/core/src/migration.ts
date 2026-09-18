import type { CareerIR } from './types.js';
import { CAREER_IR_SCHEMA_VERSION, CAREER_IR_SCHEMA_VERSION_V01 } from './types.js';
import { DomainValidationError, validateCareerIR } from './validation.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Migrate a legacy 0.1 achievement into the 0.2 contract:
 * `factIds` becomes `factRefs`, and every legacy unit is a confirmed projection
 * because V0.1 only rendered achievements derived from confirmed facts.
 */
function migrateAchievementV01(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const contributes = ['statement'];
  if (nonEmptyString(value.metric)) {
    contributes.push('metric');
  }
  const migrated: JsonRecord = {
    ...value,
    status: 'confirmed',
    factRefs: stringArray(value.factIds).map((factId) => ({
      factId,
      relation: 'derived-from',
      contributes: [...contributes]
    }))
  };
  delete migrated.factIds;
  return migrated;
}

function migrateProfileV01(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.achievements)) {
    return value;
  }
  return {
    ...value,
    achievements: value.achievements.map(migrateAchievementV01)
  };
}

/**
 * Normalize a parsed Career IR document to the current schema version.
 * Explicitly migrates 0.1 documents; rejects unknown versions instead of
 * silently dropping fields.
 */
export function migrateCareerIR(value: unknown): CareerIR {
  if (!isRecord(value)) {
    throw new DomainValidationError('CareerIR must be an object');
  }
  if (value.schemaVersion === CAREER_IR_SCHEMA_VERSION) {
    return validateCareerIR(value);
  }
  if (value.schemaVersion !== CAREER_IR_SCHEMA_VERSION_V01) {
    throw new DomainValidationError(
      `Unsupported CareerIR schema version: ${String(value.schemaVersion)}`
    );
  }
  const migrated = {
    ...value,
    schemaVersion: CAREER_IR_SCHEMA_VERSION,
    profile: migrateProfileV01(value.profile)
  };
  return validateCareerIR(migrated);
}

export function parseCareerIR(serialized: string): CareerIR {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new DomainValidationError(
      `CareerIR is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return migrateCareerIR(parsed);
}
