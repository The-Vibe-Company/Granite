---
id: "550e8400-e29b-41d4-a716-446655440003"
title: Wikilinks
type: permanent
created: "2026-03-30T10:10:00.000Z"
modified: "2026-03-30T10:10:00.000Z"
tags:
  - linking
  - syntax
aliases: []
---

## Summary

Wikilinks use the `[[double bracket]]` syntax to create links between notes. They are the backbone of the [[Zettelkasten Method]].

## Syntax

- `[[Note Title]]` — link to a note by title
- `[[Note Title|Display Text]]` — link with custom display text

## Resolution

Links are resolved by:

1. Exact slug match
2. Case-insensitive title match
3. Alias match

Broken links (pointing to non-existent notes) should be visually distinct — typically shown in red.

## Why Not Regular Links?

Regular markdown links (`[text](url)`) require knowing the file path. Wikilinks use **semantic references** — you link by meaning, not by location. This makes the [[Local-First Software]] approach more powerful.
