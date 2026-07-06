# Granite

<p align="center">
  <a href="https://www.npmjs.com/package/granite-mem"><img src="https://img.shields.io/npm/v/granite-mem?color=111111" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/granite-mem"><img src="https://img.shields.io/npm/dm/granite-mem?color=111111" alt="npm downloads"></a>
  <a href="https://github.com/The-Vibe-Company/Granite/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/The-Vibe-Company/Granite/ci.yml?branch=main&label=tests&color=111111" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/The-Vibe-Company/Granite?color=111111" alt="MIT license"></a>
  <a href="https://github.com/The-Vibe-Company/Granite/stargazers"><img src="https://img.shields.io/github/stars/The-Vibe-Company/Granite?style=social" alt="GitHub stars"></a>
</p>

> **The personal OS your agent runs on.**
> Markdown files. One SQLite index. A typed contract your agent already knows how to operate.

<p align="center">
  <img src="docs/screenshots/granite-graph.png" alt="Granite constellation graph" width="720">
</p>

<p align="center">
  <b>Install it with your agent.</b> Or run it standalone as a local markdown knowledge graph.
</p>

<p align="center">
  <a href="#your-vault-in-the-cloud"><img src="https://img.shields.io/badge/☁️_Deploy_your_Granite-one_command,_sleeps_when_idle-111111?style=for-the-badge" alt="Deploy your Granite"></a>
</p>

---

## The wow moment

Paste this into **Claude Code**, **Cursor**, or any MCP-capable agent:

````
Install Granite as my personal OS.

1. `npm install -g granite-mem`
2. `granite init --template founder-os`  (vault at ~/.granite)
3. `claude mcp add granite -- granite mcp --vault ~/.granite`
4. Restart yourself so the MCP server loads.
5. Call `granite_wakeup`, then propose three notes you would write
   first based on what you know about me so far. Capture them as
   drafts with --source agent.
````

Sixty seconds later you have a live vault, a connected agent that **knows how to use it**, and three starter notes in `~/.granite/notes/`. No system prompt. No config. No cloud.

That's the thesis of this project.

## See it

<table>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/granite-graph.png" alt="Granite constellation graph">
      <br>
      <sub><b>Constellation graph.</b> Browse the vault as communities, hubs, and links.</sub>
    </td>
    <td width="50%">
      <img src="docs/screenshots/granite-search.png" alt="Granite command palette search">
      <br>
      <sub><b>Command palette.</b> Search the vault and jump straight into the graph context.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/granite-preview.png" alt="Granite note preview">
      <br>
      <sub><b>Graph-aware reading.</b> Preview notes without losing the surrounding context.</sub>
    </td>
    <td width="50%">
      <img src="docs/screenshots/granite-note.png" alt="Granite reader view">
      <br>
      <sub><b>Floating reader.</b> Open a note without leaving the constellation.</sub>
    </td>
  </tr>
</table>

## What is Granite?

A local-first markdown store with an opinionated flow. **No AI inside** — just plain files on disk, indexed by SQLite, queried deterministically.

- **Imposed flow.** Capture, compile, query, output, lint. The shape is fixed; the content is yours.
- **Four default note types** — `note`, `source`, `synthesis`, `output`. Add your own in `granite.yml` when your life grows a new shape.
- **A specialized MCP** that teaches your agent how to use the vault. Drop any MCP-capable agent on it and it knows how to operate, no system prompt required.

Your agent brings the intelligence. Granite holds the ground truth.

## Try it standalone

```bash
npm install -g granite-mem
granite init
granite serve
```

That starts with the default knowledge model: `note`, `source`, `synthesis`, and `output`. Add `--template founder-os` when you want people, organizations, meetings, and learnings wired in from the start.

## Agent-native MCP

> "A thin MCP server exposes capabilities. A strong MCP server shapes behavior."

Granite's MCP surface is intention-first:

- `granite_wakeup` to orient
- `granite_research_topic` to inspect existing knowledge before writing
- `granite_query` for structured filters over typed notes
- `granite_compile_context` to assemble a graph-aware brief
- `granite_plan_garden` to decide what to improve next
- `granite_capture_knowledge` to write with protocol fields and type contracts

