import { describe, expect, it } from 'vitest';
import { ConfigError, credentialsFromEnv, credentialsFromHeaders, hasCredentialHeaders, isNumericId, isRefId } from '../config.js';

describe('credentialsFromEnv', () => {
  it('prefers refresh token / file over a static access token', () => {
    const c = credentialsFromEnv({ TDSYNNEX_ACCOUNT_ID: '1', TDSYNNEX_REFRESH_TOKEN: 'refresh-token-1', TDSYNNEX_ACCESS_TOKEN: 'access-token-1' });
    expect(c.refresh?.initialToken).toBe('refresh-token-1');
    expect(c.accessToken).toBeUndefined();
    expect(credentialsFromEnv({ TDSYNNEX_ACCOUNT_ID: '1', TDSYNNEX_REFRESH_TOKEN_FILE: '/tmp/x' }).refresh?.file).toBe('/tmp/x');
    expect(credentialsFromEnv({ TDSYNNEX_ACCOUNT_ID: '1', TDSYNNEX_ACCESS_TOKEN: 'access-token-1' }).accessToken).toBe('access-token-1');
  });

  it.each([
    [{}, /TDSYNNEX_ACCOUNT_ID/],
    [{ TDSYNNEX_ACCOUNT_ID: 'abc', TDSYNNEX_ACCESS_TOKEN: 'access-token-1' }, /numeric/],
    [{ TDSYNNEX_ACCOUNT_ID: '1' }, /TDSYNNEX_REFRESH_TOKEN/],
    [{ TDSYNNEX_ACCOUNT_ID: '1', TDSYNNEX_ACCESS_TOKEN: 'bad token!' }, /TDSYNNEX_ACCESS_TOKEN has an invalid format/],
  ])('rejects %j', (env, re) => {
    expect(() => credentialsFromEnv(env)).toThrow(ConfigError);
    expect(() => credentialsFromEnv(env)).toThrow(re);
  });
});

describe('credentialsFromHeaders', () => {
  it('requires both headers and validates them without echoing values', () => {
    expect(credentialsFromHeaders({ 'x-tdsynnex-account-id': ' 42 ', 'x-tdsynnex-access-token': 'token-value-12345' })).toEqual({
      accountId: '42',
      accessToken: 'token-value-12345',
    });
    expect(() => credentialsFromHeaders({})).toThrow(/x-tdsynnex-account-id, x-tdsynnex-access-token/);
    expect(() => credentialsFromHeaders({ 'x-tdsynnex-account-id': '42' })).toThrow(/x-tdsynnex-access-token/);
    expect(hasCredentialHeaders({})).toBe(false);
    expect(hasCredentialHeaders({ 'x-tdsynnex-account-id': '42' })).toBe(true);
  });
});

describe('id patterns', () => {
  it('numeric ids are digits only; reference ids use a conservative charset', () => {
    expect(isNumericId('12345')).toBe(true);
    for (const bad of ['', '1a', '-1', '1.5', ' 1', '1/2', '9'.repeat(21)]) expect(isNumericId(bad)).toBe(false);
    expect(isRefId('AcronisCyberProtection-smp')).toBe(true);
    expect(isRefId('a:b.c_d-1')).toBe(true);
    for (const bad of ['', 'a b', 'a/b', 'a?b', '..%2f', 'x'.repeat(129)]) expect(isRefId(bad)).toBe(false);
  });
});
