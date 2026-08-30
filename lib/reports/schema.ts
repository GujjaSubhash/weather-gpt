/**
 * Citizen report validation (Requirement 3).
 *
 * Deliberately dependency-free and pure: no Firebase import, no I/O, no clock,
 * no globals. That is what lets the same rules be asserted against
 * firestore.rules in an emulator test — the client validator and the server
 * rules have to agree, and agreement is only checkable if this half is
 * inspectable in isolation.
 *
 * The bounds here mirror the `size()` bounds in firestore.rules exactly. If one
 * side changes, the other must change with it.
 */

export const AREA_MIN = 2;
export const AREA_MAX = 80;
export const DESCRIPTION_MIN = 4;
export const DESCRIPTION_MAX = 500;

export interface ReportInput {
  area: string;
  description: string;
}

/** The trimmed, bounds-checked values that are safe to write. */
export interface ReportValue {
  area: string;
  description: string;
}

export type ReportField = 'area' | 'description';

export type ValidationResult =
  | { ok: true; value: ReportValue }
  | { ok: false; field: ReportField; message: string };

function asTrimmedString(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Validates a report. Returns the trimmed values on success, or the first
 * offending field with a human-readable message on failure.
 *
 * Empty-after-trim is rejected as "required" rather than as a length error,
 * because whitespace-only input is a missing value, not a short one.
 */
export function validateReport(input: ReportInput | null | undefined): ValidationResult {
  const area = asTrimmedString(input?.area);
  const description = asTrimmedString(input?.description);

  if (area.length === 0) {
    return { ok: false, field: 'area', message: 'Area name is required.' };
  }
  if (area.length < AREA_MIN) {
    return { ok: false, field: 'area', message: `Area name must be at least ${AREA_MIN} characters.` };
  }
  if (area.length > AREA_MAX) {
    return { ok: false, field: 'area', message: `Area name must be ${AREA_MAX} characters or fewer.` };
  }

  if (description.length === 0) {
    return { ok: false, field: 'description', message: 'Description is required.' };
  }
  if (description.length < DESCRIPTION_MIN) {
    return { ok: false, field: 'description', message: `Description must be at least ${DESCRIPTION_MIN} characters.` };
  }
  if (description.length > DESCRIPTION_MAX) {
    return { ok: false, field: 'description', message: `Description must be ${DESCRIPTION_MAX} characters or fewer.` };
  }

  return { ok: true, value: { area, description } };
}
