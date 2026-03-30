---
id: "550e8400-e29b-41d4-a716-446655440002"
title: Local-First Software
type: permanent
created: "2026-03-30T10:05:00.000Z"
modified: "2026-03-30T10:05:00.000Z"
tags:
  - architecture
  - software-design
aliases:
  - local-first
---

## Summary

Local-first software keeps the primary copy of data on the user's device. The cloud is optional, not required.

## Why It Matters

- **Ownership**: Your data lives on your disk
- **Speed**: No network latency for reads
- **Privacy**: No cloud dependency
- **Longevity**: Works offline, survives vendor shutdown

## Relation to Zettelkasten

The [[Zettelkasten Method]] benefits enormously from a local-first architecture. When your notes are markdown files on disk, they are:

1. Inspectable with `cat` or any text editor
2. Versionable with `git`
3. Portable across machines
4. Agent-friendly — CLI tools can read/write them

## Technical Approach

Use the filesystem as the canonical data store. Any database (like SQLite) should be a **derived index**, rebuildable from the source files.

> "The file system is the API." — Unix philosophy
