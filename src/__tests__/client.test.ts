import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_SKEW_MS, TdSynnexApiError, TdSynnexAuthError, getSession, seg } from '../client.js';
import { ConfigError } from '../config.js';
import { runWithCredentials } from '../credentials.js';
import { ACCOUNT, STATIC_TOKEN, jsonResponse, mockFetch, resetEnv, useStaticCreds } from './test-helpers.js';

/** Awaits a promise that is expected to reject and returns the error. */
async function rejection<E extends Error = Error>(p: Promise<unknown>): Promise<E> {
  try {
    await p;
  } catch (e) {
    return e as E;
  }
  throw new Error('expected the promise to reject');
}

const tokenBody = (access: string, refresh: string, expires = 7200) => ({
  access_token: access,
  expires_in: expires,
  refresh_token: refresh,
  token_type: 'Bearer',
});

beforeEach(() => {
  resetEnv();
  process.env.TDSYNNEX_ACCOUNT_ID = ACCOUNT;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetEnv();
});

describe('token exchange (refresh token env mode)', () => {
  it('posts multipart form fields to /oauth/token and sends a Bearer header on API calls', async () => {
    process.env.TDSYNNEX_REFRESH_TOKEN = 'refresh-token-R1';
    const { calls } = mockFetch((c) =>
      c.url.pathname === '/oauth/token' ? jsonResponse(tokenBody('access-A1-token', 'refresh-token-R2')) : jsonResponse({ customers: [] }),
    );
    const s = getSession();
    expect(s.accountId).toBe(ACCOUNT);
    await s.request('GET', '/accounts/1234/customers', { query: { pageSize: 5 } });

    expect(calls[0].url.toString()).toBe('https://ion.tdsynnex.com/oauth/token');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toBeInstanceOf(FormData);
    const form = calls[0].body as FormData;
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('redirect_uri')).toBe('http://localhost/');
    expect(form.get('refresh_token')).toBe('refresh-token-R1');

    expect(calls[1].url.toString()).toBe('https://ion.tdsynnex.com/api/v3/accounts/1234/customers?pageSize=5');
    expect(calls[1].headers.Authorization).toBe('Bearer access-A1-token');
  });

  it('caches the access token until ~60s before expiry, then exchanges the rotated refresh token', async () => {
    vi.useFakeTimers();
    process.env.TDSYNNEX_REFRESH_TOKEN = 'refresh-token-R1';
    let n = 0;
    const { calls } = mockFetch((c) => {
      if (c.url.pathname === '/oauth/token') {
        n++;
        return jsonResponse(tokenBody(`access-token-A${n}`, `refresh-token-R${n + 1}`, 7200));
      }
      return jsonResponse({});
    });
    const s = getSession();
    await s.request('GET', '/accounts/1234/customers');
    await s.request('GET', '/accounts/1234/customers');
    expect(calls.filter((c) => c.url.pathname === '/oauth/token')).toHaveLength(1);

    vi.advanceTimersByTime(7200 * 1000 - REFRESH_SKEW_MS - 1000);
    await s.request('GET', '/accounts/1234/customers');
    expect(calls.filter((c) => c.url.pathname === '/oauth/token')).toHaveLength(1);

    vi.advanceTimersByTime(2000);
    await s.request('GET', '/accounts/1234/customers');
    const exchanges = calls.filter((c) => c.url.pathname === '/oauth/token');
    expect(exchanges).toHaveLength(2);
    // The second exchange presents the ROTATED token, not the original.
    expect((exchanges[1].body as FormData).get('refresh_token')).toBe('refresh-token-R2');
    expect(calls.at(-1)!.headers.Authorization).toBe('Bearer access-token-A2');
  });

  it('single-flights concurrent calls into one exchange', async () => {
    process.env.TDSYNNEX_REFRESH_TOKEN = 'refresh-token-R1';
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { calls } = mockFetch(async (c) => {
      if (c.url.pathname === '/oauth/token') {
        await gate;
        return jsonResponse(tokenBody('access-token-A1', 'refresh-token-R2'));
      }
      return jsonResponse({ ok: true });
    });
    const s = getSession();
    const all = Promise.all([1, 2, 3, 4].map(() => s.request('GET', '/accounts/1234/customers')));
    await new Promise((r) => setTimeout(r, 10));
    release();
    await all;
    expect(calls.filter((c) => c.url.pathname === '/oauth/token')).toHaveLength(1);
    expect(calls.filter((c) => c.url.pathname !== '/oauth/token')).toHaveLength(4);
  });

  it('persists the rotated refresh token to TDSYNNEX_REFRESH_TOKEN_FILE (0600) and prefers the file on start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tdsynnex-'));
    const file = join(dir, 'refresh.token');
    process.env.TDSYNNEX_REFRESH_TOKEN_FILE = file;
    process.env.TDSYNNEX_REFRESH_TOKEN = 'refresh-token-STALE';
    await writeFile(file, 'refresh-token-FROMFILE\n');

    const { calls } = mockFetch((c) =>
      c.url.pathname === '/oauth/token' ? jsonResponse(tokenBody('access-token-A1', 'refresh-token-ROTATED')) : jsonResponse({}),
    );
    await getSession().request('GET', '/accounts/1234/customers');

    expect((calls[0].body as FormData).get('refresh_token')).toBe('refresh-token-FROMFILE');
    expect((await readFile(file, 'utf8')).trim()).toBe('refresh-token-ROTATED');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('bootstraps from TDSYNNEX_REFRESH_TOKEN when the token file does not exist yet, and creates it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tdsynnex-'));
    const file = join(dir, 'new.token');
    process.env.TDSYNNEX_REFRESH_TOKEN_FILE = file;
    process.env.TDSYNNEX_REFRESH_TOKEN = 'refresh-token-BOOT';
    const { calls } = mockFetch((c) =>
      c.url.pathname === '/oauth/token' ? jsonResponse(tokenBody('access-token-A1', 'refresh-token-NEXT')) : jsonResponse({}),
    );
    await getSession().request('GET', '/accounts/1234/customers');
    expect((calls[0].body as FormData).get('refresh_token')).toBe('refresh-token-BOOT');
    expect((await readFile(file, 'utf8')).trim()).toBe('refresh-token-NEXT');
  });

  it('keeps working (in memory) and logs an error without values when the file cannot be written', async () => {
    process.env.TDSYNNEX_REFRESH_TOKEN_FILE = '/nonexistent-dir-for-test/refresh.token';
    process.env.TDSYNNEX_REFRESH_TOKEN = 'refresh-token-R1';
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')));
    mockFetch((c) => (c.url.pathname === '/oauth/token' ? jsonResponse(tokenBody('access-token-A1', 'refresh-token-R2')) : jsonResponse({})));
    await expect(getSession().request('GET', '/accounts/1234/customers')).resolves.toEqual({});
    const text = errors.join('\n');
    expect(text).toContain('Could not persist');
    expect(text).not.toContain('refresh-token-R');
    expect(text).not.toContain('access-token-A1');
  });

  it('warns (no values) that the rotated token must be persisted when no file is configured', async () => {
    process.env.TDSYNNEX_REFRESH_TOKEN = 'refresh-token-R1';
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')));
    mockFetch((c) => (c.url.pathname === '/oauth/token' ? jsonResponse(tokenBody('access-token-A1', 'refresh-token-R2')) : jsonResponse({})));
    await getSession().request('GET', '/accounts/1234/customers');
    const text = errors.join('\n');
    expect(text).toContain('[WARN]');
    expect(text).toContain('TDSYNNEX_REFRESH_TOKEN_FILE');
    expect(text).not.toContain('refresh-token-R');
  });

  it('maps a rejected exchange to an auth error without echoing the refresh token, and does not retry it', async () => {
    process.env.TDSYNNEX_REFRESH_TOKEN = 'refresh-token-USED';
    const { calls } = mockFetch(() =>
      jsonResponse({ error: 'invalid_grant', message: 'refresh_token refresh-token-USED already used', code: 400 }, 400),
    );
    const err = await rejection<Error>(getSession().request('GET', '/accounts/1234/customers'));
    expect(err).toBeInstanceOf(TdSynnexAuthError);
    expect(calls).toHaveLength(1);
    expect((err as Error).message).toContain('HTTP 400');
    expect((err as Error).message).toContain('Request New Credentials');
  });

  it('on a 401 from the API forces one refresh and retries once', async () => {
    process.env.TDSYNNEX_REFRESH_TOKEN = 'refresh-token-R1';
    let apiCalls = 0;
    let n = 0;
    const { calls } = mockFetch((c) => {
      if (c.url.pathname === '/oauth/token') {
        n++;
        return jsonResponse(tokenBody(`access-token-A${n}`, `refresh-token-R${n + 1}`));
      }
      apiCalls++;
      return apiCalls === 1 ? jsonResponse({ error: 'UNAUTHENTICATED', message: 'expired', code: 401 }, 401) : jsonResponse({ ok: 1 });
    });
    await expect(getSession().request('GET', '/accounts/1234/customers')).resolves.toEqual({ ok: 1 });
    expect(calls.map((c) => c.url.pathname)).toEqual(['/oauth/token', '/api/v3/accounts/1234/customers', '/oauth/token', '/api/v3/accounts/1234/customers']);
    expect(calls[3].headers.Authorization).toBe('Bearer access-token-A2');
  });
});

