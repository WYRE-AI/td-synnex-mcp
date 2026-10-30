import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConfigError } from './config.js';

/** Local caps on order size. These are this connector's own safety limits, not TD SYNNEX limits. */
export interface OrderLimits {
  maxLines: number;
  maxLineQuantity: number;
}

export const ORDER_LIMIT_ENV = {
  maxLines: 'TDSYNNEX_MAX_ORDER_LINES',
  maxLineQuantity: 'TDSYNNEX_MAX_LINE_QUANTITY',
} as const;

export const DEFAULT_ORDER_LIMITS: OrderLimits = {
  maxLines: 25,
  maxLineQuantity: 1000,
};

function positiveInt(raw: string | undefined, name: string, fallback: number): number {
  const t = raw?.trim();
  if (!t) return fallback;
  const n = /^\d+$/.test(t) ? Number(t) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new ConfigError(`Invalid ${name}: must be a positive whole number.`);
  return n;
}

/** Reads and validates the order caps. Throws ConfigError on a non-positive or non-numeric value. */
export function loadOrderLimits(env: NodeJS.ProcessEnv = process.env): OrderLimits {
  const d = DEFAULT_ORDER_LIMITS;
  const e = ORDER_LIMIT_ENV;
  return {
    maxLines: positiveInt(env[e.maxLines], e.maxLines, d.maxLines),
    maxLineQuantity: positiveInt(env[e.maxLineQuantity], e.maxLineQuantity, d.maxLineQuantity),
  };
}

/** A limit was exceeded or a confirm check failed. The message tells the agent what to do next. */
export class OrderLimitError extends Error {}

export function checkLineCount(count: number, limits: OrderLimits, what = 'order'): void {
  if (count > limits.maxLines) {
    throw new OrderLimitError(
      `This ${what} has ${count} lines; the local limit is ${limits.maxLines}. Split it into separate requests, each approved by the user, or ask whoever runs this connector to raise ${ORDER_LIMIT_ENV.maxLines}.`,
    );
  }
}

export function checkLineQuantity(qty: number, label: string, limits: OrderLimits): void {
  if (qty > limits.maxLineQuantity) {
    throw new OrderLimitError(
      `${label} is ${qty}; the local per-line limit is ${limits.maxLineQuantity}. Lower it, split it into separate orders each approved by the user, or ask whoever runs this connector to raise ${ORDER_LIMIT_ENV.maxLineQuantity}.`,
    );
  }
}

// ---------------------------------------------------------------------
// Preview -> confirm binding
// ---------------------------------------------------------------------

export const CONFIRM_TOKEN_TTL_MS = 30 * 60 * 1000;
export const CONFIRM_SECRET_ENV = 'TDSYNNEX_CONFIRM_SECRET';
export const CONFIRM_SECRET_MIN_BYTES = 32;

/** Per-process random key, used when TDSYNNEX_CONFIRM_SECRET is not set. Tokens then do not survive a restart or cross replicas. */
const processConfirmKey = randomBytes(32);

/**
 * Reads TDSYNNEX_CONFIRM_SECRET. Undefined when unset/blank; throws ConfigError (never echoing the
 * value) when it is shorter than CONFIRM_SECRET_MIN_BYTES UTF-8 bytes.
 */
export function loadConfirmSecret(env: NodeJS.ProcessEnv = process.env): Buffer | undefined {
  const raw = env[CONFIRM_SECRET_ENV]?.trim();
  if (!raw) return undefined;
  if (Buffer.byteLength(raw, 'utf8') < CONFIRM_SECRET_MIN_BYTES) {
    throw new ConfigError(
      `Invalid ${CONFIRM_SECRET_ENV}: must be at least ${CONFIRM_SECRET_MIN_BYTES} bytes long. Use a random value, e.g. from \`openssl rand -hex 32\`.`,
    );
  }
  return Buffer.from(raw, 'utf8');
}

function confirmKey(): Buffer {
  return loadConfirmSecret() ?? processConfirmKey;
}

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x ?? null)).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** What a confirm token is bound to, besides the payload. */
export interface ConfirmScope {
  tool: string;
  accountId: string;
  customerId?: string;
}

function confirmMac(issuedAt: string, scope: ConfirmScope, payload: unknown): Buffer {
  const scopeHash = createHash('sha256').update(canonicalJson(scope)).digest('hex');
  return createHmac('sha256', confirmKey())
    .update(`${issuedAt}.${canonicalJson({ scope: scopeHash, payload })}`)
    .digest();
}

/** Token for the preview: `<issuedAt ms>.<HMAC-SHA256 hex>` over the normalized payload and scope (tool, account, customer). */
export function makeConfirmToken(scope: ConfirmScope, payload: unknown): string {
  const issuedAt = String(Date.now());
  return `${issuedAt}.${confirmMac(issuedAt, scope, payload).toString('hex')}`;
}

// Tokens are single-use within this process: a replayed token must not place a second billable order.
const consumed = new Map<string, number>(); // mac hex -> expiry (epoch ms)

function pruneConsumed(now: number): void {
  for (const [k, exp] of consumed) if (exp <= now) consumed.delete(k);
}

export function clearConsumedTokens(): void {
  consumed.clear();
}

/**
 * Throws OrderLimitError unless `token` was issued for exactly this payload and scope within 30 minutes
 * and has not been used. On success the token is marked used (before the vendor call, so a failed or
 * ambiguous write needs a fresh preview rather than a blind replay).
 */
export function consumeConfirmToken(scope: ConfirmScope, payload: unknown, token: string | undefined): void {
  const mismatch = () =>
    new OrderLimitError(
      "This request doesn't match a preview. Call the tool without confirmToken first, show the preview to the user, and only after their explicit approval call again with the confirmToken it returns.",
    );
  const m = typeof token === 'string' ? /^(\d{1,15})\.([0-9a-f]{64})$/.exec(token) : null;
  if (!m) throw mismatch();
  const given = Buffer.from(m[2], 'hex');
  const expected = confirmMac(m[1], scope, payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw mismatch();
  const now = Date.now();
  if (now - Number(m[1]) > CONFIRM_TOKEN_TTL_MS) {
    throw new OrderLimitError("This preview has expired. Run the preview again and get the user's OK before confirming.");
  }
  pruneConsumed(now);
  if (consumed.has(m[2])) {
    throw new OrderLimitError(
      'This confirmToken was already used. If the earlier call failed or its outcome is unclear, check the current state with the read-only tools before previewing again.',
    );
  }
  consumed.set(m[2], Number(m[1]) + CONFIRM_TOKEN_TTL_MS);
}
