import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT, call, jsonResponse, mockFetch, useStaticCreds } from './test-helpers.js';

const BASE = 'https://ion.tdsynnex.com/api/v3';

beforeEach(() => {
  useStaticCreds();
  process.env.READ_ONLY_MODE = 'false';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const customer = {
  customerOrganization: 'SilverLeaf',
  customerAddress: { street: '12 N Basilica Ave', city: 'North Charleston', state: 'SC', zip: '29410', country: 'US', suite: '12' },
  customerName: 'Alex March',
  customerEmail: 'alexmarch22@tdsynnex.com',
  languageCode: 'en',
  customerTitle: 'Ms.',
  customerPhone: '9876543210',
};

describe('non-order write tools (single step)', () => {
  it('create_customer POSTs the documented body and redacts the generated password', async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({
        name: 'accounts/1234/customers/108536',
        customerOrganization: 'SilverLeaf',
        user: { name: 'accounts/1234/customers/108536/users/1', userName: 'DEFAULT ACCOUNT USER', password: '6wNTv1N^7%&c' },
      }),
    );
    const r = await call('tdsynnex_create_customer', customer);
    expect(r.isError).toBe(false);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url.toString()).toBe(`${BASE}/accounts/${ACCOUNT}/customers`);
    expect(JSON.parse(calls[0].body as string)).toEqual(customer);
    expect(r.text).not.toContain('6wNTv1N');
    expect(r.json?.user.password).toBe('[redacted]');
    expect(r.json?.user.userName).toBe('DEFAULT ACCOUNT USER');
  });

  it('create_customer requires customerTitle; update_customer does not', async () => {
    const { calls } = mockFetch(() => jsonResponse({}));
    const { customerTitle: _t, ...noTitle } = customer;
    const bad = await call('tdsynnex_create_customer', noTitle);
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('customerTitle');
    expect(calls).toHaveLength(0);
    const ok = await call('tdsynnex_update_customer', { customerId: '56789', ...noTitle });
    expect(ok.isError).toBe(false);
  });

  it('create_customer validates email, language code and unknown address keys', async () => {
    const { calls } = mockFetch(() => jsonResponse({}));
    expect((await call('tdsynnex_create_customer', { ...customer, customerEmail: 'nope' })).isError).toBe(true);
    expect((await call('tdsynnex_create_customer', { ...customer, languageCode: 'english' })).isError).toBe(true);
    expect((await call('tdsynnex_create_customer', { ...customer, customerAddress: { ...customer.customerAddress, bogus: 'x' } })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('update_customer PUTs to the customer path', async () => {
    const { calls } = mockFetch(() => jsonResponse({ name: 'x' }));
    const { customerTitle: _t, ...rest } = customer;
    const r = await call('tdsynnex_update_customer', { customerId: '56789', ...rest });
    expect(r.isError).toBe(false);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url.toString()).toBe(`${BASE}/accounts/${ACCOUNT}/customers/56789`);
    expect(JSON.parse(calls[0].body as string)).toEqual(rest);
  });

  it('create_cart POSTs to /customers/{id}/carts (no accounts prefix, as documented)', async () => {
    const { calls } = mockFetch(() => jsonResponse({ name: '1234', status: 'QUOTE' }));
    const r = await call('tdsynnex_create_cart', {
      customerId: '1234',
      cartDisplayName: 'Quote - 1',
      userName: 'John',
      paymentType: 'OFFLINE',
      creditCardName: 'JD',
      status: 'QUOTE',
      currencyCode: 'usd',
    });
    expect(r.isError).toBe(false);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url.toString()).toBe(`${BASE}/customers/1234/carts`);
    expect(JSON.parse(calls[0].body as string)).toEqual({
      cartDisplayName: 'Quote - 1',
      userName: 'John',
      payment: { paymentType: 'OFFLINE', creditCardName: 'JD' },
      status: 'QUOTE',
      currencyCode: 'USD',
    });
  });

  it('create_cart rejects bad enum values', async () => {
    const { calls } = mockFetch(() => jsonResponse({}));
    const r = await call('tdsynnex_create_cart', { customerId: '1', cartDisplayName: 'a', userName: 'b', paymentType: 'BITCOIN', status: 'QUOTE', currencyCode: 'USD' });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('write tool descriptions', () => {
  it('start with the write / explicit-approval note', async () => {
    const { ALL_TOOLS } = await import('../tools/index.js');
    for (const t of ALL_TOOLS.filter((x) => x.annotations?.readOnlyHint === false)) {
      expect(t.description, t.name).toMatch(/^WRITE OPERATION: this changes data at TD SYNNEX StreamOne ION and needs the user's explicit approval/);
    }
  });
});