describe('static and gateway tokens', () => {
  it('uses TDSYNNEX_ACCESS_TOKEN directly (no exchange) and a 401 tells the user to reconnect', async () => {
    useStaticCreds();
    const { calls } = mockFetch(() => jsonResponse({ error: 'UNAUTHENTICATED', message: 'bad token', code: 401 }, 401));
    const err = await rejection<Error>(getSession().request('GET', '/accounts/1234/customers'));
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${STATIC_TOKEN}`);
    expect(err).toBeInstanceOf(TdSynnexAuthError);
    expect((err as Error).message).toContain('reconnect');
    expect((err as Error).message).not.toContain(STATIC_TOKEN);
  });

  it('request-scoped gateway credentials take precedence and never fall back to env', async () => {
    useStaticCreds();
    const { calls } = mockFetch(() => jsonResponse({}));
    await runWithCredentials({ accountId: '777', accessToken: 'gateway-token-bbbb2222' }, async () => {
      const s = getSession();
      expect(s.accountId).toBe('777');
      await s.request('GET', '/accounts/777/customers');
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe('Bearer gateway-token-bbbb2222');
  });

  it('throws ConfigError naming variables (not values) when nothing is configured', () => {
    resetEnv();
    expect(() => getSession()).toThrow(ConfigError);
    process.env.TDSYNNEX_ACCOUNT_ID = ACCOUNT;
    expect(() => getSession()).toThrow(/TDSYNNEX_REFRESH_TOKEN/);
    process.env.TDSYNNEX_ACCOUNT_ID = '12 34';
    process.env.TDSYNNEX_ACCESS_TOKEN = 'secret-value-should-not-appear';
    try {
      getSession();
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-value-should-not-appear');
      expect((e as Error).message).toContain('TDSYNNEX_ACCOUNT_ID');
    }
  });
});

describe('error mapping and request building', () => {
  beforeEach(() => useStaticCreds());

  it('surfaces error, message, code and requestId from the documented error body', async () => {
    mockFetch(() =>
      jsonResponse(
        { error: 'NOT_FOUND', message: 'customer not found', code: 404, details: [{ '@type': 'type.googleapis.com/google.rpc.RequestInfo', requestId: 'req-123abc' }] },
        404,
      ),
    );
    const err = await rejection<TdSynnexApiError>(getSession().request('GET', '/accounts/1234/customers/9'));
    expect(err).toBeInstanceOf(TdSynnexApiError);
    expect(err.message).toContain('HTTP 404');
    expect(err.message).toContain('NOT_FOUND');
    expect(err.message).toContain('customer not found');
    expect(err.message).toContain('code 404');
    expect(err.message).toContain('req-123abc');
    expect(err.requestId).toBe('req-123abc');
    expect(err.message).not.toContain(STATIC_TOKEN);
  });

  it('copes with non-JSON error bodies and omits them from the message', async () => {
    mockFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    const err = await rejection<Error>(getSession().request('GET', '/accounts/1234/customers'));
    expect(err.message).toContain('HTTP 502');
    expect(err.message).not.toContain('<html>');
  });

  it('sends JSON bodies with Content-Type and omits undefined query params', async () => {
    const { calls } = mockFetch(() => jsonResponse({}));
    await getSession().request('POST', '/accounts/1234/customers', { body: { a: 1 }, query: { x: undefined, y: 'b c', z: false } });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(calls[0].body).toBe('{"a":1}');
    expect(calls[0].url.search).toBe('?y=b+c&z=false');
  });

  it('encodes path segments', () => {
    expect(seg('a/b c?d')).toBe('a%2Fb%20c%3Fd');
    expect(seg('GB,CFQ7:0002')).toBe('GB%2CCFQ7%3A0002');
  });
});
