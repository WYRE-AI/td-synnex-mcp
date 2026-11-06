import { getSession, seg } from '../client.js';
import type { Args, ToolDef } from './types.js';
import {
  PAGE_SIZE_MAX,
  PAGE_SIZE_SCHEMA,
  PAGE_TOKEN_SCHEMA,
  READ_ONLY,
  InputError,
  assertKnownKeys,
  idSchema,
  optBool,
  optEnum,
  optInt,
  optNumericId,
  optNumericIdList,
  optRefId,
  optString,
  optStringArray,
  pageSizeArg,
  pageTokenArg,
  refIdSchema,
  reqEnum,
  reqNumericId,
  reqObjectArray,
  reqRefId,
  reqString,
  textResult,
  textSchema,
} from './shared.js';

// Enumerations below are copied from https://docs.streamone.cloud/ ("Values such as ..." / status lists).
export const CUSTOMER_STATUSES = ['ACTIVE', 'INACTIVE', 'CUSTOMER_STATUS_UNSPECIFIED'] as const;
export const ORDER_STATUSES = ['NEW', 'IN_PROGRESS', 'CONFIRMED', 'ON_HOLD', 'COMPLETED', 'ERROR', 'CANCELED'] as const;
export const SUBSCRIPTION_STATUSES = [
  'ACCEPTED', 'ACTIVE', 'AVAILABLE', 'CANCELLED', 'COMPLETE', 'CONFIRMED', 'DELETED', 'DISABLED', 'ENABLED', 'ERROR',
  'EXPIRED', 'FAILED', 'INITIATED', 'IN_PROGRESS', 'PAUSED', 'PENDING', 'RUNNING', 'STOPPED', 'SUSPENDED',
] as const;
export const RELATIVE_DATE_RANGES = [
  'UNKNOWN_RELATIVE_DATE_RANGE', 'TODAY', 'MONTH_TO_DATE', 'QUARTER_TO_DATE', 'YEAR_TO_DATE', 'LAST_MONTH', 'LAST_QUARTER',
  'LAST_YEAR', 'LATEST_MONTH', 'WEEK_TO_DATE', 'LAST_WEEK', 'TWO_MONTHS_AGO',
] as const;
export const CART_STATUSES = ['CART_STATUS_UNSPECIFIED', 'OPEN', 'SAVED_FOR_LATER', 'CHECKED_OUT', 'QUOTE'] as const;
export const SORT_ORDERS = ['ASC', 'DESC'] as const;

const SIMPLE_NAME_RE = /^[A-Za-z][A-Za-z0-9._]{0,63}$/;

function simpleName(args: Args, key: string): string | undefined {
  const v = optString(args, key, 64);
  if (v !== undefined && !SIMPLE_NAME_RE.test(v)) throw new InputError(`${key} may only contain letters, digits, '.' and '_'.`);
  return v;
}

const customerId = idSchema('Customer id (numeric), e.g. from tdsynnex_list_customers.');

function def(
  name: string,
  description: string,
  properties: Record<string, object>,
  required: string[],
  handler: ToolDef['handler'],
): ToolDef {
  const keys = Object.keys(properties);
  return {
    write: false,
    tool: {
      name,
      description,
      inputSchema: { type: 'object', properties, required, additionalProperties: false },
      annotations: READ_ONLY,
    },
    handler: async (args) => {
      assertKnownKeys(args, keys, 'arguments');
      return handler(args);
    },
  };
}

