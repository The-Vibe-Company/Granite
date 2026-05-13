# Granite Cloud MCP

Granite Cloud MCP is the hosted, private MCP endpoint for cloud vaults.

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

Log in with GitHub:

```bash
granite cloud login
```

The browser flow shows a short verification code after GitHub login. Paste that code back into the CLI; API keys are never placed in the browser URL.

Or store an existing API key:

```bash
granite cloud login --api-key gsk_xxx --base-url https://granite.thevibecompany.co
```

Create or import a vault:

```bash
granite cloud create --name "My Vault"
granite cloud import --from ~/my-granite-vault --name "My Vault"
```

Print the MCP URL:

```bash
granite cloud mcp-url --vault v_xxx
```

Print a client config snippet:

```bash
granite cloud mcp-config --client cursor --vault v_xxx
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

- `ACCOUNTS_DB`: D1 database for users, API keys, sessions, and vault registry.
- `VAULT_BUCKET`: R2 bucket for markdown files and assets.
- `VAULT_OBJECT`: Durable Object namespace for per-vault runtime/index state.
- `BASE_URL`: public service URL, usually `https://granite.thevibecompany.co`.
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: OAuth app credentials.
- `CLOUDFLARE_ACCOUNT_ID`: set in the environment for non-interactive deploys when the local Wrangler session has multiple accounts.

The repository does not commit production Cloudflare account or database IDs. Before deploy, set the real D1 `database_id` in the deployment environment's Wrangler config.

Deploy flow:

```bash
cd packages/cloudflare-mcp
npm install
npm run db:migrate
npm run deploy
```

`granite mcp --tunnel cloudflare` is separate. It exposes a local MCP server temporarily via Cloudflare Tunnel. Granite Cloud MCP is the hosted service described above.
