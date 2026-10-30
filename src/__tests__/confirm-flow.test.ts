import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIRM_TOKEN_TTL_MS, canonicalJson, loadConfirmSecret, loadOrderLimits, makeConfirmToken } from '../order-safety.js';
import { ConfigError } from '../config.js';
import { ACCOUNT, call, jsonResponse, mockFetch, useStaticCreds } from './test-helpers.js';

const BASE = 'https://ion.tdsynnex.com/api/v3';

const order = {
  customerId: '56789',
  referenceId: 'my-order',
  displayName: 'M365',
  orderItems: [
    {
      productId: 'Microsoft365EandFNCE-isvfrnce',
      skuId: 'Microsoft-Teams-Rooms-Standard',
      planId: 'Monthly-Plan-n9',
      quantity: 3,
      attributes: [{ name: 'renewalSetting', value: 'auto_on' }],
      endCustomerPO: '101',
      resellerPO: '202',
    },
  ],
};

beforeEach(() => {
  useStaticCreds();
  process.env.READ_ONLY_MODE = 'false';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('create_order preview / confirm', () => {
  it('first call previews (no vendor request) and returns a bound token', async () => {
    const { calls } = mockFetch(() => jsonResponse({}));
    const r = await call('tdsynnex_create_order', order);
    expect(r.isError).toBe(false);
    expect(calls).toHaveLength(0);
    expect(r.json?.preview).toBe(true);
    expect(r.json?.sent).toBe(false);
    expect(r.json?.willSend.method).toBe('POST');
    expect(r.json?.willSend.url).toBe(`${BASE}/accounts/${ACCOUNT}/customers/56789/orders`);
    expect(r.json?.willSend.body.orderItems[0]).toMatchObject({ action: 'CREATE', quantity: 3, planId: 'Monthly-Plan-n9' });
    expect(r.json?.confirmToken).toMatch(/^\d+\.[0-9a-f]{64}$/);
    expect(r.json?.confirmTokenValidMinutes).toBe(30);
    expect(r.text).not.toMatch(/Bearer|static-access-token/);
  });

  it('a valid token performs the write exactly once with the previewed body', async () => {
    const { calls } = mockFetch(() => jsonResponse({ name: 'accounts/1234/customers/56789/orders/9', status: 'NEW' }));
    const preview = await call('tdsynnex_create_order', order);
    const done = await call('tdsynnex_create_order', { ...order, confirmToken: preview.json!.confirmToken });
    expect(done.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url.toString()).toBe(`${BASE}/accounts/${ACCOUNT}/customers/56789/orders`);
    expect(JSON.parse(calls[0].body as string)).toEqual(preview.json!.willSend.body);
    expect(done.json?.status).toBe('NEW');
  });

  it('the token is single-use: a replay is refused without a second order', async () => {
    const { calls } = mockFetch(() => jsonResponse({ status: 'NEW' }));
    const preview = await call('tdsynnex_create_order', order);
    const args = { ...order, confirmToken: preview.json!.confirmToken };
    expect((await call('tdsynnex_create_order', args)).isError).toBe(false);
    const again = await call('tdsynnex_create_order', args);
    expect(again.isError).toBe(true);
    expect(again.text).toContain('already used');
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['changed quantity', (o: typeof order) => ({ ...o, orderItems: [{ ...o.orderItems[0], quantity: 4 }] })],
    ['changed sku', (o: typeof order) => ({ ...o, orderItems: [{ ...o.orderItems[0], skuId: 'Other-Sku' }] })],
    ['added line', (o: typeof order) => ({ ...o, orderItems: [...o.orderItems, o.orderItems[0]] })],
    ['changed attribute', (o: typeof order) => ({ ...o, orderItems: [{ ...o.orderItems[0], attributes: [{ name: 'renewalSetting', value: 'cancel_at_renewal' }] }] })],
    ['different customer', (o: typeof order) => ({ ...o, customerId: '56790' })],
    ['changed reference', (o: typeof order) => ({ ...o, referenceId: 'other' })],
  ])('refuses a tampered request (%s)', async (_label, mutate) => {
    const { calls } = mockFetch(() => jsonResponse({}));
    const preview = await call('tdsynnex_create_order', order);
    const r = await call('tdsynnex_create_order', { ...mutate(order), confirmToken: preview.json!.confirmToken });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("doesn't match a preview");
    expect(calls).toHaveLength(0);
  });

  it('refuses a token issued for another account', async () => {
    const { calls } = mockFetch(() => jsonResponse({}));
    const preview = await call('tdsynnex_create_order', order);
    process.env.TDSYNNEX_ACCOUNT_ID = '9999';
    const r = await call('tdsynnex_create_order', { ...order, confirmToken: preview.json!.confirmToken });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('refuses a token issued for a different tool (cancel token on create_order and vice versa)', async () => {
    const { calls } = mockFetch(() => jsonResponse({}));
    const cancelPreview = await call('tdsynnex_cancel_order', { customerId: '56789', orderId: '1' });
    const r = await call('tdsynnex_create_order', { ...order, confirmToken: cancelPreview.json!.confirmToken });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it.each(['', 'garbage', '123.abc', `${Date.now()}.${'0'.repeat(64)}`, '9'.repeat(30)])('refuses malformed or forged token %j', async (token) => {
    const { calls } = mockFetch(() => jsonResponse({}));
    const r = await call('tdsynnex_create_order', { ...order, confirmToken: token });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('refuses an expired token (after 30 minutes)', async () => {
    vi.useFakeTimers();
    const { calls } = mockFetch(() => jsonResponse({}));
    const preview = await call('tdsynnex_create_order', order);
    vi.advanceTimersByTime(CONFIRM_TOKEN_TTL_MS - 1000);
    // still valid just before expiry -> would execute, so check expiry on a fresh preview instead
    const preview2 = await call('tdsynnex_create_order', { ...order, referenceId: 'second' });
    vi.advanceTimersByTime(CONFIRM_TOKEN_TTL_MS + 1000);
    const r = await call('tdsynnex_create_order', { ...order, referenceId: 'second', confirmToken: preview2.json!.confirmToken });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('expired');
    const r1 = await call('tdsynnex_create_order', { ...order, confirmToken: preview.json!.confirmToken });
    expect(r1.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('a failed vendor write still burns the token (needs a fresh preview)', async () => {
    const { calls } = mockFetch(() => jsonResponse({ error: 'INTERNAL_ERROR', message: 'boom', code: 500 }, 500));
    const preview = await call('tdsynnex_create_order', order);
    const args = { ...order, confirmToken: preview.json!.confirmToken };
    expect((await call('tdsynnex_create_order', args)).isError).toBe(true);
    const retry = await call('tdsynnex_create_order', args);
    expect(retry.text).toContain('already used');
    expect(calls).toHaveLength(1);
  });

  it('uses TDSYNNEX_CONFIRM_SECRET when set (token from another key is refused)', async () => {
    const { calls } = mockFetch(() => jsonResponse({}));
    process.env.TDSYNNEX_CONFIRM_SECRET = 'a'.repeat(40);
    const preview = await call('tdsynnex_create_order', order);
    process.env.TDSYNNEX_CONFIRM_SECRET = 'b'.repeat(40);
    const r = await call('tdsynnex_create_order', { ...order, confirmToken: preview.json!.confirmToken });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('local caps and input rules for create_order', () => {
  it('rejects more lines than the cap (default 25) and a configurable cap', async () => {
    const { calls } = mockFetch(() => jsonResponse({}));
    const many = (n: number) => ({ ...order, orderItems: Array.from({ length: n }, () => order.orderItems[0]) });
    expect((await call('tdsynnex_create_order', many(25))).isError).toBe(false);
    const over = await call('tdsynnex_create_order', many(26));
    expect(over.isError).toBe(true);
    expect(over.text).toContain('local limit is 25');
    process.env.TDSYNNEX_MAX_ORDER_LINES = '2';
    expect((await call('tdsynnex_create_order', many(3))).text).toContain('local limit is 2');
    expect(calls).toHaveLength(0);
  });

  it('rejects a quantity over the cap (default 1000)', async () => {
    mockFetch(() => jsonResponse({}));
    const line = (q: number) => ({ ...order, orderItems: [{ ...order.orderItems[0], quantity: q }] });
    expect((await call('tdsynnex_create_order', line(1000))).isError).toBe(false);
    const r = await call('tdsynnex_create_order', line(1001));
    expect(r.isError).toBe(true);
    expect(r.text).toContain('per-line limit is 1000');
    process.env.TDSYNNEX_MAX_LINE_QUANTITY = '5';
    expect((await call('tdsynnex_create_order', line(6))).text).toContain('per-line limit is 5');
  });

  it.each([
    ['UPDATE action', { ...order, orderItems: [{ ...order.orderItems[0], action: 'UPDATE' }] }],
    ['zero quantity', { ...order, orderItems: [{ ...order.orderItems[0], quantity: 0 }] }],
    ['fractional quantity', { ...order, orderItems: [{ ...order.orderItems[0], quantity: 1.5 }] }],
    ['unknown line key', { ...order, orderItems: [{ ...order.orderItems[0], discount: 50 }] }],
    ['bad product id', { ...order, orderItems: [{ ...order.orderItems[0], productId: 'a/b' }] }],
    ['empty items', { ...order, orderItems: [] }],
    ['attribute without value', { ...order, orderItems: [{ ...order.orderItems[0], attributes: [{ name: 'x' }] }] }],
    ['huge PO', { ...order, orderItems: [{ ...order.orderItems[0], resellerPO: 'x'.repeat(101) }] }],
  ])('rejects invalid input: %s', async (_l, args) => {
    const { calls } = mockFetch(() => jsonResponse({}));
    const r = await call('tdsynnex_create_order', args);
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('startup validation of caps and confirm secret throws ConfigError without echoing values', () => {
    expect(() => loadOrderLimits({ TDSYNNEX_MAX_ORDER_LINES: '0' })).toThrow(ConfigError);
    expect(() => loadOrderLimits({ TDSYNNEX_MAX_LINE_QUANTITY: 'abc' })).toThrow(/TDSYNNEX_MAX_LINE_QUANTITY/);
    expect(() => loadConfirmSecret({ TDSYNNEX_CONFIRM_SECRET: 'tooshort' })).toThrow(/at least 32 bytes/);
    try {
      loadConfirmSecret({ TDSYNNEX_CONFIRM_SECRET: 'tooshort' });
    } catch (e) {
      expect((e as Error).message).not.toContain('tooshort');
    }
    expect(loadConfirmSecret({})).toBeUndefined();
    expect(loadConfirmSecret({ TDSYNNEX_CONFIRM_SECRET: 'c'.repeat(32) })).toBeInstanceOf(Buffer);
  });

  it('canonicalJson is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: undefined }] })).toBe(canonicalJson({ a: [{ d: 1 }], b: 1 }));
    expect(makeConfirmToken({ tool: 't', accountId: '1' }, { a: 1 })).toMatch(/^\d+\./);
  });
});

describe('cancel_order and checkout_cart use the same preview / confirm flow', () => {
  it('cancel_order: preview, then POST ...:cancel with a valid token only', async () => {
    const { calls } = mockFetch(() => jsonResponse({ status: 'CANCELED' }));
    const preview = await call('tdsynnex_cancel_order', { customerId: '23456', orderId: '1234' });
    expect(calls).toHaveLength(0);
    expect(preview.json?.preview).toBe(true);
    expect(preview.json?.willSend.url).toBe(`${BASE}/accounts/${ACCOUNT}/customers/23456/orders/1234:cancel`);

    const wrong = await call('tdsynnex_cancel_order', { customerId: '23456', orderId: '1235', confirmToken: preview.json!.confirmToken });
    expect(wrong.isError).toBe(true);
    expect(calls).toHaveLength(0);

    const done = await call('tdsynnex_cancel_order', { customerId: '23456', orderId: '1234', confirmToken: preview.json!.confirmToken });
    expect(done.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url.toString()).toBe(`${BASE}/accounts/${ACCOUNT}/customers/23456/orders/1234:cancel`);
    expect(calls[0].body).toBeUndefined();
  });

  const checkout = {
    customerId: '1234',
    cartId: 'cart-9',
    totalCalculatedValue: 504,
    provisionData: [{ cartItemId: '162189', attributes: [{ name: 'domainName', value: 'example.onmicrosoft.com' }] }],
  };

  it('checkout_cart: preview, then POST customers/{c}/carts/{id}:checkout with a valid token only', async () => {
    const { calls } = mockFetch(() => jsonResponse({ name: 'accounts/1234/customers/1234/orders/5', status: 'NEW' }));
    const preview = await call('tdsynnex_checkout_cart', checkout);
    expect(calls).toHaveLength(0);
    expect(preview.json?.willSend.url).toBe(`${BASE}/customers/1234/carts/cart-9:checkout`);
    expect(preview.json?.willSend.body).toEqual({
      totalCalculatedValue: 504,
      provisionData: [{ cartItemId: 162189, attributes: [{ name: 'domainName', value: 'example.onmicrosoft.com' }] }],
    });

    const tampered = await call('tdsynnex_checkout_cart', { ...checkout, totalCalculatedValue: 1, confirmToken: preview.json!.confirmToken });
    expect(tampered.isError).toBe(true);
    expect(calls).toHaveLength(0);

    const done = await call('tdsynnex_checkout_cart', { ...checkout, confirmToken: preview.json!.confirmToken });
    expect(done.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url.toString()).toBe(`${BASE}/customers/1234/carts/cart-9:checkout`);
    expect(JSON.parse(calls[0].body as string)).toEqual(preview.json!.willSend.body);
  });

  it('checkout_cart enforces the line cap and input rules', async () => {
    mockFetch(() => jsonResponse({}));
    process.env.TDSYNNEX_MAX_ORDER_LINES = '1';
    const two = { ...checkout, provisionData: [checkout.provisionData[0], checkout.provisionData[0]] };
    expect((await call('tdsynnex_checkout_cart', two)).text).toContain('local limit is 1');
    expect((await call('tdsynnex_checkout_cart', { ...checkout, totalCalculatedValue: -1 })).isError).toBe(true);
    expect((await call('tdsynnex_checkout_cart', { ...checkout, cartId: '../x' })).isError).toBe(true);
  });
});
