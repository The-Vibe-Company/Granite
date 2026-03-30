# Granite

> A local-first markdown memory system for humans and agents.

Granite is a simple PKM tool built around plain Markdown files, a small set of opinionated note types, and a fast loop for turning raw notes into useful memory.

Most PKM tools give you a blank canvas. Granite gives you a working system:

- capture quickly
- structure ideas without over-designing your workflow
- link people, meetings, projects, and decisions
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

- `fleeting` for quick capture
- `permanent` for durable ideas
- `reference` for external sources
- `person` for people and relationships
- `meeting` for notes with attendees, decisions, and actions
- `project` for active work
- `decision` for durable decision records

This is enough structure to make your notes connect naturally, without forcing you into a heavyweight system.

### 2. Custom types without losing the plot

You can add your own note types in `granite.yml`, but Granite still works out of the box. The product stays simple because the core model is small and every type shares the same mechanics: folder, template, line limit, guidance, and slug strategy.

### 3. Agent-native, not just agent-compatible

Granite is designed to be easy for agents to read and act on:

- notes are plain files
- metadata is explicit
- commands support `--json`
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
mem init
mem add "Talked to Alice about local-first sync tradeoffs"
mem new "Local-first sync tradeoffs" --type permanent
mem list
mem search "sync"
mem serve
```

`mem new` does more than create a file. It can immediately suggest related links, tags, and the next note to create, which is the core of Granite's value loop.

## Example Workflow

Capture something quickly:

```bash
mem add "Users want fewer note types, but stronger defaults."
```

Turn it into a durable note:

```bash
mem new "Strong defaults beat infinite flexibility" --type permanent
```

Find connections:

```bash
mem suggest-links strong-defaults-beat-infinite-flexibility
mem recommend strong-defaults-beat-infinite-flexibility
mem backlinks strong-defaults-beat-infinite-flexibility
```

Open the local UI:

```bash
mem serve
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
    instructions: Capture the idea clearly, then link it to a project, person, or permanent note.
```

The point is not to create 30 note types. The point is to add a type only when it makes your memory system sharper.

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
mem new "Sync constraints" --type permanent --json
mem list --json
mem show sync-constraints --json
mem search "constraints" --json
mem backlinks sync-constraints --json
mem recommend sync-constraints --json
```

That makes Granite a useful substrate for local workflows, scripts, and agent memory.

## Commands

```bash
mem init
mem new <title> [--type <type>] [--json]
mem add [text] [--json]
mem list [--type <type>] [--json]
mem edit <slug>
mem open <slug>
mem show <slug> [--json] [--body]
mem search <query> [--json]
mem backlinks <slug> [--json]
mem suggest-links <slug> [--json]
mem recommend <slug> [--json]
mem types
mem doctor
mem serve [-p <port>]
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

If that sounds right, Granite is the tool.
