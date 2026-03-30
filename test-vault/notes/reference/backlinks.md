---
id: "550e8400-e29b-41d4-a716-446655440005"
title: Backlinks
type: reference
created: "2026-03-30T10:20:00.000Z"
modified: "2026-03-30T10:20:00.000Z"
tags:
  - concept
aliases:
  - back-links
  - incoming links
---

## Definition

A backlink is an incoming link — it shows you which notes reference the current note.

## Why They Matter

Backlinks enable **emergent structure**. You don't need to plan your hierarchy upfront. Just write notes and link them. Over time, heavily-linked notes become natural hubs.

## Example

If note A contains `[[Backlinks]]`, then the backlinks panel on this note will show "← Note A".

## Implementation

```sql
SELECT source_slug, context
FROM links
WHERE target_slug = ?
```

This query powers the backlinks feature in the [[Zettelkasten Method]] tool.
