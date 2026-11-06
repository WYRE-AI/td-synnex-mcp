import { ConfigError, isNumericId, isRefId } from '../config.js';
import { TdSynnexApiError, TdSynnexAuthError, currentSecrets } from '../client.js';
import { OrderLimitError } from '../order-safety.js';
import { redact, redactOutput } from '../utils/redact.js';
import { logger } from '../utils/logger.js';
import type { CallToolResult } from './types.js';

export function textResult(value: unknown): CallToolResult {
  // Secret-bearing fields (e.g. the generated customer password) are removed from every tool output.
  return { content: [{ type: 'text', text: JSON.stringify(redactOutput(value), null, 2) }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** Invalid tool arguments. Messages must never contain credential values. */
export class InputError extends Error {}

/** Annotations shared by every read-only tool (including the read-only POST pricing call). */
export const READ_ONLY = { readOnlyHint: true } as const;
/** Annotations for every tool that changes data at TD SYNNEX. */
export const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const;

/** Prefix of every write tool description. */
export const WRITE_NOTE =
  'WRITE OPERATION: this changes data at TD SYNNEX StreamOne ION and needs the user\'s explicit approval first. ';

// ---------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------

/** Default cap on any free-text argument. */
export const DEFAULT_MAX_STRING = 500;
/** Local page-size cap (not a documented ION limit). */
export const PAGE_SIZE_MAX = 100;
export const PAGE_SIZE_DEFAULT = 25;
const MAX_LIST_ITEMS = 50;

// ---------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

function plainString(args: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') throw new InputError(`${key} must be a string.`);
  const t = v.trim();
  if (!t) return undefined;
  if (CONTROL_CHARS.test(t)) throw new InputError(`${key} contains control characters.`);
  if (t.length > max) throw new InputError(`${key} must be at most ${max} characters (got ${t.length}).`);
  return t;
}

export function optString(args: Record<string, unknown>, key: string, max = DEFAULT_MAX_STRING): string | undefined {
  return plainString(args, key, max);
}

export function reqString(args: Record<string, unknown>, key: string, max = DEFAULT_MAX_STRING): string {
  const v = plainString(args, key, max);
  if (v === undefined) throw new InputError(`${key} is required.`);
  return v;
}

/** Numeric id used in a path (account/customer/order/subscription): digits only. */
export function reqNumericId(args: Record<string, unknown>, key: string): string {
  const v = reqString(args, key, 20);
  if (!isNumericId(v)) throw new InputError(`${key} must be a numeric id (digits only).`);
  return v;
}

export function optNumericId(args: Record<string, unknown>, key: string): string | undefined {
  const v = optString(args, key, 20);
  if (v !== undefined && !isNumericId(v)) throw new InputError(`${key} must be a numeric id (digits only).`);
  return v;
}

/** Product / cart / provider reference id: conservative pattern, safe in a path segment once encoded. */
export function reqRefId(args: Record<string, unknown>, key: string): string {
  const v = reqString(args, key, 128);
  if (!isRefId(v)) throw new InputError(`${key} may only contain letters, digits and . _ : - (max 128 characters).`);
  return v;
}

export function optRefId(args: Record<string, unknown>, key: string): string | undefined {
  const v = optString(args, key, 128);
  if (v !== undefined && !isRefId(v)) throw new InputError(`${key} may only contain letters, digits and . _ : - (max 128 characters).`);
  return v;
}

export function optInt(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new InputError(`${key} must be an integer between ${min} and ${max}.`);
  }
  return n;
}

export function reqInt(args: Record<string, unknown>, key: string, min: number, max: number): number {
  const v = optInt(args, key, min, max);
  if (v === undefined) throw new InputError(`${key} is required.`);
  return v;
}

export function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new InputError(`${key} must be true or false.`);
  return v;
}

export function optEnum<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const v = optString(args, key, 100);
  if (v === undefined) return undefined;
  const hit = allowed.find((a) => a === v);
  if (!hit) throw new InputError(`${key} must be one of: ${allowed.join(', ')} (got "${v}").`);
  return hit;
}

export function reqEnum<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const v = optEnum(args, key, allowed);
  if (v === undefined) throw new InputError(`${key} is required (one of: ${allowed.join(', ')}).`);
  return v;
}

