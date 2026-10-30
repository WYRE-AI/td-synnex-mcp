import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isReadOnlyMode } from '../config.js';
import { ALL_TOOLS, listTools } from '../tools/index.js';
import { call, jsonResponse, mockFetch, useStaticCreds } from './test-helpers.js';

const WRITE_NAMES = [
  'tdsynnex_create_customer',
  'tdsynnex_update_customer',
  'tdsynnex_create_order',
  'tdsynnex_cancel_order',
  'tdsynnex_create_cart',
  'tdsynnex_checkout_cart',
];

beforeEach(() => useStaticCreds());
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.READ_ONLY_MODE;
});

describe('READ_ONLY_MODE', () => {
  it.each([undefined, '', 'true', 'TRUE', 'False', ' false', 'false ', '0', 'no'])(
    'is read-only unless exactly "false" (value %j)',
    (value) => {
      expect(isReadOnlyMode({ READ_ONLY_MODE: value })).toBe(true);
    },
  );

  it('is writable only for exactly "false"', () => {
    expect(isReadOnlyMode({ READ_ONLY_MODE: 'false' })).toBe(false);
  });

  it('defaults to read-only: write tools are not listed and are refused without a vendor call', async () => {
    delete process.env.READ_ONLY_MODE;
    const listed = listTools().map((t) => t.name);
    for (const w of WRITE_NAMES) expect(listed).not.toContain(w);
    expect(listed).toContain('tdsynnex_get_product_pricing');
    expect(listed.length).toBe(ALL_TOOLS.length - WRITE_NAMES.length);
    expect(listTools().every((t) => t.annotations?.readOnlyHint === true)).toBe(true);

    const { calls } = mockFetch(() => jsonResponse({}));
    for (const w of WRITE_NAMES) {
      const r = await call(w, { customerId: '1' });
      expect(r.isError, w).toBe(true);
      expect(r.text, w).toContain('read-only');
    }
    expect(calls).toHaveLength(0);
  });

  it('READ_ONLY_MODE=false lists and enables the write tools', async () => {
    process.env.READ_ONLY_MODE = 'false';
    expect(listTools().map((t) => t.name)).toEqual(ALL_TOOLS.map((t) => t.name));
    mockFetch(() => jsonResponse({}));
    const r = await call('tdsynnex_cancel_order', { customerId: '1', orderId: '2' });
    expect(r.isError).toBe(false);
    expect(r.json?.preview).toBe(true);
  });

  it('read tools keep working in read-only mode', async () => {
    const { calls } = mockFetch(() => jsonResponse({ customers: [] }));
    const r = await call('tdsynnex_list_customers');
    expect(r.isError).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('unknown tools are an error', async () => {
    expect((await call('tdsynnex_nope')).isError).toBe(true);
  });
});
