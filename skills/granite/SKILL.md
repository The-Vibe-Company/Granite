---
name: granite
description: Work safely in a Granite vault using the `granite` CLI. Use when the user wants to capture, refine, link, or retrieve knowledge in a local-first markdown memory system that is readable by humans and operable by agents.
user-invocable: true
argument-hint: [action]
allowed-tools: Bash
---

You are operating a Granite vault.

Granite is not an AI product. It is a local-first knowledge substrate:

- Markdown files are the source of truth
- the SQLite index is derived state
- the CLI and MCP layer expose the vault cleanly
- agent policy lives in this skill, not in the Granite core

Your job is to keep the vault readable for humans and safe for agents.

## Core Rules

1. Read before write.
Always inspect the vault before creating or editing notes.

2. Prefer the smallest useful change.
Append, link, or update an existing note when that is clearly better than creating a duplicate.

3. Mark agent work explicitly.
When you create or edit notes as an agent, always set `--source agent`.

4. Respect editorial state.
If `review_state` is `locked`, do not silently rewrite the note. Create a new derived note instead unless the user explicitly asks to edit it.

5. Preserve provenance.
For `synthesis` and `output`, set `--derived-from` with the source note IDs or slugs you relied on.

6. Separate durable knowledge from situational output.
Use `--durability canonical` for notes meant to remain part of the durable knowledge base, `working` for intermediate material, and `ephemeral` for audience-specific outputs.

## Preferred Type Model

Prefer this model unless the user explicitly wants a more specific structured type:

| Situation | Type | Durability |
|-----------|------|------------|
| Durable idea or concept | `note` | `canonical` |
| Imported or observed source material | `source` | `canonical` |
| Compiled knowledge across multiple notes/sources | `synthesis` | `canonical` |
| Audience-specific deliverable | `output` | `ephemeral` |

## Read Workflow

Start with this loop:

```bash
granite types
granite search "<query>" --json
granite list --json slug,title,type,review_state,durability
granite show <slug> --json
granite backlinks <slug> --json
```

Use `granite suggest-links <slug>` and `granite recommend <slug>` when you need help finding the next connection or note.

## Write Workflow

Use this decision order:

1. Search for an existing note.
2. If one clearly matches, update it.
3. If the existing note is stable and your content is derived or contextual, create a new `synthesis` or `output` instead of overwriting it.
4. If nothing matches, create a new note with the smallest appropriate type.

### Create

```bash
granite new "New source" --type source --source agent --review-state draft --durability canonical --json
granite new "Transformer scaling" --type note --source agent --review-state draft --durability canonical --json
granite new "State of transformer scaling" --type synthesis --source agent --review-state draft --durability canonical --derived-from paper-a,transformer-scaling --json
granite new "Transformer team brief" --type output --source agent --review-state draft --durability ephemeral --derived-from state-of-transformer-scaling --json
```

### Update

```bash
granite edit <slug> --append $'New paragraph or bullet'
granite edit <slug> --status archived
granite edit <slug> --review-state reviewed
granite edit <slug> --durability canonical
granite edit <slug> --derived-from note-a,note-b
```

## Writing Guidance by Type

### `note`

- One durable idea per note.
- Prefer `## Summary`, `## Details`, `## Links`.
- Link to adjacent concepts instead of adding broad taxonomy.

### `source`

- Stay close to the source.
- Capture a short summary and 2-3 key facts.
- Do not smuggle a full synthesis into a source note.

Suggested body shape:

```md
## Summary

## Key Facts

- 

## Raw Content

## Links
```

### `synthesis`

- Compile multiple notes or sources into durable knowledge.
- Keep the scope explicit.
- Use `derived_from` in frontmatter for provenance.

Suggested body shape:

```md
## Scope

## Executive Summary

## Main Themes

## Open Questions

## Links
```

### `output`

- Outputs are contextual deliverables, not canonical knowledge.
- Keep them readable and audience-aware.
- Link them back to the durable knowledge they came from.

Suggested body shape:

```md
## Goal

## Audience

## Output

## References
```

## Field Usage

### `source`

- `human`: created by a person
- `agent`: created or materially edited by an agent
- `extraction`: mechanically imported from another source

Always use `agent` when you are the one writing.

### `review_state`

- `draft`: still evolving
- `reviewed`: checked and stable enough to rely on
- `locked`: should not be silently rewritten

### `durability`

- `canonical`: durable knowledge
- `working`: active scratch or intermediate material
- `ephemeral`: context-specific deliverable

### `derived_from`

Use it when the note is derived from other notes or sources, especially for:

- `synthesis`
- `output`

## Retrieval Pattern

When the user asks “what do we know about X?”:

```bash
granite search "X" --json
granite show <slug> --json
granite backlinks <slug> --json
```

Then synthesize from the retrieved notes. Do not invent provenance that is not in the vault.

## Anti-patterns

- Creating a new note without searching first
- Rewriting a `locked` note without explicit instruction
- Using `output` as if it were canonical knowledge
- Leaving `synthesis` or `output` notes without `derived_from`
- Leaving a durable note too vague to stand on its own
- Replacing links with tags when the relationship is explicit
- Editing a human-authored durable note when a derived note would be safer

## Final Check

Before you finish substantial Granite work, run:

```bash
granite doctor
```

If the change is structural or the user asked for verification, also inspect the resulting note with:

```bash
granite show <slug> --json
```
