import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redact, redactOutput, sanitizeForLog } from '../utils/redact.js';
import { logger } from '../utils/logger.js';
import { call, jsonResponse, mockFetch, useStaticCreds, STATIC_TOKEN } from './test-helpers.js';

beforeEach(() => useStaticCreds());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('redactOutput', () => {
  it('removes password / token fields at any depth, keeps the rest', () => {
    const out = redactOutput({
      a: 'x',
      user: { password: 'p@ss', Password: 'q', nested: [{ refresh_token: 'r', accessToken: 't', keep: 1 }] },
    }) as any;
    expect(out.user.password).toBe('[redacted]');
    expect(out.user.Password).toBe('[redacted]');
    expect(out.user.nested[0]).toEqual({ refresh_token: '[redacted]', accessToken: '[redacted]', keep: 1 });
    expect(out.a).toBe('x');
  });
});

describe('redact / logger', () => {
  it('scrubs bearer tokens, JSON/form secrets, JWTs, URLs with queries and literal secrets', () => {
    const text = redact(
      'Authorization: Bearer abc.def-123 {"refresh_token":"zzz999","password":"hunter22"} refresh_token=qqq111&x=1 eyJhbGciOi.eyJzdWIi.sig https://x.test/a?token=1 literal-secret-value',
      ['literal-secret-value'],
    );
    for (const leaked of ['abc.def-123', 'zzz999', 'hunter22', 'qqq111', 'eyJhbGciOi', 'token=1', 'literal-secret-value']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('logger never writes token-bearing context', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')));
    logger.error('failed with Bearer secret-bearer-1234', { accessToken: 'tok-1234567', refresh_token: 'ref-1234567', nested: { password: 'pw-1234567', ok: 'fine' } });
    const text = lines.join('\n');
    expect(text).not.toMatch(/secret-bearer-1234|tok-1234567|ref-1234567|pw-1234567/);
    expect(text).toContain('fine');
    expect(sanitizeForLog({ authorization: 'x' })).toEqual({ authorization: '[redacted]' });
  });
});

describe('tool output and errors', () => {
  it('redacts a password echoed in any tool result', async () => {
    mockFetch(() => jsonResponse({ customers: [{ user: { password: 'leak-me-123' } }] }));
    const r = await call('tdsynnex_list_customers');
    expect(r.text).not.toContain('leak-me-123');
  });

  it('scrubs the access token if the vendor echoes it in an error message', async () => {
    mockFetch(() => jsonResponse({ error: 'BAD', message: `token ${STATIC_TOKEN} is bad`, code: 400 }, 400));
    const r = await call('tdsynnex_get_customer', { customerId: '1' });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain(STATIC_TOKEN);
  });
});
