import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from '../tools/index.js';

describe('tool list', () => {
  it('names + annotations snapshot', () => {
    expect(ALL_TOOLS.map((t) => ({ name: t.name, annotations: t.annotations }))).toMatchInlineSnapshot(`
      [
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "tdsynnex_list_customers",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "tdsynnex_get_customer",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "tdsynnex_get_customer_cloud_profiles",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "tdsynnex_list_products",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "tdsynnex_get_product",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "tdsynnex_get_product_pricing",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "tdsynnex_list_orders",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "tdsynnex_list_customer_orders",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "tdsynnex_get_order",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "tdsynnex_list_subscriptions",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "tdsynnex_get_subscription",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "tdsynnex_list_carts",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "tdsynnex_get_cart",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "tdsynnex_list_cart_items",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "readOnlyHint": false,
          },
          "name": "tdsynnex_create_customer",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "readOnlyHint": false,
          },
          "name": "tdsynnex_update_customer",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "readOnlyHint": false,
          },
          "name": "tdsynnex_create_order",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "readOnlyHint": false,
          },
          "name": "tdsynnex_cancel_order",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "readOnlyHint": false,
          },
          "name": "tdsynnex_create_cart",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "readOnlyHint": false,
          },
          "name": "tdsynnex_checkout_cart",
        },
      ]
    `);
  });

  it('every tool is prefixed, described, and has a strict object schema', () => {
    for (const t of ALL_TOOLS) {
      expect(t.name).toMatch(/^tdsynnex_[a-z_]+$/);
      expect(t.description?.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
      expect((t.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
    expect(new Set(ALL_TOOLS.map((t) => t.name)).size).toBe(ALL_TOOLS.length);
  });

  it('only the six write tools are non-read-only, and all of them are destructive and not idempotent', () => {
    const writes = ALL_TOOLS.filter((t) => t.annotations?.readOnlyHint !== true);
    expect(writes.map((t) => t.name).sort()).toEqual(
      ['tdsynnex_cancel_order', 'tdsynnex_checkout_cart', 'tdsynnex_create_cart', 'tdsynnex_create_customer', 'tdsynnex_create_order', 'tdsynnex_update_customer'].sort(),
    );
    for (const t of writes) expect(t.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
  });
});
