import { describe, expect, it } from 'vitest';
import { suggestLifecycleTransitions } from '../../src/core/lifecycle.js';
import type { GraniteConfig, Note } from '../../src/core/types.js';

describe('suggestLifecycleTransitions', () => {
  const config: GraniteConfig = {
    vault_name: 't', version: 1,
    note_types: {
      organization: {
        folder: 'orgs',
        description: '',
        template: '',
        line_limit: 300,
        warn_only: true,
        lifecycle: {
          states: ['active', 'paused', 'archived'],
          transitions: [
            { from: 'paused', to: 'archived', trigger: 'stale_days', days: 180 },
          ],
        },
      },
    },
    defaults: { note_type: 'organization', editor: '$EDITOR' },
    index: { auto_rebuild: true },
  };

  function makeNote(status: string, modifiedDaysAgo: number): Note {
    const modified = new Date(Date.now() - modifiedDaysAgo * 24 * 60 * 60 * 1000).toISOString();
    return {
      slug: 'acme',
      filepath: '/tmp/acme.md',
      frontmatter: {
        id: '1', title: 'Acme', type: 'organization',
        created: modified, modified, tags: [], aliases: [],
        status: status as Note['frontmatter']['status'],
        source: 'human', review_state: 'draft', durability: 'canonical',
        derived_from: [],
      },
      body: '',
      outgoing_links: [],
    };
  }

  it('suggests the stale_days transition when threshold is exceeded', () => {
    const note = makeNote('paused', 200);
    const suggestions = suggestLifecycleTransitions(note, config);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].to).toBe('archived');
  });

  it('does not suggest when threshold is not reached', () => {
    const note = makeNote('paused', 30);
    expect(suggestLifecycleTransitions(note, config)).toEqual([]);
  });

  it('does not suggest when state does not match', () => {
    const note = makeNote('active', 300);
    expect(suggestLifecycleTransitions(note, config)).toEqual([]);
  });
});
