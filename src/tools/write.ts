import { API_BASE, getSession, seg, type Session } from '../client.js';
import {
  CONFIRM_TOKEN_TTL_MS,
  ORDER_LIMIT_ENV,
  checkLineCount,
  checkLineQuantity,
  consumeConfirmToken,
  loadOrderLimits,
  makeConfirmToken,
  type ConfirmScope,
} from '../order-safety.js';
import type { Args, CallToolResult, ToolDef } from './types.js';
import {
  InputError,
  WRITE,
  WRITE_NOTE,
  assertKnownKeys,
  attributeList,
  idSchema,
  optString,
  refIdSchema,
  reqEnum,
  reqInt,
  reqNumericId,
  reqObject,
  reqObjectArray,
  reqRefId,
  reqString,
  textResult,
  textSchema,
} from './shared.js';
import { CART_STATUSES } from './read.js';

const PAYMENT_TYPES = ['PAYMENT_TYPE_UNSPECIFIED', 'OFFLINE', 'CREDIT_CARD'] as const;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;

const confirmTokenSchema = {
  type: 'string',
  maxLength: 100,
  description:
    'Omit to get a PREVIEW (nothing is sent to TD SYNNEX). After the user explicitly approves the preview, call again with the identical arguments plus the confirmToken from the preview (valid 30 minutes, single use).',
} as const;

const customerId = idSchema('Customer id (numeric).');

function def(
  name: string,
  description: string,
  properties: Record<string, object>,
  required: string[],
  handler: ToolDef['handler'],
): ToolDef {
  const keys = Object.keys(properties);
  return {
    write: true,
    tool: {
      name,
      description: WRITE_NOTE + description,
      inputSchema: { type: 'object', properties, required, additionalProperties: false },
      annotations: WRITE,
    },
    handler: async (args) => {
      assertKnownKeys(args, keys, 'arguments');
      return handler(args);
    },
  };
}

interface PlannedCall {
  method: 'POST' | 'PUT';
  path: string;
  body?: unknown;
}

/**
 * Two-step execution for money-moving calls. Without confirmToken: returns a preview (no vendor call) and a
 * token bound to tool + account + customer + the exact normalized request. With a valid token: sends it.
 */
async function previewOrExecute(
  s: Session,
  scope: ConfirmScope,
  call: PlannedCall,
  confirmToken: string | undefined,
  what: string,
): Promise<CallToolResult> {
  const bound = { method: call.method, path: call.path, body: call.body };
  if (confirmToken === undefined) {
    return textResult({
      preview: true,
      sent: false,
      message:
        `PREVIEW ONLY: nothing was sent to TD SYNNEX. ${what} Show this to the user and get their explicit approval. ` +
        'Only then call this tool again with the identical arguments plus the confirmToken below.',
      willSend: { method: call.method, url: `${API_BASE}${call.path}`, body: call.body },
      confirmToken: makeConfirmToken(scope, bound),
      confirmTokenValidMinutes: CONFIRM_TOKEN_TTL_MS / 60_000,
    });
  }
  consumeConfirmToken(scope, bound, confirmToken);
  return textResult(await s.request(call.method, call.path, { body: call.body }));
}

function confirmTokenArg(a: Args): string | undefined {
  const v = a.confirmToken;
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !v.trim() || v.length > 100) throw new InputError('confirmToken must be the token string from the preview.');
  return v.trim();
}

// ---------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------

const ADDRESS_KEYS = ['street', 'suite', 'city', 'state', 'zip', 'country'] as const;
const customerProps = {
  customerOrganization: textSchema('Customer organization name.', 200),
  customerAddress: {
    type: 'object',
    additionalProperties: false,
    required: ['street', 'city', 'state', 'zip', 'country'],
    properties: {
      street: textSchema('Street address.', 200),
      suite: textSchema('Suite / unit.', 50),
      city: textSchema('City.', 100),
      state: textSchema('State code, e.g. VA.', 50),
      zip: textSchema('Zip / postal code.', 20),
      country: textSchema('Country code, e.g. US.', 10),
    },
  },
  customerName: textSchema('Primary contact name (first and last).', 200),
  customerEmail: textSchema('Primary contact email.', 254),
  customerPhone: textSchema('Phone number.', 40),
  languageCode: textSchema('ISO 639-1 language code, e.g. en.', 2),
} as const;

