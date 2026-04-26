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
  <img src="docs/screenshots/granite-note.png" alt="Granite note view" width="720">
</p>

<p align="center">
  <b>Install it with your agent.</b> Or run it standalone as a local markdown knowledge graph.
</p>

<p align="center">
  <a href="#install-prompts-copy-paste"><b>Install with your agent</b></a>
  ·
  <a href="#try-it-standalone"><b>Try it standalone</b></a>
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
      <img src="docs/screenshots/granite-empty.png" alt="Granite empty vault">
      <br>
      <sub><b>Local from the first note.</b> Markdown files on disk, indexed for search and links.</sub>
    </td>
  </tr>
</table>

## What is Granite?

Granite is a **local-first operating substrate** for the human + agent duo:

- **Files you own.** Plain markdown with YAML frontmatter in `~/.granite`. No database, no lock-in, `git` works.
- **Typed contracts, not folders.** Note types declare fields, hooks, indexed queries, and lifecycles. Create a `meeting` and the org stub, date default, and backlinks all fall into place automatically — deterministically, no LLM involved.
- **Agent-native MCP.** The server *teaches* methodology: tools organized along `orient → research → inspect → plan → mutate`. Drop any MCP-capable LLM onto the vault and it can operate it without a system prompt.
- **Hard boundary.** **No LLM, no embeddings, no scheduler inside Granite.** All intelligence lives in your agent. Granite is the disk, the schema, and the rules — never the brain.

One loop: **capture → compile → query → output → lint**.

> Karpathy wrote that there was room for "an incredible new product instead of a hacky collection of scripts" around LLM knowledge bases.
>
> Granite is the product that answers that call.
>
> — [@karpathy on LLM knowledge bases](https://x.com/karpathy/status/2039805659525644595)

## Install prompts (copy-paste)

### Claude Code / Claude Desktop

```
Install Granite for me:
  npm install -g granite-mem
  granite init --template founder-os
  claude mcp add granite -- granite mcp --vault ~/.granite
After restart, call granite_wakeup and tell me what the vault looks like.
```

### Cursor

```
Run these commands, then add Granite to .cursor/mcp.json:
  npm install -g granite-mem
  granite init --template founder-os

Append to .cursor/mcp.json:
  { "mcpServers": { "granite": { "command": "granite", "args": ["mcp", "--vault", "~/.granite"] } } }

Reload Cursor. Then call granite_wakeup.
```

### ChatGPT / any HTTP-MCP client

```
Start the Granite MCP over HTTP:
  granite mcp --transport http --host 127.0.0.1 --port 3321
Then register http://127.0.0.1:3321 as an MCP server in your client.
```

Every one of these leaves you with the same outcome: your agent owns the loop.

## Try it standalone

```bash
npm install -g granite-mem
granite init
granite serve
```

That starts with the default knowledge model: `note`, `source`, `synthesis`, and `output`. Add `--template founder-os` when you want people, organizations, meetings, and learnings wired in from the start.

## What your agent can do with it

Once connected, these are real prompts that work **out of the box**:

> **"Process my inbox."**
> The agent calls `granite_wakeup`, lists inbox notes, classifies each, rewrites them as durable `note`s, links them to existing people/orgs, and promotes `review_state: draft → reviewed`.

> **"Summarize everything I know about [[acme-corp]] before the meeting at 3pm."**
> `granite_compile_context` returns a typed brief: identity, recent meetings, people, open threads, links into related syntheses. One tool call. No fuzzy matching.

> **"I just talked to Alice from Acme about local-first sync."**
> `granite_capture_knowledge` creates a `meeting`, fills `date: today` via a hook, resolves `organization: Acme` to a slug (creates a stub if missing), links `attendees: [[alice]]`, and suggests three follow-up notes.

> **"Garden the vault."**
> `granite_plan_garden` returns the highest-leverage clusters to revisit. The agent opens the top three, revises them, and flags lifecycle transitions (`stale_days`) for your review.

Each starts from intention-level MCP tools and leaves deterministic, auditable changes in `git log`.

## What's inside

- **`granite_wakeup`** — compressed AAAK snapshot of the whole vault, usually ~200-500 tokens, so an agent can orient in one tool call instead of crawling the file tree.
- **Deterministic garden planning** — `granite_plan_garden` returns the highest-leverage notes and clusters to revisit. Eight opportunity types. No ML, no embeddings.
- **Types as active contracts** — fields, hooks, indexed queries, and lifecycles. A `meeting` note auto-fills `${today}`, resolves `[[acme-corp]]` to a slug, and can age out after 180 days.
- **`synthesis` notes with provenance** — durable compiled knowledge with `derived_from` links. Not just clipped sources: actual memory you can build on.
- **Constellation graph** — WebGL + community detection through `granite serve`. Click a node, pan the constellation, browse the vault visually.
- **Daemon mode** — MCP + web UI unified in one background process with `granite daemon start`. One port for your agent, one port for you.
- **AAAK protocol** — five shared frontmatter fields (`status`, `source`, `review_state`, `durability`, `derived_from`) so humans and agents share ground truth.
- **Document workflows** — attach assets, extract local documents, and import source notes while keeping original files linked to the vault.

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

For the full CLI, run `granite --help`. For development, see [CLAUDE.md](CLAUDE.md).

## Roadmap & status

Granite is pre-1.0. The current release is **v0.1.9**, with the major agent-native loop pieces now in place: typed contracts, wakeup snapshots, deterministic garden planning, document import, daemon mode, and the constellation graph.

Read [CHANGELOG.md](CHANGELOG.md) for release history. The product boundary stays fixed: Granite stores and indexes local knowledge; agents bring the intelligence.

## Contributing

Issues and focused PRs are welcome.

For local development, read [CLAUDE.md](CLAUDE.md). The key product rule is simple: no embedded LLM, no vector store, no autonomous scheduler inside Granite.

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
