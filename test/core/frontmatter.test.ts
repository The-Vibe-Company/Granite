import { describe, it, expect } from 'vitest';
import { parseFrontmatter, serializeFrontmatter } from '../../src/core/frontmatter.js';
import type { NoteFrontmatter } from '../../src/core/types.js';

describe('frontmatter', () => {
  const sampleContent = `---
id: "abc-123"
title: Test Note
type: note
created: "2026-03-30T10:00:00.000Z"
modified: "2026-03-30T10:00:00.000Z"
tags:
  - test
  - demo
aliases:
  - my-test
---

Hello world!
This is the body.
`;

  it('parses frontmatter fields correctly', () => {
    const { frontmatter, body } = parseFrontmatter(sampleContent);
    expect(frontmatter.id).toBe('abc-123');
    expect(frontmatter.title).toBe('Test Note');
    expect(frontmatter.type).toBe('note');
    expect(frontmatter.tags).toEqual(['test', 'demo']);
    expect(frontmatter.aliases).toEqual(['my-test']);
    expect(frontmatter.status).toBe('active');
    expect(frontmatter.source).toBe('human');
    expect(frontmatter.review_state).toBe('draft');
    expect(frontmatter.durability).toBe('working');
    expect(frontmatter.derived_from).toEqual([]);
  });

  it('extracts body without frontmatter', () => {
    const { body } = parseFrontmatter(sampleContent);
    expect(body).toContain('Hello world!');
    expect(body).not.toContain('id:');
  });

  it('round-trips frontmatter + body', () => {
    const fm: NoteFrontmatter = {
      id: 'xyz-456',
      title: 'Round Trip',
      type: 'note',
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      tags: ['a'],
      aliases: [],
      status: 'active',
      source: 'human',
      review_state: 'reviewed',
      durability: 'canonical',
      derived_from: ['src-1'],
    };
    const body = 'Some content here.\n';
    const serialized = serializeFrontmatter(fm, body);
    const { frontmatter: parsed, body: parsedBody } = parseFrontmatter(serialized);

    expect(parsed.id).toBe(fm.id);
    expect(parsed.title).toBe(fm.title);
    expect(parsed.type).toBe(fm.type);
    expect(parsed.tags).toEqual(fm.tags);
    expect(parsed.status).toBe('active');
    expect(parsed.source).toBe('human');
    expect(parsed.review_state).toBe('reviewed');
    expect(parsed.durability).toBe('canonical');
    expect(parsed.derived_from).toEqual(['src-1']);
    expect(parsedBody).toContain('Some content here.');
  });

  it('normalizes invalid protocol metadata from yaml', () => {
    const invalid = `---
id: "bad"
title: Bad Metadata
type: note
status: wrong
source: false
review_state: nope
durability: 123
derived_from: source-1
tags: tag
aliases: alias
---

Body.
`;
    const { frontmatter } = parseFrontmatter(invalid);
    expect(frontmatter.status).toBe('active');
    expect(frontmatter.source).toBe('human');
    expect(frontmatter.review_state).toBe('draft');
    expect(frontmatter.durability).toBe('working');
    expect(frontmatter.derived_from).toEqual([]);
    expect(frontmatter.tags).toEqual([]);
    expect(frontmatter.aliases).toEqual([]);
  });

  it('handles missing optional fields gracefully', () => {
    const minimal = `---
id: "min"
title: Minimal
---

Body.
`;
    const { frontmatter } = parseFrontmatter(minimal);
    expect(frontmatter.id).toBe('min');
    expect(frontmatter.tags).toEqual([]);
    expect(frontmatter.aliases).toEqual([]);
    expect(frontmatter.type).toBe('');
    expect(frontmatter.review_state).toBe('draft');
    expect(frontmatter.durability).toBe('working');
    expect(frontmatter.derived_from).toEqual([]);
  });
});