function customerBody(a: Args, titleRequired: boolean, allowUid: boolean): Record<string, unknown> {
  const addr = reqObject(a, 'customerAddress');
  assertKnownKeys(addr, ADDRESS_KEYS, 'customerAddress');
  const email = reqString(a, 'customerEmail', 254);
  if (!EMAIL_RE.test(email)) throw new InputError('customerEmail is not a valid email address.');
  const language = reqString(a, 'languageCode', 2);
  if (!/^[A-Za-z]{2}$/.test(language)) throw new InputError('languageCode must be a 2-letter ISO 639-1 code.');
  const title = titleRequired ? reqString(a, 'customerTitle', 100) : optString(a, 'customerTitle', 100);
  return {
    customerOrganization: reqString(a, 'customerOrganization', 200),
    customerAddress: {
      street: reqString(addr, 'street', 200),
      suite: optString(addr, 'suite', 50),
      city: reqString(addr, 'city', 100),
      state: reqString(addr, 'state', 50),
      zip: reqString(addr, 'zip', 20),
      country: reqString(addr, 'country', 10),
    },
    customerName: reqString(a, 'customerName', 200),
    customerEmail: email,
    customerTitle: title,
    customerPhone: optString(a, 'customerPhone', 40),
    languageCode: language,
    uid: allowUid ? optString(a, 'uid', 64) : undefined,
  };
}

const createCustomer = def(
  'tdsynnex_create_customer',
  'Create a new end customer under the reseller account (POST customers). ION generates a default user for the customer and returns its password in the response; this connector REDACTS any `password` field from tool output, so the user must set/reset it in the ION portal. ' +
    'Required: customerOrganization, customerAddress (street, city, state, zip, country), customerName, customerEmail, customerTitle, languageCode.',
  {
    ...customerProps,
    customerTitle: textSchema('Title of the primary contact, e.g. Ms.', 100),
    uid: textSchema('Optional unique user id.', 64),
  },
  ['customerOrganization', 'customerAddress', 'customerName', 'customerEmail', 'customerTitle', 'languageCode'],
  async (a) => {
    const s = getSession();
    const body = customerBody(a, true, true);
    return textResult(await s.request('POST', `/accounts/${seg(s.accountId)}/customers`, { body }));
  },
);

const updateCustomer = def(
  'tdsynnex_update_customer',
  'Update an end customer (PUT customers/{customerId}). This replaces the customer\'s profile fields, so send ALL required fields with their intended values: call tdsynnex_get_customer first and change only what the user asked for. ' +
    'Required: customerOrganization, customerAddress (street, city, state, zip, country), customerName, customerEmail, languageCode.',
  {
    customerId,
    ...customerProps,
    customerTitle: textSchema('Title of the primary contact, e.g. Ms.', 100),
  },
  ['customerId', 'customerOrganization', 'customerAddress', 'customerName', 'customerEmail', 'languageCode'],
  async (a) => {
    const s = getSession();
    const c = reqNumericId(a, 'customerId');
    const body = customerBody(a, false, false);
    return textResult(await s.request('PUT', `/accounts/${seg(s.accountId)}/customers/${seg(c)}`, { body }));
  },
);

// ---------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------

const ORDER_ITEM_KEYS = [
  'action', 'productId', 'skuId', 'planId', 'quantity', 'attributes', 'referenceId', 'resourceId', 'endCustomerPO', 'resellerPO', 'vendor', 'providerName',
] as const;
const ORDER_ITEMS_HARD_MAX = 500;

const attributeSchema = {
  type: 'array',
  maxItems: 50,
  description: 'Product-specific name/value pairs from the provisioning template, e.g. renewalSetting (auto_on | cancel_at_renewal | renew_to_est), domainName, agreementDateAgreed.',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'value'],
    properties: { name: textSchema('Attribute name.', 128), value: textSchema('Attribute value.', 1000) },
  },
} as const;

