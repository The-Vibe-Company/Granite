# Granite

> A local-first markdown memory system for humans and agents.

Granite is a simple PKM tool built around plain Markdown files, a small set of opinionated note types, and a fast loop for turning raw notes into useful memory.

Most PKM tools give you a blank canvas. Granite gives you a working system:

- capture quickly
- structure ideas without over-designing your workflow
- keep sources, durable notes, syntheses, and outputs connected
- surface what to connect or write next
- stay fully local, scriptable, and agent-friendly

If you want a flexible framework, there are already many options. Granite is for people who want plain files, strong defaults, and a memory system that starts helping immediately.

![Granite note view](docs/screenshots/granite-note.png)

## Why Granite

Granite is built around a simple loop:

`capture -> link -> recommend -> resurface`

That means:

- your notes live as plain Markdown files with YAML frontmatter
- the index is derived state, not the source of truth
- the default note types create just enough structure to stay useful
- custom note types are easy to add in `granite.yml`
- the CLI is predictable for both humans and agents
- the local web UI makes the vault browseable without adding cloud lock-in

Granite is opinionated where it matters and flexible where it should be.

## What Makes It Different

### 1. Simple by default

Granite ships with a small working model instead of an empty workspace:

- `note` for durable ideas
- `source` for imported or observed source material
- `synthesis` for durable compiled knowledge
- `output` for audience-specific deliverables

`note -> synthesis -> output`

This is enough structure to make your notes connect naturally, without forcing you into a heavyweight system.

### 2. Custom types without losing the plot

You can add your own note types in `granite.yml`, but Granite still works out of the box. The product stays simple because the core model is small and every type shares the same mechanics: folder, template, line limit, guidance, and slug strategy.

### 3. Agent-native, not just agent-compatible

Granite is designed to be easy for agents to read and act on:

- notes are plain files
- metadata is explicit
- commands support `--json`
- Granite ships with an MCP server
- vault structure is predictable
- search, backlinks, and recommendations are available from the CLI

It works well as a personal system, and it also works as a memory layer for coding agents, assistants, or local automation.

## Quickstart

Clone the repo and install dependencies:

```bash
git clone https://github.com/The-Vibe-Company/Granite
cd Granite
npm install
npm run build
npm link
```

Create the default vault in `~/.granite` and start capturing:

```bash
granite init
granite add "Talked to Alice about local-first sync tradeoffs"
granite new "Local-first sync tradeoffs" --type note
granite list
granite search "sync"
```

Start one long-running interface when you need it:

```bash
granite serve   # local web UI
granite mcp     # MCP server for agent clients
```

`granite new` does more than create a file. It can immediately suggest related links, tags, and the next note to create, which is the core of Granite's value loop.

## Example Workflow

Capture something quickly:

```bash
granite add "Users want fewer note types, but stronger defaults."
```

Turn it into a durable note:

```bash
granite new "Strong defaults beat infinite flexibility" --type note
```

Find connections:

```bash
granite suggest-links strong-defaults-beat-infinite-flexibility
granite recommend strong-defaults-beat-infinite-flexibility
granite backlinks strong-defaults-beat-infinite-flexibility
```

Open the local UI:

```bash
granite serve
```

Then browse notes, search the vault, inspect backlinks, and explore the graph locally.

![Granite graph view](docs/screenshots/granite-graph.png)

## Custom Note Types

Granite is intentionally small, but not rigid. Add a type in `granite.yml` when your workflow genuinely needs it:

```yaml
note_types:
  idea:
    folder: notes/ideas
    description: Early product ideas worth pressure-testing
    template: |
      ## Problem

      ## Insight

      ## Why now

      ## Next step
    line_limit: 120
    warn_only: true
    slug_format: title
    instructions: Capture the idea clearly, then link it to a source, note, or synthesis.
```

The point is not to create 30 note types. The point is to add a type only when it makes your memory system sharper.

