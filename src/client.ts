/**
 * StreamOne ION v3 API client.
 *
 * Built ONLY from the public vendor documentation (never exercised against the
 * live API). Sources:
 *   - https://docs.streamone.cloud/                       (full reference; section anchors such as
 *     #list-customers, #get-customer, #create-customer, #update-customer, #get-customer-cloud-profiles,
 *     #list-products, #get-product, #get-product-pricing, #list-account-orders, #list-customer-orders,
 *     #get-order, #create-order, #cancel-order, #list-customer-subscriptions,
 *     #get-customer-subscription-details, #list-cart, #get-cart, #create-cart, #checkout-cart,
 *     #list-cart-items, and the Authentication section)
 *   - https://www.tdsynnex.com/ion/v3api/                 (Swagger portal, authoritative per the docs;
 *     JS-rendered, so NOT machine-read when this client was written)
 *   - https://www.tdsynnex.com/ion/api/                   (StreamOne ION API landing page)
 *
 * Auth (docs, "Authentication"): POST https://ion.tdsynnex.com/oauth/token as multipart/form-data with
 * grant_type=refresh_token, redirect_uri=http://localhost/, refresh_token=<token>. The response carries
 * access_token (expires_in 7200), a NEW refresh_token, token_type Bearer. Refresh tokens are single-use:
 * each exchange invalidates the old one. API calls send `Authorization: Bearer <access_token>`.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigError, credentialsFromEnv, type EnvCredentialConfig } from './config.js';
import { scopedCredentials } from './credentials.js';
import { logger } from './utils/logger.js';
import { redact } from './utils/redact.js';

export const API_BASE = 'https://ion.tdsynnex.com/api/v3';
export const TOKEN_URL = 'https://ion.tdsynnex.com/oauth/token';

/** Refresh the access token this far before its stated expiry. */
export const REFRESH_SKEW_MS = 60_000;
const DEFAULT_EXPIRES_IN_S = 7200;
const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_TIMEOUT_MS = 15_000;
const MAX_ERROR_TEXT = 500;

export type QueryValue = string | number | boolean | undefined;

/** Encodes one path segment. Every caller-supplied path segment goes through this. */
export const seg = (value: string | number): string => encodeURIComponent(String(value));

/** The vendor rejected the token or token exchange; the user has to reconnect / re-authenticate. */
export class TdSynnexAuthError extends Error {}

/** Non-2xx API response. Message is built from the documented error body (error/message/code/requestId) only. */
export class TdSynnexApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------
// Token manager (AUTH_MODE=env / stdio)
// ---------------------------------------------------------------------

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
}

/**
 * Exchanges and rotates the refresh token. One instance per process (env mode is single-tenant).
 * Refresh tokens are single-use, so exchanges are single-flighted and never retried automatically.
 */
export class TokenManager {
  private refreshToken: string | undefined;
  private loaded = false;
  private access: { token: string; expiresAt: number } | undefined;
  private inflight: Promise<string> | undefined;
  private warnedNoFile = false;

  constructor(private readonly cfg: { initialToken?: string; file?: string }) {}

  /** Exact secret values currently held, for scrubbing error text. */
  secrets(): string[] {
    return [this.refreshToken, this.access?.token].filter((s): s is string => !!s);
  }

  /** Drops the cached access token so the next call exchanges the refresh token. */
  invalidate(): void {
    this.access = undefined;
  }

  async getAccessToken(): Promise<string> {
    if (this.access && this.access.expiresAt - REFRESH_SKEW_MS > Date.now()) return this.access.token;
    // Concurrent callers share one exchange: a second one would present an already-used refresh token.
    this.inflight ??= this.exchange().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async loadInitial(): Promise<void> {
    if (this.loaded) return;
    // A token file holds the latest rotated token, so it wins over the (possibly stale) env bootstrap value.
    if (this.cfg.file) {
      try {
        const fromFile = (await fs.readFile(this.cfg.file, 'utf8')).trim();
        if (fromFile) this.refreshToken = fromFile;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new ConfigError('Could not read the file named by TDSYNNEX_REFRESH_TOKEN_FILE.');
        }
      }
    }
    this.refreshToken ??= this.cfg.initialToken;
    this.loaded = true;
  }

