# Granite Cloud MCP

Granite Cloud MCP is the hosted, private MCP endpoint for paid cloud vaults.

Official endpoint:

```text
https://granite.thevibecompany.co/mcp?vault_id=<vault_id>
```

Every MCP request must include:

```text
Authorization: Bearer <gsk_...>
```

Vault selection is explicit. Prefer `vault_id` in the MCP URL for client configs; `X-Vault-Id` is also supported for clients that make headers easy to manage.

## CLI Setup

Log in with Neon Auth:

```bash
granite cloud login
```

The browser flow shows a short verification code after Neon Auth login. Paste that code back into the CLI; API keys are never placed in the browser URL.

Or store an existing API key:

```bash
granite cloud login --api-key gsk_xxx --base-url https://granite.thevibecompany.co
```

Create a paid vault:

```bash
granite cloud create --name "My Vault"
```

The command opens Stripe Checkout. A vault becomes writable only after Stripe activates the subscription.

Import into an active paid vault:

```bash
granite cloud import --from ~/my-granite-vault --name "My Vault"
```

Each vault is billed separately at the Stripe price configured by `STRIPE_VAULT_1GB_PRICE_ID` and has a strict 1GB storage quota.

Print the MCP URL:

```bash
granite cloud mcp-url --vault v_xxx
```

Print a client config snippet:

```bash
granite cloud mcp-config --client cursor --vault v_xxx
```

Open Stripe billing:

```bash
granite cloud billing
```

## Client Config

Generic JSON shape for clients that support remote MCP over HTTP with headers:

```json
{
  "mcpServers": {
    "granite": {
      "url": "https://granite.thevibecompany.co/mcp?vault_id=v_xxx",
      "headers": {
        "Authorization": "Bearer gsk_xxx"
      }
    }
  }
}
```

Do not put API keys in the URL. V1 is private only and does not support public vault links.

## API Keys

List keys:

```bash
granite cloud keys
```

Create a new key:

```bash
granite cloud key-create --name cursor
```

Revoke a key:

```bash
granite cloud key-revoke gsk_prefix
```

## Cloudflare Deployment

The hosted adapter lives in `packages/cloudflare-mcp`.

Required Cloudflare bindings:

- `DATABASE_URL` secret or `HYPERDRIVE`: Neon Postgres for users, API keys, sessions, vault registry, Stripe events, billing state, and quota counters.
- `VAULT_BUCKET`: R2 bucket for markdown files and assets.
- `VAULT_OBJECT`: Durable Object namespace for per-vault runtime/index state.
- `BASE_URL`: public service URL, usually `https://granite.thevibecompany.co`.
- `NEON_AUTH_BASE_URL` and `NEON_AUTH_JWKS_URL`: environment-specific Neon Auth project endpoints, configured outside git.
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`: Stripe Billing secrets.
- `STRIPE_VAULT_1GB_PRICE_ID`: the environment-specific recurring `$5/month` Stripe Price for one 1GB vault, configured outside git.
- `CLOUDFLARE_ACCOUNT_ID`: set in the environment for non-interactive deploys when the local Wrangler session has multiple accounts.

Never commit Neon database URLs or Stripe secrets. If a database URL is pasted into chat or logs, rotate it before production.

Stripe webhook endpoint:

```text
https://granite.thevibecompany.co/stripe/webhook
```

Required events:

```text
checkout.session.completed
customer.subscription.updated
customer.subscription.deleted
```

Deploy flow:

```bash
cd packages/cloudflare-mcp
npm install
npm run db:schema # apply schema.sql to Neon with your migration tool
npm run deploy
```

`granite mcp --tunnel cloudflare` is separate. It exposes a local MCP server temporarily via Cloudflare Tunnel. Granite Cloud MCP is the hosted service described above.
