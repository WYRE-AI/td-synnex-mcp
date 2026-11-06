import type { IncomingHttpHeaders } from 'node:http';
import type { RequestCredentials } from './types.js';

/** Thrown for missing/partial/invalid configuration. Messages name variables, never values. */
export class ConfigError extends Error {}

export const ENV_NAMES = {
  accountId: 'TDSYNNEX_ACCOUNT_ID',
  refreshToken: 'TDSYNNEX_REFRESH_TOKEN',
  refreshTokenFile: 'TDSYNNEX_REFRESH_TOKEN_FILE',
  accessToken: 'TDSYNNEX_ACCESS_TOKEN',
} as const;

export const HEADER_NAMES = {
  accountId: 'X-TDSynnex-Account-Id',
  accessToken: 'X-TDSynnex-Access-Token',
} as const;

/** ION ids in paths (account, customer, order, subscription, report) are integers in the docs. */
const NUMERIC_ID_RE = /^\d{1,20}$/;
/** Product and cart ids: the docs show strings like "AcronisCyberProtection-smp"; this is a conservative pattern. */
const REF_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** Bearer tokens are opaque; allow the usual token characters only, so nothing odd reaches a header. */
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{8,4096}$/;

export function isNumericId(value: string): boolean {
  return NUMERIC_ID_RE.test(value);
}

export function isRefId(value: string): boolean {
  return REF_ID_RE.test(value);
}

export function isValidToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

function clean(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t ? t : undefined;
}

/** True unless READ_ONLY_MODE is exactly the string "false". Read on every call. */
export function isReadOnlyMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.READ_ONLY_MODE !== 'false';
}

export interface EnvCredentialConfig {
  accountId: string;
  /** Present when a refresh token (or a token file) is configured: the server owns exchange and rotation. */
  refresh?: { initialToken?: string; file?: string };
  /** Static access token (no refresh). Used only when no refresh token or file is configured. */
  accessToken?: string;
}

/** Credentials from process.env (stdio and AUTH_MODE=env). Throws ConfigError, naming variables only. */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): EnvCredentialConfig {
  const accountId = clean(env[ENV_NAMES.accountId]);
  if (!accountId) {
    throw new ConfigError(
      `Missing ${ENV_NAMES.accountId}. Set it (with ${ENV_NAMES.refreshToken} or ${ENV_NAMES.accessToken}) to your StreamOne ION reseller account id.`,
    );
  }
  if (!isNumericId(accountId)) throw new ConfigError(`${ENV_NAMES.accountId} must be the numeric StreamOne ION account id.`);

  const refreshToken = clean(env[ENV_NAMES.refreshToken]);
  const file = clean(env[ENV_NAMES.refreshTokenFile]);
  const accessToken = clean(env[ENV_NAMES.accessToken]);
  if (refreshToken && !isValidToken(refreshToken)) throw new ConfigError(`${ENV_NAMES.refreshToken} has an invalid format.`);
  if (accessToken && !isValidToken(accessToken)) throw new ConfigError(`${ENV_NAMES.accessToken} has an invalid format.`);

  if (refreshToken || file) return { accountId, refresh: { initialToken: refreshToken, file } };
  if (accessToken) return { accountId, accessToken };
  throw new ConfigError(
    `Missing credentials: set ${ENV_NAMES.refreshToken} (or ${ENV_NAMES.refreshTokenFile}) or ${ENV_NAMES.accessToken}.`,
  );
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? clean(raw) : undefined;
}

/** True when the request carries either ION credential header. */
export function hasCredentialHeaders(headers: IncomingHttpHeaders): boolean {
  return Object.values(HEADER_NAMES).some((h) => headerValue(headers[h.toLowerCase()]));
}

/** Credentials from X-TDSynnex-* request headers. Both are required; throws ConfigError otherwise. */
export function credentialsFromHeaders(headers: IncomingHttpHeaders): RequestCredentials {
  const accountId = headerValue(headers[HEADER_NAMES.accountId.toLowerCase()]);
  const accessToken = headerValue(headers[HEADER_NAMES.accessToken.toLowerCase()]);
  if (!accountId || !accessToken) {
    const missing: string[] = [];
    if (!accountId) missing.push(HEADER_NAMES.accountId);
    if (!accessToken) missing.push(HEADER_NAMES.accessToken);
    throw new ConfigError(
      `missing required gateway credential header(s): ${missing.map((n) => n.toLowerCase()).join(', ')}. ` +
        `Send both ${HEADER_NAMES.accountId.toLowerCase()} and ${HEADER_NAMES.accessToken.toLowerCase()}.`,
    );
  }
  if (!isNumericId(accountId)) throw new ConfigError(`${HEADER_NAMES.accountId} must be the numeric StreamOne ION account id.`);
  if (!isValidToken(accessToken)) throw new ConfigError(`${HEADER_NAMES.accessToken} has an invalid format.`);
  return { accountId, accessToken };
}