export const READ_TOOLS: ToolDef[] = [
  // ---- Customers ----
  def(
    'tdsynnex_list_customers',
    'List the reseller\'s end customers (StreamOne ION "List Customers", ascending by creation date). Filter by email, name, status or language. Returns customers[] and nextPageToken; pass nextPageToken back as pageToken for the next page.',
    {
      customerEmail: textSchema('Primary contact email (filter.customerEmail).'),
      customerName: textSchema('Primary contact name, first and last (filter.customerName).'),
      customerStatus: { type: 'string', enum: [...CUSTOMER_STATUSES], description: 'filter.customerStatus' },
      languageCode: textSchema('2-letter language code, e.g. EN (filter.languageCode).', 10),
      pageSize: PAGE_SIZE_SCHEMA,
      pageToken: PAGE_TOKEN_SCHEMA,
    },
    [],
    async (a) => {
      const s = getSession();
      const data = await s.request('GET', `/accounts/${seg(s.accountId)}/customers`, {
        query: {
          'filter.customerEmail': optString(a, 'customerEmail'),
          'filter.customerName': optString(a, 'customerName'),
          'filter.customerStatus': optEnum(a, 'customerStatus', CUSTOMER_STATUSES),
          'filter.languageCode': optString(a, 'languageCode', 10),
          // ION requires a page size on this endpoint, so one is always sent.
          pageSize: pageSizeArg(a),
          pageToken: pageTokenArg(a),
        },
      });
      return textResult(data);
    },
  ),
  def(
    'tdsynnex_get_customer',
    'Get one end customer\'s profile (organization, address, contact, status) by customer id.',
    { customerId },
    ['customerId'],
    async (a) => {
      const s = getSession();
      const c = reqNumericId(a, 'customerId');
      return textResult(await s.request('GET', `/accounts/${seg(s.accountId)}/customers/${seg(c)}`));
    },
  ),
  def(
    'tdsynnex_get_customer_cloud_profiles',
    'Get a customer\'s linked cloud-provider profiles (e.g. Microsoft CSP tenant, Google Workspace) for one cloud provider. providerId is required by ION.',
    {
      customerId,
      providerId: textSchema('Cloud provider id in CCP, e.g. 30 for Microsoft CSP.', 128),
      enabledOnly: { type: 'boolean', description: 'Only return the customer\'s active cloud profiles.' },
    },
    ['customerId', 'providerId'],
    async (a) => {
      const s = getSession();
      const c = reqNumericId(a, 'customerId');
      const providerId = reqRefId(a, 'providerId');
      return textResult(
        await s.request('GET', `/accounts/${seg(s.accountId)}/customers/${seg(c)}/cloudProfiles`, {
          query: { providerId, enabledOnly: optBool(a, 'enabledOnly') },
        }),
      );
    },
  ),

  // ---- Products ----
  def(
    'tdsynnex_list_products',
    'List products (cloud/subscription SKUs) available to the reseller. Filter by name, SKU/add-on ids or display names, cloud provider or manufacturer part number. ' +
      'Availability: StreamOne ION is cloud/subscription distribution and has NO physical stock or inventory endpoint; the product "productAvailability" field in responses (also returned by tdsynnex_get_product_pricing) is the only availability signal. ' +
      'Returns products[] and nextPageToken.',
    {
      language: textSchema('Product language, e.g. en.', 20),
      name: textSchema('Product name (filter.name).'),
      skuExternalId: textSchema('filter.skuExternalId'),
      addonExternalId: textSchema('filter.addonExternalId'),
      skuId: textSchema('filter.skuId'),
      addonId: textSchema('filter.addonId'),
      skuDisplayName: textSchema('filter.skuDisplayName'),
      addonDisplayName: textSchema('filter.addonDisplayName'),
      cloudProviderId: textSchema('filter.cloudProviderId', 128),
      mfgPartNumber: textSchema('filter.mfgPartNumber'),
      pageSize: PAGE_SIZE_SCHEMA,
      pageToken: PAGE_TOKEN_SCHEMA,
    },
    [],
    async (a) => {
      const s = getSession();
      const data = await s.request('GET', `/accounts/${seg(s.accountId)}/products`, {
        query: {
          pageSize: pageSizeArg(a),
          pageToken: pageTokenArg(a),
          language: optString(a, 'language', 20),
          'filter.name': optString(a, 'name'),
          'filter.skuExternalId': optString(a, 'skuExternalId'),
          'filter.addonExternalId': optString(a, 'addonExternalId'),
          'filter.skuId': optString(a, 'skuId'),
          'filter.addonId': optString(a, 'addonId'),
          'filter.skuDisplayName': optString(a, 'skuDisplayName'),
          'filter.addonDisplayName': optString(a, 'addonDisplayName'),
          'filter.cloudProviderId': optString(a, 'cloudProviderId', 128),
          'filter.mfgPartNumber': optString(a, 'mfgPartNumber'),
        },
      });
      return textResult(data);
    },
  ),
  def(
    'tdsynnex_get_product',
    'Get one product (marketing, definition, plans, pricing, deployment, version history). Responses can be very large: use the exclude* flags to drop sections you do not need. ' +
      'productAvailability in the response is the availability signal; there is no physical stock/inventory endpoint in ION.',
    {
      productId: refIdSchema('Product id, e.g. AcronisCyberProtection-smp (from tdsynnex_list_products).'),
      language: textSchema('Product language, e.g. en.', 20),
      priceBookCustomerId: idSchema('Customer id whose price book should be used for pricing.'),
      productVersion: textSchema('Product version.', 64),
      excludePricing: { type: 'boolean', description: 'Exclude pricing from the response.' },
      excludeMarketing: { type: 'boolean', description: 'Exclude marketing information.' },
      excludeDefinition: { type: 'boolean', description: 'Exclude the product definition.' },
      excludeVersionHistory: { type: 'boolean', description: 'Exclude version history.' },
      excludeDeployment: { type: 'boolean', description: 'Exclude deployment information.' },
      clientRole: { type: 'string', enum: ['CUSTOMER', 'OWNER'], description: 'CUSTOMER (default): published products with price-book pricing. OWNER: design info, no pricing.' },
    },
    ['productId'],
    async (a) => {
      const s = getSession();
      const productId = reqRefId(a, 'productId');
      return textResult(
        await s.request('GET', `/accounts/${seg(s.accountId)}/products/${seg(productId)}`, {
          query: {
            language: optString(a, 'language', 20),
            priceBookCustomerId: optNumericId(a, 'priceBookCustomerId'),
            productVersion: optString(a, 'productVersion', 64),
            'excludeFilter.excludePricing': optBool(a, 'excludePricing'),
            'excludeFilter.excludeMarketing': optBool(a, 'excludeMarketing'),
            'excludeFilter.excludeDefinition': optBool(a, 'excludeDefinition'),
            'excludeFilter.excludeVersionHistory': optBool(a, 'excludeVersionHistory'),
            'excludeFilter.excludeDeployment': optBool(a, 'excludeDeployment'),
            clientRole: optEnum(a, 'clientRole', ['CUSTOMER', 'OWNER'] as const),
          },
        }),
      );
    },
  ),
  def(
    'tdsynnex_get_product_pricing',
    'Get price-book pricing and availability for one or more products for a given price-book customer (POST products:pricing; read-only, nothing is changed). ' +
      'Each plan in the response has pricebookPrice, accountCost, currency and productAvailability (the availability signal; ION has no physical stock endpoint). ' +
      'externalProducts are product identifiers like "GB,CFQ7TTC0LFLS,0002,One-Month commitment for monthly billing" (market, product id, SKU id, unit of measure).',
    {
      priceBookCustomerId: idSchema('Customer id associated with the price book.'),
      providers: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        description: 'Products grouped by cloud provider.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['provider', 'externalProducts'],
          properties: {
            provider: textSchema('Provider resource name accounts/{accountId}/cloudProviders/{id}, or just the numeric cloud provider id (the account id is filled in).', 128),
            externalProducts: { type: 'array', minItems: 1, maxItems: 50, items: textSchema('Product identifier.', 300) },
          },
        },
      },
    },
    ['priceBookCustomerId', 'providers'],
    async (a) => {
      const s = getSession();
      const priceBookCustomerId = Number(reqNumericId(a, 'priceBookCustomerId'));
      const providers = reqObjectArray(a, 'providers', 10).map((p, i) => {
        assertKnownKeys(p, ['provider', 'externalProducts'], `providers[${i}]`);
        const raw = reqString(p, 'provider', 128);
        const provider = /^\d{1,20}$/.test(raw) ? `accounts/${s.accountId}/cloudProviders/${raw}` : raw;
        if (!/^accounts\/\d{1,20}\/cloudProviders\/\d{1,20}$/.test(provider)) {
          throw new InputError(`providers[${i}].provider must be accounts/{accountId}/cloudProviders/{id} or a numeric cloud provider id.`);
        }
        const externalProducts = optStringArray(p, 'externalProducts', 50, 300);
        if (!externalProducts) throw new InputError(`providers[${i}].externalProducts must be a non-empty array.`);
        return { provider, externalProducts };
      });
      return textResult(
        await s.request('POST', `/accounts/${seg(s.accountId)}/products:pricing`, {
          body: { priceBookCustomerId, externalProductWithProvider: providers },
        }),
      );
    },
  ),

  // ---- Orders ----
  def(
    'tdsynnex_list_orders',
    'List orders across the reseller account (and optionally its sub-accounts). Filter by status, customers, accounts or providers. Returns orders[] and nextPageToken.',
    {
      status: { type: 'string', enum: [...ORDER_STATUSES], description: 'Order status.' },
      excludeSubAccounts: { type: 'boolean', description: 'Exclude orders from sub-accounts (filter.excludeSubAccounts).' },
      accountIds: { type: 'array', maxItems: 50, items: idSchema('Account id.'), description: 'Only these account ids (filter.accountIdList).' },
      customerIds: { type: 'array', maxItems: 50, items: idSchema('Customer id.'), description: 'Only these customer ids (filter.customerIdList).' },
      providerNames: { type: 'array', maxItems: 50, items: textSchema('Provider name, e.g. Microsoft.', 100), description: 'Only these provider names (filter.providerNameList).' },
      sortBy: textSchema('Attribute to sort by, e.g. createTime or updateTime.', 64),
      sortOrder: { type: 'string', enum: [...SORT_ORDERS], description: 'Sort direction: ASC or DESC.' },
      pageSize: PAGE_SIZE_SCHEMA,
      pageToken: PAGE_TOKEN_SCHEMA,
    },
    [],
    async (a) => {
      const s = getSession();
      const providerNames = optStringArray(a, 'providerNames', 50, 100);
      if (providerNames?.some((p) => p.includes(','))) throw new InputError('providerNames entries must not contain commas.');
      return textResult(
        await s.request('GET', `/accounts/${seg(s.accountId)}/orders`, {
          query: {
            pageSize: pageSizeArg(a),
            pageToken: pageTokenArg(a),
            status: optEnum(a, 'status', ORDER_STATUSES),
            'filter.excludeSubAccounts': optBool(a, 'excludeSubAccounts'),
            'filter.accountIdList': optNumericIdList(a, 'accountIds'),
            'filter.customerIdList': optNumericIdList(a, 'customerIds'),
            'filter.providerNameList': providerNames?.join(','),
            sortBy: simpleName(a, 'sortBy'),
            sortOrder: optEnum(a, 'sortOrder', SORT_ORDERS),
          },
        }),
      );
    },
  ),
  def(
    'tdsynnex_list_customer_orders',
    'List one customer\'s orders, optionally by status. Returns orders[] and nextPageToken.',
    {
      customerId,
      status: { type: 'string', enum: [...ORDER_STATUSES], description: 'Order status.' },
      pageSize: PAGE_SIZE_SCHEMA,
      pageToken: PAGE_TOKEN_SCHEMA,
    },
    ['customerId'],
    async (a) => {
      const s = getSession();
      const c = reqNumericId(a, 'customerId');
      return textResult(
        await s.request('GET', `/accounts/${seg(s.accountId)}/customers/${seg(c)}/orders`, {
          query: { pageSize: pageSizeArg(a), pageToken: pageTokenArg(a), status: optEnum(a, 'status', ORDER_STATUSES) },
        }),
      );
    },
  ),
  def(
    'tdsynnex_get_order',
    'Get one order (status, total, order items, provisioning info) by customer id and order id.',
    { customerId, orderId: idSchema('Order id (numeric).') },
    ['customerId', 'orderId'],
    async (a) => {
      const s = getSession();
      const c = reqNumericId(a, 'customerId');
      const o = reqNumericId(a, 'orderId');
      return textResult(await s.request('GET', `/accounts/${seg(s.accountId)}/customers/${seg(c)}/orders/${seg(o)}`));
    },
  ),

  // ---- Subscriptions ----
  def(
    'tdsynnex_list_subscriptions',
    'List subscriptions across the reseller account with optional filters (customer, provider, status, product, PO, renewal/start/end date ranges). ' +
      'Uses offset paging (limit/offset), unlike the token paging of other lists; the response includes paginationResponse.totalSize.',
    {
      customerId: idSchema('Filter by customer id.'),
      subscriptionId: textSchema('Filter by subscription id.', 128),
      resellerId: idSchema('Filter by reseller id.'),
      providerId: textSchema('Filter by cloud provider id.', 128),
      subscriptionStatus: { type: 'string', enum: [...SUBSCRIPTION_STATUSES] },
      startDateRelative: { type: 'string', enum: [...RELATIVE_DATE_RANGES], description: 'startDateRange.relativeDateRange' },
      startDateFrom: textSchema('startDateRange.fixedDateRange.startDate, e.g. 2023-09-17T09:48:16Z', 40),
      startDateTo: textSchema('startDateRange.fixedDateRange.endDate', 40),
      endDateRelative: { type: 'string', enum: [...RELATIVE_DATE_RANGES], description: 'endDateRange.relativeDateRange' },
      endDateFrom: textSchema('endDateRange.fixedDateRange.startDate', 40),
      endDateTo: textSchema('endDateRange.fixedDateRange.endDate', 40),
      billingTerm: textSchema('e.g. Monthly, Quarterly, Annually.', 64),
      ccpProductId: textSchema('Product id in the CCP catalog.', 128),
      providerProductId: textSchema('Product id in the provider catalog.', 128),
      customerPo: textSchema('End customer purchase order.'),
      resellerPo: textSchema('Reseller purchase order.'),
      cloudProviderName: textSchema('e.g. GCP, AWS.', 100),
      accountName: textSchema('Account name.'),
      customerName: textSchema('Customer name.'),
      subscriptionName: textSchema('Subscription name.'),
      resourceType: textSchema('e.g. AZURE::Subscription, GSUITE::Subscription.', 100),
      sortBy: textSchema('pagination.sortBy attribute.', 64),
      sortOrder: { type: 'string', enum: [...SORT_ORDERS], description: 'Sort direction: ASC or DESC.' },
      limit: { ...PAGE_SIZE_SCHEMA, description: `Page size (pagination.limit, 1-${PAGE_SIZE_MAX}, default 25). The cap is local to this connector.` },
      offset: { type: 'integer', minimum: 0, description: 'Number of results to skip (pagination.offset).' },
    },
    [],
    async (a) => {
      const s = getSession();
      return textResult(
        await s.request('GET', `/accounts/${seg(s.accountId)}/subscriptions`, {
          query: {
            'pagination.limit': pageSizeArg(a, 'limit'),
            'pagination.offset': optInt(a, 'offset', 0, 1_000_000),
            'pagination.sortBy': simpleName(a, 'sortBy'),
            'pagination.sortOrder': optEnum(a, 'sortOrder', SORT_ORDERS),
            // The docs spell these two query names with a capital "ID".
            customerID: optNumericId(a, 'customerId'),
            subscriptionID: optRefId(a, 'subscriptionId'),
            resellerId: optNumericId(a, 'resellerId'),
            providerId: optRefId(a, 'providerId'),
            subscriptionStatus: optEnum(a, 'subscriptionStatus', SUBSCRIPTION_STATUSES),
            'startDateRange.relativeDateRange': optEnum(a, 'startDateRelative', RELATIVE_DATE_RANGES),
            'startDateRange.fixedDateRange.startDate': optString(a, 'startDateFrom', 40),
            'startDateRange.fixedDateRange.endDate': optString(a, 'startDateTo', 40),
            'endDateRange.relativeDateRange': optEnum(a, 'endDateRelative', RELATIVE_DATE_RANGES),
            'endDateRange.fixedDateRange.startDate': optString(a, 'endDateFrom', 40),
            'endDateRange.fixedDateRange.endDate': optString(a, 'endDateTo', 40),
            billingTerm: optString(a, 'billingTerm', 64),
            ccpProductId: optRefId(a, 'ccpProductId'),
            providerProductId: optString(a, 'providerProductId', 128),
            customerPo: optString(a, 'customerPo'),
            resellerPo: optString(a, 'resellerPo'),
            cloudProviderName: optString(a, 'cloudProviderName', 100),
            accountName: optString(a, 'accountName'),
            customerName: optString(a, 'customerName'),
            subscriptionName: optString(a, 'subscriptionName'),
            resourceType: optString(a, 'resourceType', 100),
          },
        }),
      );
    },
  ),
  def(
    'tdsynnex_get_subscription',
    'Get one subscription (licenses, plan, term, pricing, renewal) by customer id and subscription id.',
    {
      customerId,
      subscriptionId: idSchema('Subscription id (numeric "id" from tdsynnex_list_subscriptions).'),
      refresh: { type: 'boolean', description: 'Ask ION to refresh the subscription data from the provider first.' },
    },
    ['customerId', 'subscriptionId'],
    async (a) => {
      const s = getSession();
      const c = reqNumericId(a, 'customerId');
      const sub = reqNumericId(a, 'subscriptionId');
      return textResult(
        await s.request('GET', `/accounts/${seg(s.accountId)}/customers/${seg(c)}/subscriptions/${seg(sub)}`, {
          query: { refresh: optBool(a, 'refresh') },
        }),
      );
    },
  ),

  // ---- Carts / quotes ----
  // NOTE: the docs show cart paths WITHOUT /accounts/{accountId} (https://ion.tdsynnex.com/api/v3/customers/{customerId}/carts)
  // even though the Introduction says every endpoint needs accountId. Implemented exactly as documented; unverified.
  def(
    'tdsynnex_list_carts',
    'List a customer\'s carts by status. In StreamOne ION a "quote" is a cart with status QUOTE; the v3 docs have no separate quotes API, so use status=QUOTE to list quotes. ' +
      'Uses limit/offset paging. (Cart paths are documented without the account id; see README "Known issues".)',
    {
      customerId,
      status: { type: 'string', enum: [...CART_STATUSES], description: 'Cart status (required by ION). QUOTE = quotes.' },
      limit: { ...PAGE_SIZE_SCHEMA, description: `Page size (pagination.limit, 1-${PAGE_SIZE_MAX}, default 25). The cap is local to this connector.` },
      offset: { type: 'integer', minimum: 0, description: 'Number of results to skip (pagination.offset).' },
      sortBy: textSchema('pagination.sortBy attribute.', 64),
      sortOrder: { type: 'string', enum: [...SORT_ORDERS], description: 'Sort direction: ASC or DESC.' },
    },
    ['customerId', 'status'],
    async (a) => {
      const s = getSession();
      const c = reqNumericId(a, 'customerId');
      return textResult(
        await s.request('GET', `/customers/${seg(c)}/carts`, {
          query: {
            status: reqEnum(a, 'status', CART_STATUSES),
            'pagination.limit': pageSizeArg(a, 'limit'),
            'pagination.offset': optInt(a, 'offset', 0, 1_000_000),
            'pagination.sortBy': simpleName(a, 'sortBy'),
            'pagination.sortOrder': optEnum(a, 'sortOrder', SORT_ORDERS),
          },
        }),
      );
    },
  ),
  def(
    'tdsynnex_get_cart',
    'Get one cart (or quote, status QUOTE) by customer id and cart id.',
    { customerId, cartId: refIdSchema('Cart id.') },
    ['customerId', 'cartId'],
    async (a) => {
      const s = getSession();
      const c = reqNumericId(a, 'customerId');
      const cart = reqRefId(a, 'cartId');
      return textResult(await s.request('GET', `/customers/${seg(c)}/carts/${seg(cart)}`));
    },
  ),
  def(
    'tdsynnex_list_cart_items',
    'List the items in a cart (or quote): products, plans, quantities and price breakdowns. Review these before tdsynnex_checkout_cart.',
    { customerId, cartId: refIdSchema('Cart id.') },
    ['customerId', 'cartId'],
    async (a) => {
      const s = getSession();
      const c = reqNumericId(a, 'customerId');
      const cart = reqRefId(a, 'cartId');
      return textResult(await s.request('GET', `/customers/${seg(c)}/carts/${seg(cart)}/cartItems`));
    },
  ),
];
