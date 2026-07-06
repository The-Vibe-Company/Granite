# Manual smoke test — `granite deploy` on Fly.io Sprites

Not run in CI (needs a real, billed Sprites account). Run this checklist before
releasing changes to `src/core/deploy/` or `src/commands/deploy.ts`.

Prereqs: `export SPRITES_TOKEN=…` from https://sprites.dev (format `org/id/hex/hex`,
not a FlyV1 macaroon), or store it once with:

```bash
npx tsx src/index.ts deploy login --token <sprites-token>
```

⚠ `granite deploy` installs the **published** granite-mem at the CLI's own version.
The security checks below (401 without token, extract/import hidden) only pass when
the published version includes HTTP bearer auth, `--web-api`, and the document-parsing kill switch
(> 0.1.11). To smoke-test unreleased code, `npm pack`, upload the tarball to the
sprite (fs/write with `Content-Type: application/octet-stream`), `npm i -g` it there,
then stop/start the service.

## 1. Fresh deploy

```bash
npx tsx src/index.ts deploy smoke --template founder-os
```

- [ ] Steps stream while it works (create → node → install → init → service → health).
- [ ] Output shows an MCP URL ending in `/mcp` and a bearer token.
- [ ] `curl -s https://<sprite-url>/health` → `{"status":"ok","name":"granite-mcp",…}`.

## 2. MCP over the wire

```bash
curl -s https://<sprite-url>/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
```

- [ ] `initialize` succeeds; without the Authorization header it returns 401.
- [ ] `tools/list` includes `granite_wakeup` and does NOT include
      `granite_extract_document` or `granite_import_document` (document parsing
      disabled in cloud deployments).
- [ ] Optional end-to-end: `claude mcp add --transport http granite <mcp-url> --header "Authorization: Bearer <token>"`, then call `granite_wakeup` from Claude Code.

## 3. Read-only web API

```bash
curl -s https://<sprite-url>/api/graph \
  -H "Authorization: Bearer <token>"
```

- [ ] Returns JSON with `nodes` and `edges`; without the Authorization header it returns 401.
- [ ] `SPRITES_TOKEN=… npx tsx src/index.ts serve --port 4322` lists the smoke instance in the UI switcher and can load its graph.
- [ ] `unset SPRITES_TOKEN` after `deploy login`; `npx tsx src/index.ts serve --port 4322` still discovers the smoke instance from `~/.granite/config/sprites.json`.

## 4. Wake-on-request

- [ ] Wait until the sprite goes idle (a few minutes), then hit `/health` again:
      first response may take 1–2 s (cold wake) and must still be 200.

## 5. Idempotent re-deploy

```bash
npx tsx src/index.ts deploy smoke
```

- [ ] Prints "Granite updated" with `<old> → <new>` versions.
- [ ] Token is unchanged; `--rotate-token` changes it.
- [ ] Vault survives: notes captured before the re-deploy are still there.

## 6. Fleet commands

```bash
npx tsx src/index.ts deploy list
npx tsx src/index.ts deploy status smoke --show-token
npx tsx src/index.ts deploy --all
```

- [ ] `list` shows the instance with version + health; unmanaged sprites are absent.
- [ ] `--all` reconciles every instance and prints a per-instance recap.

## 7. Destroy

```bash
npx tsx src/index.ts deploy destroy smoke
```

- [ ] Asks to type the sprite name; wrong input aborts.
- [ ] After confirmation the sprite is gone (`deploy list` no longer shows it).
