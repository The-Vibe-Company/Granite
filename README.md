# Granite

> **The personal OS your agent runs on.**
> Markdown files. One SQLite index. A contract your agent already knows how to operate.

<p align="center">
  <img src="docs/screenshots/granite-note.png" alt="Granite note view" width="720">
</p>

<p align="center">
  <b>Install in one prompt.</b> Your agent does the rest.
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

## What is Granite?

Granite is a **local-first operating substrate** for the human + agent duo:

- **Files you own.** Plain markdown with YAML frontmatter in `~/.granite`. No database, no lock-in, `git` works.
- **Typed contracts, not folders.** Note types declare fields, hooks, indexed queries, and lifecycles. Create a `meeting` and the org stub, date default, and backlinks all fall into place automatically — deterministically, no LLM involved.
- **Agent-native MCP.** The server *teaches* methodology: tools organized along `orient → research → inspect → plan → mutate`. Drop any MCP-capable LLM onto the vault and it can operate it without a system prompt.
- **Hard boundary.** **No LLM, no embeddings, no scheduler inside Granite.** All intelligence lives in your agent. Granite is the disk, the schema, and the rules — never the brain.

One loop: **capture → compile → query → output → lint**.

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

Every one of those is a single MCP round-trip, deterministic, auditable in `git log`.

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

Add a type when your life has a new shape. The core stays small.

## Templates

```bash
granite init                          # minimal: note / source / synthesis / output
granite init --template founder-os    # + person / organization / meeting / learning
```

`founder-os` is the full personal-OS starter: people you talk to, orgs you work with, meetings you had, things you learned. Nine types, already wired with hooks, indexed fields, and lifecycles. Open `templates/founder-os.yml` — it's 150 lines of pure YAML.

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

For the full CLI, run `granite --help`. For development, see [CLAUDE.md](CLAUDE.md).

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