The point is not to give an agent a file browser. The point is to give it a workflow it can follow.

## Types as active contracts

This is what makes the agent feel native rather than bolted-on.

```yaml
# granite.yml — every note type is an executable contract
note_types:
  meeting:
    folder: notes/meetings
    fields:
      date:         { type: date,     required: true }
      organization: { type: wikilink, target_types: [organization] }
      attendees:    { type: wikilink, target_types: [person] }
    on_create:
      - { action: set_default,       field: date, value: "${today}" }
      - { action: resolve_wikilinks, fields: [organization, attendees], auto_stub: true }
    indexed_fields: [date, organization]
    lifecycle:
      states: [active, archived]
      transitions:
        - { from: active, to: archived, trigger: stale_days, days: 180 }
```

- `set_default` — fills `${today}` automatically
- `resolve_wikilinks + auto_stub` — turns `organization: Acme Corp` into the slug `acme-corp`, creating the org note if missing (with a globally-unique slug so nothing gets silently overwritten)
- `indexed_fields` — makes `granite_query { type: meeting, where: { date: { gte: "2026-01-01" } } }` O(1) and deterministic
- `lifecycle` — `granite doctor` surfaces stale notes so gardening never drifts

Add a type when your life has a new shape. The core stays small. For the formal protocol, see [docs/GRANITE_OBJECT_STANDARD.md](docs/GRANITE_OBJECT_STANDARD.md).

## Templates

```bash
granite init                          # minimal: note / source / synthesis / output
granite init --template founder-os    # + person / organization / meeting / learning
```

`founder-os` is the full personal-OS starter: people you talk to, orgs you work with, meetings you had, things you learned. Eight types, already wired with hooks, indexed fields, and lifecycles. Open `templates/founder-os.yml` — it's 150 lines of pure YAML.

## The hard boundary

Granite will **never**:

- embed an LLM, run prompts, or hold an API key
- compute embeddings or ship a vector store
- run background agents or a scheduler
- add overlapping CLI/MCP endpoints that blur the loop

This is why your agent can be trusted with write access. The vault is a **deterministic substrate**. The intelligence is yours (or Claude's, or GPT's, or whoever you pay this quarter).

## Protocol fields

Every note carries five shared fields so humans and agents share ground truth:

| Field          | Values                                | Purpose                              |
|----------------|---------------------------------------|--------------------------------------|
| `status`       | `inbox` · `active` · `archived`       | operational state                    |
| `source`       | `human` · `agent` · `extraction`      | who wrote it                         |
| `review_state` | `draft` · `reviewed` · `locked`       | editorial state                      |
| `durability`   | `canonical` · `working` · `ephemeral` | keep / may drift / throwaway         |
| `derived_from` | `[slug, …]`                           | provenance for syntheses and outputs |

Your agent reads these before writing and sets them as it works. You inherit a fully auditable trail.

## Local-first, by design

- Markdown files are the source of truth; the SQLite index in `~/.granite/index.db` is derived state and can be rebuilt at any time
- no cloud, no telemetry, no account
- `git init` your vault and you have versioning for free
- `granite serve` gives you a local web UI — browse, search, explore the graph
- `granite daemon start` runs MCP + web UI in one background process

## Your vault in the cloud

