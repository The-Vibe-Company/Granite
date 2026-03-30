# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What is Granite?

Granite (`mem` CLI) is a local-first markdown memory system for humans and agents. Notes are plain markdown files with YAML frontmatter, organized by configurable note types (fleeting, permanent, reference, person, meeting, project, decision). Configuration lives in `granite.yml` at the vault root. A SQLite index (`.granite/index.db`) provides full-text search and wikilink resolution.

## Commands

```bash
npm run build        # Build with tsup + copy web assets to dist/
npm run dev          # Run CLI directly via tsx (no build needed)
npm run test         # Run all tests (vitest)
npm run test:watch   # Run tests in watch mode
npm run lint         # Type-check with tsc --noEmit

# Run a single test file
npx vitest run test/core/note.test.ts

# Run the CLI during development
npx tsx src/index.ts <command>
```

## Architecture

- **`src/index.ts`** — CLI entrypoint using Commander. Registers all subcommands (`init`, `new`, `add`, `list`, `edit`, `open`, `search`, `backlinks`, `suggest-links`, `types`, `doctor`, `serve`).
- **`src/core/`** — Pure business logic, no CLI concerns:
  - `types.ts` — All shared interfaces (`Note`, `GraniteConfig`, `WikiLink`, `SearchResult`, etc.)
  - `config.ts` — Loads/writes `granite.yml`, holds default config
  - `vault.ts` — Vault root discovery (walks up looking for `granite.yml`), path helpers
  - `note.ts` — CRUD for notes (create, read, list, find by slug)
  - `index-db.ts` — SQLite index with FTS5 for full-text search and a `links` table for wikilink graph
  - `frontmatter.ts` — Parse/serialize YAML frontmatter via `gray-matter`
  - `wikilinks.ts` — Parse `[[wikilinks]]` from note bodies and resolve them to slugs
  - `slugify.ts` — Title-to-slug conversion
  - `search.ts`, `backlinks.ts`, `suggest.ts`, `doctor.ts` — Query/validation logic
- **`src/commands/`** — Thin CLI wrappers that call into `src/core/`
- **`src/web/`** — Hono-based local web UI served by `mem serve`

## Key Patterns

- **Vault detection**: `findVaultRoot()` walks up from CWD looking for `granite.yml`. Most commands call `requireVaultRoot()` which throws if not found.
- **Index rebuild**: `ensureIndex()` rebuilds the entire SQLite index on every command when `config.index.auto_rebuild` is true. The index is derived state — the markdown files are the source of truth.
- **Slug formats**: Fleeting notes use date-based slugs (`2026-03-30-a1b2`), all other types use title-based slugs with collision counters.
- **Note files**: Each note is `<folder>/<slug>.md` with YAML frontmatter (id, title, type, created, modified, tags, aliases).

## Testing

Tests live in `test/core/` mirroring `src/core/`. A fixture vault at `test-vault/` provides test data. Tests use vitest with globals enabled (no need to import `describe`/`it`/`expect`).
