# TD SYNNEX StreamOne ION connector

User-facing setup guide for the WYRE AI connector to TD SYNNEX StreamOne ION. Developer and deployment details are in the [README](../README.md).

> **Status:** not yet tested against a live StreamOne ION account. Treat results with care and expect rough edges until it has been validated.

## What it does

Lets your AI assistant look up and (if you allow it) manage things in your StreamOne ION reseller account:

- **Customers** — search, view, view cloud-provider profiles; create and update (write)
- **Products and pricing** — search the catalog, view a product, get price-book pricing and the availability flag for products
- **Orders** — list all orders or one customer's orders, view an order; place and cancel orders (write)
- **Subscriptions** — list and view subscriptions, licenses and renewal dates
- **Carts and quotes** — list/view carts and cart items; create carts and quotes; check out a cart (write). In ION a quote is a cart with status `QUOTE`.

ION is a cloud/subscription marketplace: there is no physical stock level. "Availability" is the product's availability flag in ION.

## What you need from ION

1. **Your account id** — ION portal → *Quick Access → Account Information*.
2. **An OAuth refresh token** for a dedicated API user — ION portal → *Settings → Users → pick the user → Edit → OAuth credentials → Request New Credentials*, then copy the Refresh Token.

> Refresh tokens are **single-use**: each time one is exchanged, ION issues a new one and the old one stops working. Whoever connects ION (WYRE AI, or the local server) must store the newest token. If the stored token is lost or expires (32 days), generate a new one in the portal and reconnect.

## Connecting

- **Through the WYRE AI gateway:** add the connector, enter the account id and refresh token once. The gateway keeps the rotating token fresh and passes the MCP server a current access token on every call. Nothing else to configure.
- **Locally (Claude Desktop / CLI, stdio):** set `TDSYNNEX_ACCOUNT_ID`, `TDSYNNEX_REFRESH_TOKEN` and `TDSYNNEX_REFRESH_TOKEN_FILE` (a file the server may write, so the rotated token survives restarts). See `.env.example`.

## Read-only by default

The connector starts **read-only**: write tools are not offered to the assistant at all. An administrator turns writes on with `READ_ONLY_MODE=false` on the connector. Even then:

- Creating a customer, updating a customer, or creating a cart/quote happens when the assistant calls the tool, so only enable writes for assistants you trust and review what they ask. (The generated login password for a new customer is never shown to the assistant; set it from the ION portal.)
- **Placing an order, checking out a cart, and cancelling an order are two-step.** The assistant first gets a preview (nothing is sent), shows you exactly what would be sent, and only after you approve does it send the same request with the confirmation token from the preview. The token is valid for 30 minutes, works once, and only for that exact request.
- Orders are size-capped (25 lines, 1000 per line by default) as a safety net; an administrator can change the caps.

## Good prompts

- "List my active customers and show their latest orders."
- "What does Microsoft 365 Business Premium cost for customer 56789, and is it available?"
- "Which subscriptions expire next month?"
- "Show me the quotes for customer 56789."
- With writes on: "Prepare an order for 10 seats of … for customer 56789 and show me the preview." (Then review before approving.)

## Limitations

- Not yet covered: changing licence counts or renewal settings on existing subscriptions, provisioning tenants/cloud providers, reports, adding items to a cart.
- Cart and quote endpoints are implemented as the ION docs show them; if ION expects a different path they will fail until fixed.
- TD SYNNEX has announced an official PartnerFirst MCP server (no public access docs yet); we may switch to it later.
