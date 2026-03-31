import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeDefaultConfig, loadConfig } from '../../src/core/config.js';
import { parseFrontmatter, serializeFrontmatter } from '../../src/core/frontmatter.js';
import { createDatabase, rebuildIndex } from '../../src/core/index-db.js';
import { createNote, readNote } from '../../src/core/note.js';
import { formatRecommendations, getRecommendations, recommendNote } from '../../src/core/recommendations.js';
import type { GraniteConfig } from '../../src/core/types.js';

describe('recommendations', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-reco-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);

    for (const tc of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, tc.folder), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recommends linked notes, tags, and a next step from local context', () => {
    const granite = createNote(tmpDir, config, 'project', 'Granite', 'Granite is a local-first memory tool.\n');
    setTags(granite.filepath, ['local-first', 'knowledge-base']);

    const githubSeo = createNote(tmpDir, config, 'reference', 'GitHub SEO', 'Repository discoverability on GitHub.\n');
    setTags(githubSeo.filepath, ['github', 'seo']);

    const stan = createNote(tmpDir, config, 'person', 'Stan Girard', 'Builder behind Granite and GitHub SEO.\n');
    setTags(stan.filepath, ['founder', 'open-source']);

    const note = createNote(
      tmpDir,
      config,
      'reference',
      'Launch notes',
      'Granite should benefit from GitHub SEO. Stan Girard wrote about it.\n',
    );

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const recommendations = getRecommendations(db, readNote(note.filepath), config);
    db.close();

    expect(recommendations.links.map(link => link.slug)).toEqual(
      expect.arrayContaining(['granite', 'github-seo', 'stan-girard']),
    );
    expect(recommendations.links.some(link => link.reason.includes('mentioned'))).toBe(true);
    expect(recommendations.additions.map(item => item.text)).toEqual(
      expect.arrayContaining([
        'Add the source URL or citation.',
        'Write 2-3 key points in your own words.',
      ]),
    );
    expect(recommendations.tags.map(tag => tag.tag)).toEqual(
      expect.arrayContaining(['github', 'seo']),
    );
    expect(recommendations.next_steps[0]).toMatchObject({
      type: 'permanent',
      title_hint: 'Idea from Launch notes',
    });
  });

  it('recommends related notes through local search when no title is mentioned exactly', () => {
    const semantic = createNote(
      tmpDir,
      config,
      'permanent',
      'Semantic Search',
      'Semantic retrieval helps a note system find related ideas.\n',
    );
    setTags(semantic.filepath, ['search']);

    const vectors = createNote(
      tmpDir,
      config,
      'permanent',
      'Embeddings for Notes',
      'Vector retrieval improves knowledge discovery in a note vault.\n',
    );
    setTags(vectors.filepath, ['embeddings']);

    const target = createNote(
      tmpDir,
      config,
      'permanent',
      'Semantic retrieval for a vault',
      'A local note system should surface related knowledge quickly.\n',
    );

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const recommendations = getRecommendations(db, readNote(target.filepath), config);
    db.close();

    expect(recommendations.links.some(link => link.source === 'search')).toBe(true);
    expect(recommendations.links.map(link => link.slug)).toEqual(
      expect.arrayContaining(['semantic-search', 'embeddings-for-notes']),
    );
    expect(recommendations.tags.map(tag => tag.tag)).toContain('search');
  });

  it('does not re-suggest notes that are already linked', () => {
    createNote(tmpDir, config, 'person', 'Stan Girard', 'Builder.\n');
    const launch = createNote(
      tmpDir,
      config,
      'permanent',
      'Launch note',
      'We worked with [[Stan Girard]] on Granite.\n',
    );

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const recommendations = getRecommendations(db, readNote(launch.filepath), config);
    db.close();

    expect(recommendations.links.map(link => link.slug)).not.toContain('stan-girard');
  });

  it('uses existing linked notes to improve next-step recommendations', () => {
    createNote(tmpDir, config, 'project', 'Granite', 'Granite is a local-first memory system.\n');
    const stan = createNote(
      tmpDir,
      config,
      'person',
      'Stan Girard',
      '## Role\n\nBuilder behind Granite.\n\n## Context\n\nWorks on Granite.\n\n## Links\n\n- [[granite]]\n',
    );

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const recommendations = getRecommendations(db, readNote(stan.filepath), config);
    db.close();

    expect(recommendations.next_steps[0]).toMatchObject({
      type: 'meeting',
      title_hint: 'Stan Girard + Granite',
    });
  });

  it('gives add-now guidance for a newly created person card', () => {
    const stan = createNote(tmpDir, config, 'person', 'Stan Girard');

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const recommendations = getRecommendations(db, readNote(stan.filepath), config);
    db.close();

    expect(recommendations.additions.map(item => item.text)).toEqual(
      expect.arrayContaining([
        'Add a one-line role, company, or why this person matters.',
        'Add how you know them or what you work on together.',
        'Link one project, company, or topic in the Links section.',
      ]),
    );
  });

  it('formats recommendation sections and returns nothing when empty', () => {
    expect(formatRecommendations({
      additions: [],
      links: [],
      tags: [],
      next_steps: [],
    })).toEqual([]);

    expect(formatRecommendations({
      additions: [{ text: 'Add context.' }],
      links: [{ slug: 'granite', title: 'Granite', type: 'project', reason: 'mentioned 2 times', source: 'mention' }],
      tags: [{ tag: 'search', weight: 3, source_slugs: ['granite', 'notes'] }],
      next_steps: [{ type: 'decision', title_hint: 'Decision from Granite', reason: 'Capture the tradeoff.' }],
    })).toEqual([
      '  Add now:',
      '    Add context.',
      '  Link now:',
      '    [[granite]] — mentioned 2 times',
      '  Tag now:',
      '    search — seen on 2 nearby notes',
      '  Next note:',
      '    decision — Capture the tradeoff. Title hint: Decision from Granite.',
    ]);
  });

  it('covers next-step and add-now branches for remaining note types', () => {
    const fleeting = createNote(tmpDir, config, 'fleeting', 'Quick capture', 'Tiny note.\n');
    const meeting = createNote(tmpDir, config, 'meeting', 'Weekly sync');
    const decision = createNote(tmpDir, config, 'decision', 'Choose SQLite');
    const project = createNote(tmpDir, config, 'project', 'Granite');
    const permanent = createNote(tmpDir, config, 'permanent', 'Memory Graph');

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const fleetingRecommendations = getRecommendations(db, readNote(fleeting.filepath), config);
    expect(fleetingRecommendations.additions[0].text).toContain('Add one more sentence');
    expect(fleetingRecommendations.next_steps[0]).toMatchObject({
      type: 'permanent',
      title_hint: 'Quick capture',
    });

    const meetingRecommendations = getRecommendations(db, readNote(meeting.filepath), config);
    expect(meetingRecommendations.additions.map(item => item.text)).toEqual(
      expect.arrayContaining([
        'Link the attendees directly in the note.',
        'Capture one decision or open question.',
      ]),
    );
    expect(meetingRecommendations.next_steps[0].type).toBe('decision');

    const decisionRecommendations = getRecommendations(db, readNote(decision.filepath), config);
    expect(decisionRecommendations.additions.map(item => item.text)).toEqual(
      expect.arrayContaining([
        'Add the context that forced this decision.',
        'State the decision in one sentence.',
        'Link the project, meeting, or note affected by this decision.',
      ]),
    );
    expect(decisionRecommendations.next_steps[0].type).toBe('project');

    const projectRecommendations = getRecommendations(db, readNote(project.filepath), config);
    expect(projectRecommendations.additions.map(item => item.text)).toEqual(
      expect.arrayContaining([
        'Add a one-line goal so the project has a clear anchor.',
        'Link the people involved in the project.',
        'Record one key decision or current status update.',
      ]),
    );
    expect(projectRecommendations.next_steps[0].type).toBe('decision');

    const permanentRecommendations = getRecommendations(db, readNote(permanent.filepath), config);
    expect(permanentRecommendations.additions.map(item => item.text)).toEqual(
      expect.arrayContaining([
        'Write a one-line summary before expanding the idea.',
        'Link one project, company, person, or adjacent idea.',
      ]),
    );
    expect(permanentRecommendations.next_steps[0].type).toBe('project');

    db.close();
  });

  it('supports incremental recommendation refreshes', () => {
    createNote(tmpDir, config, 'project', 'Granite', 'Local-first system.\n');
    const note = createNote(
      tmpDir,
      config,
      'reference',
      'Fresh note',
      'Granite keeps markdown notes portable.\n',
    );

    const recommendations = recommendNote(tmpDir, config, readNote(note.filepath), {
      strategy: 'incremental',
    });

    expect(recommendations.links.some(link => link.slug === 'granite')).toBe(true);
  });
});

function setTags(filepath: string, tags: string[]): void {
  const content = fs.readFileSync(filepath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content);
  frontmatter.tags = tags;
  frontmatter.modified = new Date().toISOString();
  fs.writeFileSync(filepath, serializeFrontmatter(frontmatter, body), 'utf-8');
}