## Protocol Fields

Granite keeps the core schema small, but now includes a few shared fields that help both humans and agents work safely in the same vault:

- `status`: `inbox | active | archived`
- `source`: `human | agent | extraction`
- `review_state`: `draft | reviewed | locked`
- `durability`: `canonical | working | ephemeral`
- `derived_from`: list of note IDs or slugs used as provenance

These fields are intentionally lightweight:

- `review_state` is the editorial state
- `durability` distinguishes durable knowledge from working material or situational outputs
- `derived_from` is the minimal provenance hook for syntheses and outputs

Granite does not impose a full agent workflow in the core. Richer conventions such as agent traces or synthesis policies are better handled in templates, skills, and team protocol.

## Local-First Architecture

Granite keeps the source of truth boring and durable:

- notes are Markdown files
- metadata lives in YAML frontmatter
- the default vault lives in `~/.granite`
- vault configuration lives in `~/.granite/granite.yml`
- full-text search and link resolution are backed by a local SQLite index in `~/.granite/index.db`
- the index can be rebuilt from the files at any time

This keeps the system transparent, portable, and inspectable.

## Agent-Friendly CLI

Many commands support JSON output:

```bash
granite new "Sync constraints" --type note --review-state reviewed --durability canonical --json
granite list --json
granite show sync-constraints --json
granite search "constraints" --json
granite backlinks sync-constraints --json
granite recommend sync-constraints --json
```

That makes Granite a useful substrate for local workflows, scripts, and agent memory.

## MCP Server

Granite ships with an MCP server so LLM clients can control the vault directly through tools, resources, and prompts.

Start it over stdio for local MCP clients:

```bash
granite mcp --vault /path/to/vault
```

Start it over Streamable HTTP:

```bash
granite mcp --transport http --host 127.0.0.1 --port 3321
```

The server exposes:

- tools for vault overview, list/get/search, create/update, backlinks, link suggestions, recommendations, and doctor
- resources for `granite.yml`, vault overview, note types, and individual notes via `granite://notes/{slug}`
- prompts for refining notes and reviewing links/next steps

The note payloads exposed through MCP include the shared protocol fields (`status`, `source`, `review_state`, `durability`, `derived_from`) so clients can make safer decisions without Granite embedding any model-specific logic.

Example stdio client configuration:

```json
{
  "command": "granite",
  "args": ["mcp", "--vault", "/path/to/vault"]
}
```

## Commands

```bash
granite init
granite new <title> [--type <type>] [--source <source>] [--status <status>] [--review-state <state>] [--durability <durability>] [--derived-from <refs>] [--json]
granite add [text] [--json]
granite list [--type <type>] [--json]
granite edit <slug> [--body <text>] [--append <text>] [--title <title>] [--tag <tags>] [--alias <aliases>] [--status <status>] [--source <source>] [--review-state <state>] [--durability <durability>] [--derived-from <refs>]
granite open <slug>
granite show <slug> [--json] [--body]
granite search <query> [--json]
granite backlinks <slug> [--json]
granite suggest-links <slug> [--json]
granite recommend <slug> [--json]
granite types
granite doctor
granite serve [-p <port>]
granite mcp [--vault <path>] [--transport <stdio|http>]
```

## Development

```bash
npm run build
npm run dev
npm run test
npm run test:watch
npm run lint
```

Run a single test file:

```bash
npx vitest run test/core/note.test.ts
```

Run the CLI without building:

```bash
npx tsx src/index.ts <command>
```

## Philosophy

Granite is built on a few beliefs:

- local-first beats cloud dependence for personal memory
- plain Markdown beats proprietary formats
- strong defaults beat blank canvases
- relationships between notes matter more than visual chrome
- a good PKM should help you decide what to connect or write next
- tools for humans should also be legible to agents
- protocol belongs in the core, agent policy belongs outside it

If that sounds right, Granite is the tool.