/** Optional array of numeric ids, joined with commas for the ION "...List" filters. */
export function optNumericIdList(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new InputError(`${key} must be an array of numeric ids.`);
  if (v.length === 0) return undefined;
  if (v.length > MAX_LIST_ITEMS) throw new InputError(`${key} has ${v.length} entries; the maximum is ${MAX_LIST_ITEMS}.`);
  return v
    .map((entry, i) => {
      const s = plainString({ e: entry }, 'e', 20);
      if (s === undefined || !isNumericId(s)) throw new InputError(`${key}[${i}] must be a numeric id (digits only).`);
      return s;
    })
    .join(',');
}

export function optStringArray(args: Record<string, unknown>, key: string, maxItems: number, maxLen: number): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new InputError(`${key} must be an array of strings.`);
  if (v.length === 0) return undefined;
  if (v.length > maxItems) throw new InputError(`${key} has ${v.length} entries; the maximum is ${maxItems}.`);
  return v.map((entry, i) => {
    const s = plainString({ e: entry }, 'e', maxLen);
    if (s === undefined) throw new InputError(`${key}[${i}] must be a non-empty string.`);
    return s;
  });
}

export function optObject(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new InputError(`${key} must be an object.`);
  return v as Record<string, unknown>;
}

export function reqObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = optObject(args, key);
  if (v === undefined) throw new InputError(`${key} is required.`);
  return v;
}

export function reqObjectArray(args: Record<string, unknown>, key: string, maxItems: number): Array<Record<string, unknown>> {
  const v = args[key];
  if (!Array.isArray(v) || v.length === 0) throw new InputError(`${key} must be a non-empty array.`);
  if (v.length > maxItems) throw new InputError(`${key} has ${v.length} entries; the maximum is ${maxItems}.`);
  return v.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new InputError(`${key}[${i}] must be an object.`);
    return entry as Record<string, unknown>;
  });
}

/** Rejects argument keys that are not in `allowed`, so typos in write payloads fail loudly. */
export function assertKnownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new InputError(`Unknown field(s) in ${where}: ${unknown.join(', ')}.`);
}

/** Documented `attributes` list: [{ name, value }]. */
export function attributeList(
  obj: Record<string, unknown>,
  key: string,
  where: string,
  maxItems = MAX_LIST_ITEMS,
): Array<{ name: string; value: string }> | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new InputError(`${where}.${key} must be an array of { name, value }.`);
  if (v.length > maxItems) throw new InputError(`${where}.${key} has ${v.length} entries; the maximum is ${maxItems}.`);
  return v.map((a, i) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new InputError(`${where}.${key}[${i}] must be an object.`);
    const o = a as Record<string, unknown>;
    assertKnownKeys(o, ['name', 'value'], `${where}.${key}[${i}]`);
    return { name: reqString(o, 'name', 128), value: reqString(o, 'value', 1000) };
  });
}

/** pageSize with the local default and cap. */
export function pageSizeArg(args: Record<string, unknown>, key = 'pageSize'): number {
  return optInt(args, key, 1, PAGE_SIZE_MAX) ?? PAGE_SIZE_DEFAULT;
}

export function pageTokenArg(args: Record<string, unknown>): string | undefined {
  return optString(args, 'pageToken', 1024);
}

// ---------------------------------------------------------------------
// Schema fragments
// ---------------------------------------------------------------------

export const idSchema = (description: string) => ({ type: 'string', pattern: '^\\d+$', maxLength: 20, description }) as const;
export const refIdSchema = (description: string) =>
  ({ type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$', maxLength: 128, description }) as const;
export const textSchema = (description: string, maxLength = DEFAULT_MAX_STRING) => ({ type: 'string', maxLength, description }) as const;

export const PAGE_SIZE_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: PAGE_SIZE_MAX,
  description: `Page size (1-${PAGE_SIZE_MAX}, default ${PAGE_SIZE_DEFAULT}). The ${PAGE_SIZE_MAX} maximum is a local cap of this connector, not a documented ION limit.`,
} as const;

export const PAGE_TOKEN_SCHEMA = {
  type: 'string',
  maxLength: 1024,
  description: 'nextPageToken from the previous response, to fetch the next page.',
} as const;

// ---------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------

/** Converts a thrown error to a redacted error result. */
export function toErrorResult(err: unknown, tool: string): CallToolResult {
  const raw = err instanceof Error ? err.message : String(err);
  const message = redact(raw, currentSecrets());
  const expected =
    err instanceof InputError ||
    err instanceof OrderLimitError ||
    err instanceof ConfigError ||
    err instanceof TdSynnexAuthError;
  if (!expected) {
    logger.warn('Tool call failed', { tool, kind: err instanceof TdSynnexApiError ? 'api' : 'unexpected', message });
  }
  return errorResult(message);
}