const createOrder = def(
  'tdsynnex_create_order',
  'PLACE A REAL, BILLABLE ORDER for a customer (POST customers/{customerId}/orders, action CREATE only). ' +
    'TWO-STEP: the first call (no confirmToken) only returns a preview and a confirmToken; send the preview to the user, and only after their explicit approval call again with the identical arguments plus the confirmToken. ' +
    'Before ordering, verify the customer (tdsynnex_get_customer), the product/SKU/plan (tdsynnex_get_product) and pricing (tdsynnex_get_product_pricing). ' +
    'Microsoft products need a tenant and signed agreement; attributes must follow the product\'s provisioning template. Reserved-instance orders cannot be placed through the API. ' +
    `Local caps apply (lines: ${ORDER_LIMIT_ENV.maxLines}, quantity per line: ${ORDER_LIMIT_ENV.maxLineQuantity}). Subscription changes (action UPDATE) are not supported by this tool.`,
  {
    customerId,
    referenceId: textSchema('Your reference for the order.', 128),
    displayName: textSchema('Display name for the order.', 200),
    orderItems: {
      type: 'array',
      minItems: 1,
      maxItems: ORDER_ITEMS_HARD_MAX,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['productId', 'skuId', 'planId', 'quantity'],
        properties: {
          action: { type: 'string', enum: ['CREATE'], description: 'Only CREATE is supported (default).' },
          productId: refIdSchema('Product id.'),
          skuId: refIdSchema('SKU id.'),
          planId: refIdSchema('Plan id.'),
          quantity: { type: 'integer', minimum: 1, description: 'Quantity (local per-line cap applies).' },
          attributes: attributeSchema,
          referenceId: textSchema('Your reference for this line.', 128),
          resourceId: textSchema('Subscription id from the vendor, if applicable.', 128),
          endCustomerPO: textSchema('End customer purchase order number.', 100),
          resellerPO: textSchema('Reseller purchase order number.', 100),
          vendor: textSchema('Vendor name (e.g. google), used by some scenarios.', 100),
          providerName: textSchema('Provider name (e.g. productivity), used by some scenarios.', 100),
        },
      },
    },
    confirmToken: confirmTokenSchema,
  },
  ['customerId', 'orderItems'],
  async (a) => {
    const s = getSession();
    const c = reqNumericId(a, 'customerId');
    const limits = loadOrderLimits();
    const items = reqObjectArray(a, 'orderItems', ORDER_ITEMS_HARD_MAX);
    checkLineCount(items.length, limits);
    const orderItems = items.map((it, i) => {
      const where = `orderItems[${i}]`;
      assertKnownKeys(it, ORDER_ITEM_KEYS, where);
      if (it.action !== undefined && it.action !== 'CREATE') {
        throw new InputError(`${where}.action: only CREATE is supported by tdsynnex_create_order (subscription updates are not implemented yet).`);
      }
      const quantity = reqInt(it, 'quantity', 1, Number.MAX_SAFE_INTEGER);
      checkLineQuantity(quantity, `${where}.quantity`, limits);
      return {
        action: 'CREATE',
        productId: reqRefId(it, 'productId'),
        skuId: reqRefId(it, 'skuId'),
        planId: reqRefId(it, 'planId'),
        quantity,
        attributes: attributeList(it, 'attributes', where),
        referenceId: optString(it, 'referenceId', 128),
        resourceId: optString(it, 'resourceId', 128),
        endCustomerPO: optString(it, 'endCustomerPO', 100),
        resellerPO: optString(it, 'resellerPO', 100),
        vendor: optString(it, 'vendor', 100),
        providerName: optString(it, 'providerName', 100),
      };
    });
    const body = {
      referenceId: optString(a, 'referenceId', 128),
      displayName: optString(a, 'displayName', 200),
      orderItems,
    };
    const scope: ConfirmScope = { tool: 'tdsynnex_create_order', accountId: s.accountId, customerId: c };
    return previewOrExecute(
      s,
      scope,
      { method: 'POST', path: `/accounts/${seg(s.accountId)}/customers/${seg(c)}/orders`, body },
      confirmTokenArg(a),
      `This would place a real, billable order with ${orderItems.length} line(s) for customer ${c}.`,
    );
  },
);

const cancelOrder = def(
  'tdsynnex_cancel_order',
  'Cancel an order (POST orders/{orderId}:cancel). ION only allows this for orders in status NEW or ON_HOLD shortly after placing; check with tdsynnex_get_order first. ' +
    'TWO-STEP: the first call (no confirmToken) returns a preview and a confirmToken; after the user explicitly approves, call again with the identical arguments plus the confirmToken.',
  { customerId, orderId: idSchema('Order id (numeric).'), confirmToken: confirmTokenSchema },
  ['customerId', 'orderId'],
  async (a) => {
    const s = getSession();
    const c = reqNumericId(a, 'customerId');
    const o = reqNumericId(a, 'orderId');
    const scope: ConfirmScope = { tool: 'tdsynnex_cancel_order', accountId: s.accountId, customerId: c };
    return previewOrExecute(
      s,
      scope,
      { method: 'POST', path: `/accounts/${seg(s.accountId)}/customers/${seg(c)}/orders/${seg(o)}:cancel` },
      confirmTokenArg(a),
      `This would cancel order ${o} for customer ${c}.`,
    );
  },
);

// ---------------------------------------------------------------------
// Carts / quotes
// ---------------------------------------------------------------------

