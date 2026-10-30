# TD SYNNEX StreamOne ION MCP Server

MCP server for [TD SYNNEX StreamOne ION](https://www.tdsynnex.com/ion/api/)'s v3 partner API: customers, products and pricing, orders, subscriptions, and carts/quotes, for AI assistants and the WYRE Conduit gateway.

> **Status: untested against the live StreamOne ION API.** Built from the public docs with mocked tests only; no StreamOne ION credentials were available.

TD SYNNEX has announced an official PartnerFirst MCP server; it has no public access docs yet, and we may switch to it later.

**Read-only by default.** Write tools (create/update customer, create/cancel order, create cart, checkout cart) are not even listed unless `READ_ONLY_MODE=false`, and orders and cancellations additionally need a user-approved preview/confirm step. See [Write safety](#write-safety).

## Authentication

StreamOne ION v3 uses OAuth 2.0 with **single-use, rotating refresh tokens**.

1. **Account id** — in the ION portal: *Quick Access → Account Information*.
2. **Refresh token** — in the ION portal: *Settings (top right) → Users → select the user → Edit → OAuth credentials → Request New Credentials*, then copy the Refresh Token. Use a dedicated API user; refresh tokens are user-specific and must not be shared.
3. The server exchanges it: `POST https://ion.tdsynnex.com/oauth/token` (multipart form: `grant_type=refresh_token`, `redirect_uri=http://localhost/`, `refresh_token`). The response has an `access_token` (valid 2 hours), **a new `refresh_token`** (valid 32 days), and the old refresh token is now dead. API calls send `Authorization: Bearer <access_token>`.

### The rotation caveat (read this)

Because every exchange invalidates the refresh token you gave it, *whoever exchanges it must keep the new one*. That decides where credentials live:

| Mode | Who owns rotation | What this server does |
|---|---|---|
| **stdio / `AUTH_MODE=env`** | This server | Exchanges the refresh token, caches the access token in memory until ~60 s before expiry, single-flights concurrent refreshes (one exchange, shared), and keeps the rotated refresh token in memory. With `TDSYNNEX_REFRESH_TOKEN_FILE` set it also writes the rotated token back (atomic write, mode `0600`) and reads it from there on start. **Without the file, a restart loses the rotated token and the originally configured one is already invalid — you must generate a new one in the ION portal.** A warning (no values) is logged on first exchange if no file is configured. Exchanges are never retried automatically (a lost response may already have consumed the token). |
| **`AUTH_MODE=gateway`** (Docker default) | The gateway (Conduit) | The server **never sees the refresh token**. The gateway exchanges and rotates it, and sends a current access token with each request in `X-TDSynnex-Access-Token`. A stateless sidecar that exchanged the stored refresh token itself would invalidate the gateway's copy, so this mode deliberately has no exchange path. |

> **Conduit integration requirement:** in gateway mode the gateway must own the refresh-token lifecycle (store the latest refresh token, exchange it before the 2-hour access token expires — or on a 401 —, persist the rotated token, and inject `X-TDSynnex-Account-Id` + `X-TDSynnex-Access-Token` on every `/mcp` request). A missing header returns 401; there is no env fallback.

A static `TDSYNNEX_ACCESS_TOKEN` is also accepted for quick local tests; it expires after 2 hours and is not renewed.

## Configuration

Copy [`.env.example`](.env.example) and set the variables below.

| Variable | Required | Description |
|---|---|---|
| `TDSYNNEX_ACCOUNT_ID` | For stdio and `AUTH_MODE=env` | Numeric reseller account id. Gateway mode does not read this. |
| `TDSYNNEX_REFRESH_TOKEN` | One of the three credentials | Refresh token (see above). Rotates on every exchange. |
| `TDSYNNEX_REFRESH_TOKEN_FILE` | Recommended with a refresh token | File holding the current refresh token. If present it is read at first use (and wins over `TDSYNNEX_REFRESH_TOKEN`); after each exchange the rotated token is written back atomically with mode `0600`. If the file does not exist yet, `TDSYNNEX_REFRESH_TOKEN` bootstraps it. |
| `TDSYNNEX_ACCESS_TOKEN` | One of the three credentials | Static bearer token. Ignored when a refresh token or token file is set. |
| `READ_ONLY_MODE` | No | **Default read-only.** Anything other than exactly `false` means read-only. In read-only mode write tools are not listed in `tools/list`, and calling one returns an error saying the connection is read-only. The Docker image and Compose file default to `true`. |
| `TDSYNNEX_MAX_ORDER_LINES` | No | Local cap on lines per order / checkout. Default `25`. |
| `TDSYNNEX_MAX_LINE_QUANTITY` | No | Local cap on quantity per order line. Default `1000`. |
| `TDSYNNEX_CONFIRM_SECRET` | No | HMAC key (at least 32 bytes) for order confirm tokens. If unset, a random per-process key is used and a warning is logged: tokens then don't survive a restart or work across replicas. Generate with `openssl rand -hex 32`. |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http`. |
| `AUTH_MODE` | No | `gateway` (Docker image and Compose default) or `env`. Gateway mode requires `X-TDSynnex-Account-Id` and `X-TDSynnex-Access-Token` on each `/mcp` request and never falls back to `TDSYNNEX_*`. `env` uses those variables after S2S auth succeeds (a request that does carry the headers uses them instead). |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. The HTTP server logs an error and exits non-zero when this is empty or a known placeholder. Compose will not start without it. Never commit a real value. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to exactly `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` is overridden and logged. A placeholder secret still refuses to start. |
| `MCP_HTTP_HOST` | No | Bind address when a secret is configured. Unset means `0.0.0.0`. The container image sets `0.0.0.0`. Ignored in favor of `127.0.0.1` when the insecure-dev bypass is on. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |
| `LOG_LEVEL` | No | `debug`, `info` (default), `warn`, or `error`. Tokens and passwords are never logged. |

`/health` stays unauthenticated, does not require `X-Gateway-S2S`, and does not read vendor credentials or contact TD SYNNEX. The stdio transport does not use `CONDUIT_S2S_SECRET`.

### HTTP authentication

With `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` set, every `/mcp` request must include `X-Gateway-S2S`. The value is `t=<unix seconds>,v1=<hex hmac-sha256>`. The hex digest is HMAC-SHA256 over the exact ASCII string `t=<unix seconds>` (the same prefix that appears in the header), keyed with `CONDUIT_S2S_SECRET`, encoded as 64 lowercase hex characters. The timestamp must be within 300 seconds of the server clock. A missing or invalid header returns 401. The secret is never written to logs or the response.

```
X-Gateway-S2S: t=1710000000,v1=<64 lowercase hex chars>
```

Known placeholders are rejected at startup and do not count as a configured secret: `changeme`, `change-me`, `secret`, `example`, `placeholder`, `replace-me`, `your-secret`, `your-s2s-secret`, `s2s-secret`, `replace-with-a-real-secret`. Generate a value with `openssl rand -hex 32`.

In `AUTH_MODE=gateway`, `/mcp` also requires `X-TDSynnex-Account-Id` (numeric) and `X-TDSynnex-Access-Token`. Those headers are the only TD SYNNEX credentials for that request. A request missing either returns 401 and does not fall back to `TDSYNNEX_*`.

Request bodies over **1 MB** are refused with `413`; invalid JSON gets `400`. String tool arguments are length-capped (500 characters by default, tighter or looser per field), ids are validated, and unknown arguments are rejected.

## Tools

All tools are prefixed `tdsynnex_`. **Read** tools are annotated `readOnlyHint: true`; **write** tools `readOnlyHint: false, destructiveHint: true, idempotentHint: false` and their descriptions start with a note that they change data at TD SYNNEX and need the user's explicit approval.

### Read-only

| Tool | Endpoint |
|---|---|
| `tdsynnex_list_customers` | `GET /accounts/{a}/customers` (filters: email, name, status, language) |
| `tdsynnex_get_customer` | `GET /accounts/{a}/customers/{c}` |
| `tdsynnex_get_customer_cloud_profiles` | `GET /accounts/{a}/customers/{c}/cloudProfiles?providerId=` |
| `tdsynnex_list_products` | `GET /accounts/{a}/products` (documented `filter.*`) |
| `tdsynnex_get_product` | `GET /accounts/{a}/products/{productId}` |
| `tdsynnex_get_product_pricing` | `POST /accounts/{a}/products:pricing` — a POST, but read-only |
| `tdsynnex_list_orders` | `GET /accounts/{a}/orders` |
| `tdsynnex_list_customer_orders` | `GET /accounts/{a}/customers/{c}/orders` |
| `tdsynnex_get_order` | `GET /accounts/{a}/customers/{c}/orders/{orderId}` |
| `tdsynnex_list_subscriptions` | `GET /accounts/{a}/subscriptions` |
| `tdsynnex_get_subscription` | `GET /accounts/{a}/customers/{c}/subscriptions/{subscriptionId}` |
| `tdsynnex_list_carts` | `GET /customers/{c}/carts` (use `status=QUOTE` for quotes) |
| `tdsynnex_get_cart` | `GET /customers/{c}/carts/{cartId}` |
| `tdsynnex_list_cart_items` | `GET /customers/{c}/carts/{cartId}/cartItems` |

### Write (hidden unless `READ_ONLY_MODE=false`)

| Tool | Endpoint | Preview/confirm |
|---|---|---|
| `tdsynnex_create_customer` | `POST /accounts/{a}/customers` — the response's generated user `password` is **redacted** from output | no |
| `tdsynnex_update_customer` | `PUT /accounts/{a}/customers/{c}` (replaces profile fields; fetch first) | no |
| `tdsynnex_create_order` | `POST /accounts/{a}/customers/{c}/orders` (action `CREATE` only) — **places a real, billable order** | **yes** |
| `tdsynnex_cancel_order` | `POST /accounts/{a}/customers/{c}/orders/{orderId}:cancel` | **yes** |
| `tdsynnex_create_cart` | `POST /customers/{c}/carts` (status `QUOTE` creates a quote) | no |
| `tdsynnex_checkout_cart` | `POST /customers/{c}/carts/{cartId}:checkout` — **places a real, billable order** | **yes** |

**Availability / inventory:** StreamOne ION is cloud/subscription distribution and has no physical stock or inventory endpoint. The `productAvailability` field in product and pricing responses is the only availability signal; the list/get/pricing tools say so in their descriptions.

**Paging:** token-based lists take `pageSize` (default 25) and `pageToken` (the previous `nextPageToken`); `tdsynnex_list_subscriptions` and `tdsynnex_list_carts` use ION's `limit`/`offset`. The maximum page size of 100 is **a local cap of this connector**, not a documented ION limit.

## Write safety

- **Read-only by default.** Unless `READ_ONLY_MODE` is exactly `false`, write tools are absent from `tools/list` and any call to one returns an error stating the connection is read-only; nothing reaches TD SYNNEX.
- **Preview/confirm for `create_order`, `checkout_cart` and `cancel_order`.** The first call (no `confirmToken`) performs **no vendor write**: it validates the input and returns the exact method, URL and normalized body that would be sent, plus a `confirmToken`. The agent must show that to the user; after explicit approval it calls again with the **identical arguments plus the `confirmToken`**. The token is an HMAC (key: `TDSYNNEX_CONFIRM_SECRET`, or a random per-process key) over the tool name, account, customer and the exact normalized request; it expires after **30 minutes** and is **single-use** (a replayed or failed-then-retried token is refused — preview again). A token for different arguments, another customer/account/tool, a tampered or expired token, or a forged one is refused and nothing is sent.
- **Local caps** (this connector's own limits, not TD SYNNEX's): `TDSYNNEX_MAX_ORDER_LINES` (default 25) on order lines / checkout provision lines and `TDSYNNEX_MAX_LINE_QUANTITY` (default 1000) per order line; invalid values stop the server at startup. Over-limit requests are refused before any preview.
- Order creation accepts only `action: CREATE`. Subscription changes (the `UPDATE` scenarios) are not implemented.
- Input validation: account/customer/order/subscription ids must be digits; product, cart and provider ids match `^[A-Za-z0-9._:-]{1,128}$`; every path segment is URL-encoded.

## Not yet implemented

Update Order (subscription license/renewal/suspend/upgrade changes), cloud-provider provisioning (create/get/link customer cloud provider), provisioning templates, verticals/categories, reports, update cart, and cart-item create/update/get. The deprecated cloud-profiles variant is not exposed either.

## Known issues / unverified

Nothing here has run against a live ION account.

- **Cart paths vs. account id.** The docs show cart endpoints *without* `/accounts/{accountId}` (`https://ion.tdsynnex.com/api/v3/customers/{customerId}/carts`) even though the introduction says every endpoint takes `accountId`. They are implemented exactly as documented. If ION actually wants the account in the path, the three cart read tools, `create_cart` and `checkout_cart` will 404. (The docs' own endpoint table also contains the typo `v3/accounts/v3/customers/...` for Get Cart.)
- **Swagger not machine-read.** The docs call the v3 Swagger portal (https://www.tdsynnex.com/ion/v3api/) authoritative, but it is JS-rendered and was not read; field names/requirements come from https://docs.streamone.cloud/, which is "in progress" and inconsistent in places (e.g. `pageSize` vs `page_size`, `priceBookCustomerId` in the sample but `pricebookCustomerId` in the parameter table, `cartDisplayName` vs `cartdisplayName`, `totalCalculatedValue` vs `totalcalculatedValue`, `redirect_uri` vs `redirect_url`, an `Authentication: Bearer` header in prose vs `Authorization: Bearer` in every example). This server follows the sample requests.
- **Quotes = carts.** The v3 docs have no separate quotes API; ION represents quotes as carts with status `QUOTE` (one of the `CART_STATUS` values). "Quote" tools are the cart tools.
- **No inventory endpoint.** See Availability above.
- **Order body.** Which `Create Order` fields are required differs between the documented scenarios (new/existing tenant × new/existing customer, Microsoft vs Google); the tool validates types and rejects unknown keys but leaves field requirements to ION. `attributes` must follow the product's provisioning template (not implemented as a tool).
- **Id formats.** Subscription ids are validated as digits (the list response's numeric `id`); the docs call the path parameter a string and the response also has a UUID `subscriptionId`. `cartItemId` is sent as a number, as in the docs' sample.
- **Cart items.** `create_cart` makes an empty cart; the documented cart-item endpoints list paths that do not match their own descriptions, so adding items is left out.
- **Retries.** No automatic retries (the docs suggest retrying transient errors; not done so that writes are never silently repeated). A 401 on a refresh-token-managed session forces one refresh and one retry.
- **Rate limits.** The docs say none are currently enforced.

## Documentation sources

- https://docs.streamone.cloud/ — full public reference (sections: Authentication, End Customer, Product, Order, Subscription, Cart, Cart Items, Errors)
- https://www.tdsynnex.com/ion/v3api/ — Swagger portal (v3), authoritative per the docs; not machine-read
- https://www.tdsynnex.com/ion/api/ — StreamOne ION API landing page

See also [docs/connector.md](docs/connector.md) for the end-user connector setup.

## Development

```bash
npm install
npm run build
npm test
npm run lint   # tsc --noEmit
```

Tests mock `fetch`; nothing contacts TD SYNNEX.

## Docker

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to `AUTH_MODE=gateway` and `READ_ONLY_MODE=true`. Publish the port on loopback and pass the S2S secret. In gateway mode the account id and access token arrive on each request as `X-TDSynnex-Account-Id` and `X-TDSynnex-Access-Token`; they are not read from the environment.

```bash
docker build -t td-synnex-mcp .
docker run \
  -e CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" \
  -p 127.0.0.1:8080:8080 \
  td-synnex-mcp
```

Do not pass a known placeholder such as `your-s2s-secret` or `changeme`. Startup treats those as unset and exits. Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, sets `AUTH_MODE=gateway`, does not pass `TDSYNNEX_ACCOUNT_ID` or any token, and publishes `127.0.0.1:8080:8080`. A project `.env` is interpolation only — do not add `env_file` to the gateway service.

```bash
CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `TDSYNNEX_*`. Mount a writable token file so rotation survives restarts:

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" \
  -e AUTH_MODE=env \
  -e TDSYNNEX_ACCOUNT_ID=your-account-id \
  -e TDSYNNEX_REFRESH_TOKEN_FILE=/data/refresh.token \
  -v tdsynnex-token:/data \
  -e MCP_HTTP_HOST=0.0.0.0 \
  -p 127.0.0.1:8080:8080 \
  td-synnex-mcp
```

(Seed `/data/refresh.token` with the refresh token from the ION portal, readable and writable by uid 1001, or pass it once via `TDSYNNEX_REFRESH_TOKEN`.)

Local HTTP without a secret is development-only. It binds `127.0.0.1` and logs a warning. A non-loopback `MCP_HTTP_HOST` (including `0.0.0.0`) is overridden and that override is logged:

```bash
MCP_ALLOW_INSECURE_DEV=1 npm run start:http
```

A signed gateway request:

```bash
curl -sS http://127.0.0.1:8080/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "x-gateway-s2s: $X_GATEWAY_S2S" \
  -H "x-tdsynnex-account-id: $TDSYNNEX_ACCOUNT_ID" \
  -H "x-tdsynnex-access-token: $TDSYNNEX_ACCESS_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
