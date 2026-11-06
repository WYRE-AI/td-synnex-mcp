const REDACTED = '[redacted]';

/** Shorter secrets are not literally replaced: they would mangle ordinary text. Pattern-based redaction still applies. */
export const MIN_LITERAL_SECRET_LENGTH = 6;

// Patterns that identify secret material even when we don't hold the exact
// value (e.g. a token echoed back by the vendor).
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const FORM_SECRET_RE = /\b(refresh_token|access_token|client_secret|password)=[^&\s"']*/gi;
const JSON_SECRET_RE = /"(refresh_token|access_token|password|refreshToken|accessToken)"\s*:\s*"[^"]*"/gi;
const URL_WITH_QUERY_RE = /https?:\/\/[^\s"']+\?[^\s"']*/gi;

/**
 * Removes secrets from free text. `secrets` are the exact values this process
 * holds for the current request; the patterns cover vendor-echoed tokens and
 * credential-bearing request fragments.
 */
export function redact(text: string, secrets: Iterable<string | undefined> = []): string {
  let out = text;
  const list = [...secrets].filter((s): s is string => typeof s === 'string' && s.length >= MIN_LITERAL_SECRET_LENGTH);
  list.sort((a, b) => b.length - a.length);
  for (const secret of list) out = out.split(secret).join(REDACTED);
  return out
    .replace(JSON_SECRET_RE, `"$1":"${REDACTED}"`)
    .replace(FORM_SECRET_RE, `$1=${REDACTED}`)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(JWT_RE, REDACTED)
    .replace(URL_WITH_QUERY_RE, '[redacted URL]');
}

const SENSITIVE_KEY_RE = /secret|password|passwd|token|authorization|cookie/i;

/** Deep-copies a log context, masking sensitive keys and scrubbing string values. */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 5) return '[truncated]';
  if (value instanceof Error) return redact(value.message);
  if (Array.isArray(value)) return value.map((v) => sanitizeForLog(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : sanitizeForLog(v, depth + 1);
  }
  return out;
}

/** Exact (case-insensitive) key names whose values are removed from tool output, at any depth. */
const OUTPUT_SECRET_KEYS = new Set([
  'password',
  'passwd',
  'secret',
  'client_secret',
  'clientsecret',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
]);

/**
 * Deep-copies a vendor response for tool output with secret-bearing fields replaced.
 * Create Customer returns a generated user `password`; it must never reach the model.
 */
export function redactOutput(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 25) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => redactOutput(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = OUTPUT_SECRET_KEYS.has(k.toLowerCase()) ? REDACTED : redactOutput(v, depth + 1);
  }
  return out;
}