One command deploys a personal serverless Granite on [Fly.io Sprites](https://sprites.dev): a real persistent filesystem, an MCP endpoint that **wakes on request** (100–500 ms warm) and **sleeps when idle**. Idle cost ≈ storage only — a markdown vault is a few MB, so cents per month.

```bash
export SPRITES_TOKEN=…   # from sprites.dev — your account, your sprite, your data
npx granite-mem deploy
```

That prints an MCP URL + bearer token ready to paste into Claude Code or Cursor:

```bash
claude mcp add --transport http granite https://<your-sprite>.sprites.app/mcp \
  --header "Authorization: Bearer <token>"
```

There is no central admin, no Granite cloud account, no relay: `granite deploy` provisions a sprite **you** own and pay for directly.

Manage instances from any machine with your `SPRITES_TOKEN`:

```bash
granite deploy work            # a second instance (own vault, own token, own URL)
granite deploy list            # all instances: version, health, MCP URL
granite deploy status --show-token
granite deploy                 # re-run = upgrade that instance to your CLI version
granite deploy --all           # bulk remote update of every instance
granite deploy destroy work    # permanent — asks for confirmation
```

Notes:

- Document parsing (PDF/DOCX/XLSX/PPTX) is **disabled in cloud deployments** (`GRANITE_DISABLE_DOCUMENT_PARSING=1`). Extract and import documents on your local Granite.
- Cloud instances expose MCP only — the web UI stays local.
- The vault lives at `/home/sprite/.granite` on the sprite, on durable object-storage-backed disk. There is no export/backup command in v1 — treat the sprite as the single copy for now.

### Advanced: run the HTTP MCP server yourself

Granite can expose the MCP server over HTTP anywhere you can run Node. When binding outside localhost, a bearer token is required:

```bash
export GRANITE_MCP_TOKEN="$(openssl rand -hex 32)"
granite mcp --vault ~/.granite \
  --transport http \
  --host 0.0.0.0 \
  --port 3321
```

Clients must send the token on every MCP request:

```bash
claude mcp add --transport http granite https://granite.example.com/mcp \
  --header "Authorization: Bearer $GRANITE_MCP_TOKEN"
```

A generic `Dockerfile` is included for self-hosting on your own infra (build it yourself; no public image is published). The `/health` endpoint is unauthenticated for platform checks. Do not expose `granite serve` or the web UI port `4321` on the public internet; the web UI is local-only and has no authentication.

## Direct sync

Granite sync is direct machine-to-machine. Run it over LAN, Tailscale, or a private DNS name; there is no relay, hosted worker, billing tier, or cloud authority.

```bash
# Machine A
granite sync access grant ipad --role read
granite sync access grant desktop --role write
granite sync serve --host 0.0.0.0 --port 8765

# Read-only Machine B
granite sync remote add macbook http://100.x.y.z:8765 --token <read-token>
granite sync pull macbook
granite sync watch macbook --direction pull --interval 30

# Write-capable Machine C
granite sync remote add macbook http://100.x.y.z:8765 --token <write-token>
granite sync run macbook
granite sync watch macbook --interval 30
```

Conflicts default to manual preservation with `.conflict.<device>.<timestamp>.md` files. For a personal multi-device setup, pick the device that wins conflicts:

```bash
granite sync config --policy primary-wins --primary-this-device
```

MCP is scoped to one vault per server. Launch a read-only MCP server when an agent should inspect a synced vault without mutating it:

```bash
granite mcp --vault ~/.granite --role read
granite mcp --vault ~/.granite --role write
```

For the full CLI, run `granite --help`. For development, see [CLAUDE.md](CLAUDE.md).

## Roadmap & status

Granite is pre-1.0. The current release is **v0.1.9**, with the major agent-native loop pieces now in place: typed contracts, wakeup snapshots, deterministic garden planning, document import, daemon mode, and the constellation graph.

Read [CHANGELOG.md](CHANGELOG.md) for release history. The product boundary stays fixed: Granite stores and indexes local knowledge; agents bring the intelligence.

## Contributing

Issues and focused PRs are welcome.

For local development, read [CLAUDE.md](CLAUDE.md). The key product rule is simple: no embedded LLM, no vector store, no autonomous scheduler inside Granite.

> Karpathy wrote that there was room for "an incredible new product instead of a hacky collection of scripts" around LLM knowledge bases.
>
> Granite is the product that answers that call.
>
> — [@karpathy on LLM knowledge bases](https://x.com/karpathy/status/2039805659525644595)

## Philosophy

- local-first beats cloud dependence for personal memory
- plain markdown beats proprietary formats
- **types as active contracts** beat types as folders
- tools for humans should also be legible to agents
- protocol belongs in the core; **agent policy belongs outside it**
- a personal OS is a thing you own — not a thing you rent

---

<p align="center">
  <sub>Ship your agent a home. Then give it the keys.</sub>
</p>