const createCart = def(
  'tdsynnex_create_cart',
  'Create a cart for a customer (POST customers/{customerId}/carts). In ION a "quote" is a cart with status QUOTE: create one with status=QUOTE. Creating a cart or quote does not place an order. ' +
    '(Cart paths are documented without the account id; see README "Known issues".) Add items to the cart in the ION portal; cart-item creation is not implemented yet.',
  {
    customerId,
    cartDisplayName: textSchema('Display name, e.g. "Cart - 1234".', 200),
    userName: textSchema('User associated with the cart.', 200),
    paymentType: { type: 'string', enum: [...PAYMENT_TYPES], description: 'How the cart is paid. Pick one of the listed values.' },
    creditCardName: textSchema('Credit card name (the docs list it as required; send it when paymentType is CREDIT_CARD).', 100),
    status: { type: 'string', enum: [...CART_STATUSES], description: 'Use QUOTE to create a quote.' },
    currencyCode: textSchema('Currency code, e.g. USD.', 3),
  },
  ['customerId', 'cartDisplayName', 'userName', 'paymentType', 'status', 'currencyCode'],
  async (a) => {
    const s = getSession();
    const c = reqNumericId(a, 'customerId');
    const currency = reqString(a, 'currencyCode', 3);
    if (!/^[A-Za-z]{3}$/.test(currency)) throw new InputError('currencyCode must be a 3-letter currency code.');
    const body = {
      cartDisplayName: reqString(a, 'cartDisplayName', 200),
      userName: reqString(a, 'userName', 200),
      payment: { paymentType: reqEnum(a, 'paymentType', PAYMENT_TYPES), creditCardName: optString(a, 'creditCardName', 100) },
      status: reqEnum(a, 'status', CART_STATUSES),
      currencyCode: currency.toUpperCase(),
    };
    return textResult(await s.request('POST', `/customers/${seg(c)}/carts`, { body }));
  },
);

const checkoutCart = def(
  'tdsynnex_checkout_cart',
  'CHECK OUT A CART, PLACING A REAL, BILLABLE ORDER (POST customers/{customerId}/carts/{cartId}:checkout). Converts a cart or quote into an order. ' +
    'TWO-STEP: the first call (no confirmToken) returns a preview and a confirmToken; review the cart first (tdsynnex_get_cart, tdsynnex_list_cart_items), show the user the preview, and only after their explicit approval call again with the identical arguments plus the confirmToken. ' +
    `Local cap: ${ORDER_LIMIT_ENV.maxLines} provisionData lines.`,
  {
    customerId,
    cartId: refIdSchema('Cart id.'),
    totalCalculatedValue: { type: 'number', minimum: 0, description: 'Final value of the cart including discounts (as shown by ION); ION requires it.' },
    provisionData: {
      type: 'array',
      maxItems: ORDER_ITEMS_HARD_MAX,
      description: 'Provisioning attributes per cart item, required for product activation after checkout.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['cartItemId', 'attributes'],
        properties: { cartItemId: idSchema('Cart item id.'), attributes: attributeSchema },
      },
    },
    confirmToken: confirmTokenSchema,
  },
  ['customerId', 'cartId', 'totalCalculatedValue'],
  async (a) => {
    const s = getSession();
    const c = reqNumericId(a, 'customerId');
    const cart = reqRefId(a, 'cartId');
    const limits = loadOrderLimits();
    const total = a.totalCalculatedValue;
    if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) {
      throw new InputError('totalCalculatedValue must be a non-negative number.');
    }
    const raw = a.provisionData === undefined || a.provisionData === null ? [] : reqObjectArray(a, 'provisionData', ORDER_ITEMS_HARD_MAX);
    checkLineCount(raw.length, limits, 'checkout');
    const provisionData = raw.map((p, i) => {
      const where = `provisionData[${i}]`;
      assertKnownKeys(p, ['cartItemId', 'attributes'], where);
      return {
        cartItemId: Number(reqNumericId(p, 'cartItemId')),
        attributes: attributeList(p, 'attributes', where) ?? [],
      };
    });
    if (!provisionData.every((p) => Number.isSafeInteger(p.cartItemId))) throw new InputError('provisionData cartItemId is too large.');
    const scope: ConfirmScope = { tool: 'tdsynnex_checkout_cart', accountId: s.accountId, customerId: c };
    return previewOrExecute(
      s,
      scope,
      {
        method: 'POST',
        path: `/customers/${seg(c)}/carts/${seg(cart)}:checkout`,
        body: { totalCalculatedValue: total, provisionData },
      },
      confirmTokenArg(a),
      `This would check out cart ${cart} for customer ${c}, placing a real, billable order with a stated total of ${total}.`,
    );
  },
);

export const WRITE_TOOLS: ToolDef[] = [createCustomer, updateCustomer, createOrder, cancelOrder, createCart, checkoutCart];

