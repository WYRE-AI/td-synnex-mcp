import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call, jsonResponse, mockFetch, useStaticCreds, ACCOUNT, STATIC_TOKEN } from './test-helpers.js';

const BASE = 'https://ion.tdsynnex.com/api/v3';

beforeEach(() => {
  useStaticCreds();
  process.env.READ_ONLY_MODE = 'false';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(response: unknown = { ok: true }) {
  return mockFetch(() => jsonResponse(response));
}

describe('read tools hit the documented method + path + query', () => {
  const cases: Array<{ tool: string; args: Record<string, unknown>; path: string; query?: Record<string, string>; method?: string }> = [
    {
      tool: 'tdsynnex_list_customers',
      args: { customerEmail: 'a@b.com', customerName: 'John Doe', customerStatus: 'ACTIVE', languageCode: 'EN', pageToken: 'MTox' },
      path: `/accounts/${ACCOUNT}/customers`,
      query: { 'filter.customerEmail': 'a@b.com', 'filter.customerName': 'John Doe', 'filter.customerStatus': 'ACTIVE', 'filter.languageCode': 'EN', pageSize: '25', pageToken: 'MTox' },
    },
    { tool: 'tdsynnex_get_customer', args: { customerId: '56789' }, path: `/accounts/${ACCOUNT}/customers/56789` },
    {
      tool: 'tdsynnex_get_customer_cloud_profiles',
      args: { customerId: '56789', providerId: '30', enabledOnly: true },
      path: `/accounts/${ACCOUNT}/customers/56789/cloudProfiles`,
      query: { providerId: '30', enabledOnly: 'true' },
    },
    {
      tool: 'tdsynnex_list_products',
      args: { language: 'en', name: 'Microsoft NCE', skuExternalId: '1', addonExternalId: '2', skuId: 's', addonId: 'a', skuDisplayName: 'sd', addonDisplayName: 'ad', cloudProviderId: '30', mfgPartNumber: 'P1', pageSize: 10, pageToken: 'tok' },
      path: `/accounts/${ACCOUNT}/products`,
      query: {
        pageSize: '10', pageToken: 'tok', language: 'en', 'filter.name': 'Microsoft NCE', 'filter.skuExternalId': '1', 'filter.addonExternalId': '2',
        'filter.skuId': 's', 'filter.addonId': 'a', 'filter.skuDisplayName': 'sd', 'filter.addonDisplayName': 'ad', 'filter.cloudProviderId': '30', 'filter.mfgPartNumber': 'P1',
      },
    },
    {
      tool: 'tdsynnex_get_product',
      args: { productId: 'AcronisCyberProtection-smp', language: 'en', priceBookCustomerId: '12345', excludePricing: true, excludeMarketing: false, excludeDefinition: true, excludeVersionHistory: true, excludeDeployment: true, clientRole: 'OWNER', productVersion: '3' },
      path: `/accounts/${ACCOUNT}/products/AcronisCyberProtection-smp`,
      query: {
        language: 'en', priceBookCustomerId: '12345', productVersion: '3', 'excludeFilter.excludePricing': 'true', 'excludeFilter.excludeMarketing': 'false',
        'excludeFilter.excludeDefinition': 'true', 'excludeFilter.excludeVersionHistory': 'true', 'excludeFilter.excludeDeployment': 'true', clientRole: 'OWNER',
      },
    },
    {
      tool: 'tdsynnex_list_orders',
      args: { status: 'NEW', excludeSubAccounts: true, accountIds: ['111', '112'], customerIds: ['102'], providerNames: ['Microsoft', 'Azure'], sortBy: 'createTime', sortOrder: 'DESC', pageSize: 100 },
      path: `/accounts/${ACCOUNT}/orders`,
      query: {
        pageSize: '100', status: 'NEW', 'filter.excludeSubAccounts': 'true', 'filter.accountIdList': '111,112', 'filter.customerIdList': '102',
        'filter.providerNameList': 'Microsoft,Azure', sortBy: 'createTime', sortOrder: 'DESC',
      },
    },
    {
      tool: 'tdsynnex_list_customer_orders',
      args: { customerId: '18502', status: 'COMPLETED' },
      path: `/accounts/${ACCOUNT}/customers/18502/orders`,
      query: { pageSize: '25', status: 'COMPLETED' },
    },
    { tool: 'tdsynnex_get_order', args: { customerId: '18502', orderId: '401244' }, path: `/accounts/${ACCOUNT}/customers/18502/orders/401244` },
    {
      tool: 'tdsynnex_list_subscriptions',
      args: { customerId: '12345', subscriptionId: '99', providerId: '30', subscriptionStatus: 'ACTIVE', endDateRelative: 'LAST_MONTH', billingTerm: 'Monthly', customerPo: 'PO1', limit: 10, offset: 20, sortOrder: 'ASC' },
      path: `/accounts/${ACCOUNT}/subscriptions`,
      query: {
        'pagination.limit': '10', 'pagination.offset': '20', 'pagination.sortOrder': 'ASC', customerID: '12345', subscriptionID: '99', providerId: '30',
        subscriptionStatus: 'ACTIVE', 'endDateRange.relativeDateRange': 'LAST_MONTH', billingTerm: 'Monthly', customerPo: 'PO1',
      },
    },
    {
      tool: 'tdsynnex_get_subscription',
      args: { customerId: '12345', subscriptionId: '123456', refresh: true },
      path: `/accounts/${ACCOUNT}/customers/12345/subscriptions/123456`,
      query: { refresh: 'true' },
    },
    // Carts are documented WITHOUT /accounts/{accountId}.
    {
      tool: 'tdsynnex_list_carts',
      args: { customerId: '1234', status: 'QUOTE', limit: 5, offset: 10 },
      path: '/customers/1234/carts',
      query: { status: 'QUOTE', 'pagination.limit': '5', 'pagination.offset': '10' },
    },
    { tool: 'tdsynnex_get_cart', args: { customerId: '1234', cartId: 'c-77' }, path: '/customers/1234/carts/c-77' },
    { tool: 'tdsynnex_list_cart_items', args: { customerId: '1234', cartId: 'c-77' }, path: '/customers/1234/carts/c-77/cartItems' },
  ];

  it.each(cases)('$tool', async ({ tool, args, path, query, method }) => {
    const { calls } = setup();
    const r = await call(tool, args);
    expect(r.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe(method ?? 'GET');
    expect(calls[0].url.origin + calls[0].url.pathname).toBe(`https://ion.tdsynnex.com/api/v3${path}`);
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual(query ?? {});
    expect(calls[0].headers.Authorization).toBe(`Bearer ${STATIC_TOKEN}`);
    expect(calls[0].body).toBeUndefined();
  });

  it('tdsynnex_get_product_pricing POSTs the documented body and is annotated read-only', async () => {
    const { calls } = setup({ plans: [{ productId: 'x', productAvailability: true }] });
    const r = await call('tdsynnex_get_product_pricing', {
      priceBookCustomerId: '67349',
      providers: [{ provider: '30', externalProducts: ['GB,CFQ7TTC0LFLS,0002,One-Month commitment for monthly billing'] }],
    });
    expect(r.isError).toBe(false);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url.toString()).toBe(`${BASE}/accounts/${ACCOUNT}/products:pricing`);
    expect(JSON.parse(calls[0].body as string)).toEqual({
      priceBookCustomerId: 67349,
      externalProductWithProvider: [
        { provider: `accounts/${ACCOUNT}/cloudProviders/30`, externalProducts: ['GB,CFQ7TTC0LFLS,0002,One-Month commitment for monthly billing'] },
      ],
    });
    expect(r.json?.plans[0].productAvailability).toBe(true);
  });

  it('accepts a full provider resource name and rejects a malformed one', async () => {
    const { calls } = setup();
    await call('tdsynnex_get_product_pricing', { priceBookCustomerId: '1', providers: [{ provider: 'accounts/10505/cloudProviders/30', externalProducts: ['p'] }] });
    expect(JSON.parse(calls[0].body as string).externalProductWithProvider[0].provider).toBe('accounts/10505/cloudProviders/30');
    const bad = await call('tdsynnex_get_product_pricing', { priceBookCustomerId: '1', providers: [{ provider: '../x', externalProducts: ['p'] }] });
    expect(bad.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('list_products always sends a pageSize, caps it locally and rejects larger values', async () => {
    const { calls } = setup();
    await call('tdsynnex_list_products', {});
    expect(calls[0].url.searchParams.get('pageSize')).toBe('25');
    const big = await call('tdsynnex_list_products', { pageSize: 101 });
    expect(big.isError).toBe(true);
    expect(big.text).toContain('between 1 and 100');
    expect(calls).toHaveLength(1);
  });

  it('tool descriptions explain availability, quotes=carts, and the local cap', async () => {
    const { ALL_TOOLS } = await import('../tools/index.js');
    const d = (n: string) => ALL_TOOLS.find((t) => t.name === n)!.description!;
    expect(d('tdsynnex_list_products')).toMatch(/productAvailability/);
    expect(d('tdsynnex_list_products')).toMatch(/NO physical stock or inventory/);
    expect(d('tdsynnex_list_carts')).toMatch(/QUOTE/);
    expect(JSON.stringify(ALL_TOOLS.find((t) => t.name === 'tdsynnex_list_products')!.inputSchema)).toMatch(/local cap/);
  });
});

describe('id validation and path encoding', () => {
  it.each([
    ['tdsynnex_get_customer', { customerId: '1/../2' }],
    ['tdsynnex_get_customer', { customerId: '12a' }],
    ['tdsynnex_get_customer', { customerId: '' }],
    ['tdsynnex_get_order', { customerId: '1', orderId: '1?x=2' }],
    ['tdsynnex_get_subscription', { customerId: '1', subscriptionId: 'abc' }],
    ['tdsynnex_get_product', { productId: 'a/b' }],
    ['tdsynnex_get_product', { productId: 'a b' }],
    ['tdsynnex_get_cart', { customerId: '1', cartId: '../carts' }],
    ['tdsynnex_get_customer_cloud_profiles', { customerId: '1', providerId: 'x y' }],
    ['tdsynnex_list_orders', { accountIds: ['1', 'x'] }],
    ['tdsynnex_list_customers', { customerEmail: 'a'.repeat(501) }],
    ['tdsynnex_list_customers', { customerEmail: 'a\nb' }],
    ['tdsynnex_list_customers', { unknownArg: 1 }],
    ['tdsynnex_list_customers', { customerStatus: 'BOGUS' }],
  ])('%s %j is rejected before any request', async (tool, args) => {
    const { calls } = setup();
    const r = await call(tool, args);
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('percent-encodes the product id path segment', async () => {
    const { calls } = setup();
    await call('tdsynnex_get_product', { productId: 'Microsoft365EandFNCE--smpnce' });
    expect(calls[0].url.pathname).toBe(`/api/v3/accounts/${ACCOUNT}/products/Microsoft365EandFNCE--smpnce`);
    await call('tdsynnex_get_product', { productId: 'A:b.c_d-1' });
    expect(calls[1].url.pathname).toBe(`/api/v3/accounts/${ACCOUNT}/products/A%3Ab.c_d-1`);
  });
});

describe('error handling in tools', () => {
  it('returns a redacted error result for API errors', async () => {
    mockFetch(() => jsonResponse({ error: 'NOT_FOUND', message: 'nope', code: 404, details: [{ requestId: 'r-1' }] }, 404));
    const r = await call('tdsynnex_get_customer', { customerId: '1' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Error:');
    expect(r.text).toContain('r-1');
    expect(r.text).not.toContain(STATIC_TOKEN);
  });

  it('reports missing credentials by variable name', async () => {
    delete process.env.TDSYNNEX_ACCESS_TOKEN;
    const r = await call('tdsynnex_list_customers');
    expect(r.isError).toBe(true);
    expect(r.text).toContain('TDSYNNEX_REFRESH_TOKEN');
  });
});