  private async exchange(): Promise<string> {
    await this.loadInitial();
    if (!this.refreshToken) {
      throw new TdSynnexAuthError(
        'No refresh token is available. Generate one in the StreamOne ION portal (Settings > Users > Edit > OAuth credentials > Request New Credentials) and set TDSYNNEX_REFRESH_TOKEN or TDSYNNEX_REFRESH_TOKEN_FILE.',
      );
    }
    if (!this.cfg.file && !this.warnedNoFile) {
      this.warnedNoFile = true;
      logger.warn(
        'StreamOne ION refresh tokens are single-use and rotate on every exchange. The rotated token is held in memory only; ' +
          'after a restart the originally configured token will be invalid. Set TDSYNNEX_REFRESH_TOKEN_FILE to persist it.',
      );
    }

    const form = new FormData();
    form.append('grant_type', 'refresh_token');
    form.append('redirect_uri', 'http://localhost/');
    form.append('refresh_token', this.refreshToken);

    let res: Response;
    try {
      res = await fetch(TOKEN_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
    } catch (err) {
      // Not retried: the request may have reached ION and consumed the single-use token.
      throw new TdSynnexAuthError(
        `Could not reach the StreamOne ION token endpoint (${(err as Error).name || 'network error'}). The refresh token may or may not have been consumed; if later calls fail with an auth error, generate a new refresh token in the ION portal.`,
      );
    }
    const text = await res.text();
    if (!res.ok) {
      throw new TdSynnexAuthError(
        `StreamOne ION rejected the token exchange (HTTP ${res.status}${describeBody(text)}). The refresh token is probably expired, already used, or revoked: generate a new one in the ION portal (Settings > Users > Edit > OAuth credentials > Request New Credentials) and reconnect.`,
      );
    }
    let body: TokenResponse;
    try {
      body = JSON.parse(text) as TokenResponse;
    } catch {
      throw new TdSynnexAuthError('The StreamOne ION token endpoint returned a response that is not JSON.');
    }
    if (typeof body.access_token !== 'string' || !body.access_token) {
      throw new TdSynnexAuthError('The StreamOne ION token response did not include an access_token.');
    }
    const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : DEFAULT_EXPIRES_IN_S;
    this.access = { token: body.access_token, expiresAt: Date.now() + expiresIn * 1000 };

    if (typeof body.refresh_token === 'string' && body.refresh_token) {
      this.refreshToken = body.refresh_token;
      await this.persist(body.refresh_token);
    }
    return body.access_token;
  }

  private async persist(token: string): Promise<void> {
    const file = this.cfg.file;
    if (!file) return;
    const tmp = join(dirname(file), `.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await fs.writeFile(tmp, `${token}\n`, { mode: 0o600 });
      await fs.rename(tmp, file);
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      logger.error(
        'Could not persist the rotated StreamOne ION refresh token to TDSYNNEX_REFRESH_TOKEN_FILE. It is held in memory only; a restart will need a new token from the ION portal.',
      );
    }
  }
}

let envManager: TokenManager | undefined;
let envManagerKey: string | undefined;

/** Test hook: forget cached env-mode token state. */
export function resetAuthState(): void {
  envManager = undefined;
  envManagerKey = undefined;
}

function managerFor(cfg: EnvCredentialConfig): TokenManager {
  const key = JSON.stringify([cfg.refresh?.initialToken, cfg.refresh?.file]);
  if (!envManager || envManagerKey !== key) {
    envManager = new TokenManager(cfg.refresh ?? {});
    envManagerKey = key;
  }
  return envManager;
}

// ---------------------------------------------------------------------
// Session: account id + authenticated request function
// ---------------------------------------------------------------------

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export interface Session {
  accountId: string;
  /** Sends an authenticated request. `path` is relative to /api/v3 and already has encoded segments. */
  request<T = unknown>(method: 'GET' | 'POST' | 'PUT', path: string, opts?: RequestOptions): Promise<T>;
  /** Exact secret values held for this session, for scrubbing error text. */
  secrets(): string[];
}

/**
 * Resolves the current credentials: the request-scoped gateway headers when a scope exists (never falling
 * back to env), otherwise TDSYNNEX_* from process.env. Does not contact ION.
 */
export function getSession(): Session {
  const scoped = scopedCredentials();
  if (scoped) {
    return {
      accountId: scoped.accountId,
      request: (method, path, opts) => send(method, path, opts, async () => scoped.accessToken, undefined),
      secrets: () => [scoped.accessToken],
    };
  }
  const cfg = credentialsFromEnv();
  if (cfg.refresh) {
    const manager = managerFor(cfg);
    return {
      accountId: cfg.accountId,
      request: (method, path, opts) => send(method, path, opts, () => manager.getAccessToken(), manager),
      secrets: () => manager.secrets(),
    };
  }
  const staticToken = cfg.accessToken!;
  return {
    accountId: cfg.accountId,
    request: (method, path, opts) => send(method, path, opts, async () => staticToken, undefined),
    secrets: () => [staticToken],
  };
}

/** Exact secrets held right now (for scrubbing), without throwing when credentials are not configured. */
export function currentSecrets(): string[] {
  try {
    return getSession().secrets();
  } catch {
    return [];
  }
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** Short, token-free rendering of a documented error body: ": error - message, code N, requestId X". */
function describeBody(text: string): string {
  const parsed = parseErrorBody(text);
  if (!parsed) return '';
  const parts = [parsed.error, parsed.message].filter(Boolean).join(' - ');
  const extra = [parsed.code !== undefined ? `code ${parsed.code}` : '', parsed.requestId ? `requestId ${parsed.requestId}` : '']
    .filter(Boolean)
    .join(', ');
  return `: ${[parts, extra].filter(Boolean).join(', ')}`;
}

function parseErrorBody(text: string): { error?: string; message?: string; code?: string | number; requestId?: string } | undefined {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (!j || typeof j !== 'object') return undefined;
    const details = Array.isArray(j.details) ? (j.details as Array<Record<string, unknown>>) : [];
    const requestId = details.map((d) => d?.requestId).find((r): r is string => typeof r === 'string');
    const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, MAX_ERROR_TEXT) : undefined);
    const code = typeof j.code === 'string' || typeof j.code === 'number' ? j.code : undefined;
    return { error: str(j.error), message: str(j.message), code, requestId };
  } catch {
    return undefined;
  }
}

async function send<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  opts: RequestOptions | undefined,
  getToken: () => Promise<string>,
  manager: TokenManager | undefined,
): Promise<T> {
  const url = buildUrl(path, opts?.query);
  const attempt = async (token: string): Promise<Response> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    let body: string | undefined;
    if (opts?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    return fetch(url, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  };

  let res = await attempt(await getToken());
  // A 401 means the request was not processed, so one retry after a forced refresh is safe even for writes.
  // Only when this process owns the refresh token; gateway/static tokens cannot be renewed here.
  if (res.status === 401 && manager) {
    manager.invalidate();
    res = await attempt(await getToken());
  }

  const text = await res.text();
  if (!res.ok) {
    const parsed = parseErrorBody(text);
    const detail = describeBody(text);
    if (res.status === 401) {
      throw new TdSynnexAuthError(
        `TD SYNNEX rejected the access token (HTTP 401${detail}). It is expired or revoked: reconnect this connection (gateway: refresh the stored credentials; local: generate a new refresh token in the ION portal).`,
      );
    }
    const message = redact(`TD SYNNEX StreamOne ION API error: HTTP ${res.status}${detail || ''}`);
    throw new TdSynnexApiError(message, res.status, parsed?.requestId);
  }
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TdSynnexApiError('TD SYNNEX returned a success response that is not JSON.', res.status);
  }
}
