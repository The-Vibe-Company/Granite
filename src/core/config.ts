import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { GraniteConfig } from './types.js';

const CONFIG_FILENAME = 'granite.yml';

const DEFAULT_CONFIG: GraniteConfig = {
  vault_name: 'My Vault',
  version: 1,
  note_types: {
    fleeting: {
      folder: 'notes/fleeting',
      description: 'Quick captures, inbox items',
      template: '',
      line_limit: 50,
      warn_only: true,
      slug_format: 'date',
      instructions: 'Write a short thought, observation, or idea. Keep it raw — refine later into a permanent note.',
    },
    permanent: {
      folder: 'notes/permanent',
      description: 'Refined, linked notes — one idea per note',
      template: '## Summary\n\n## Details\n\n## Links\n',
      line_limit: 200,
      warn_only: false,
      instructions: 'One atomic idea per note. Write a clear summary, then expand in details. Link to related notes with [[wikilinks]]. If the note grows too long, split it.',
    },
    reference: {
      folder: 'notes/reference',
      description: 'Notes on external sources (articles, books, talks)',
      template: '## Source\n\nURL or citation here.\n\n## Date\n\n## Key Points\n\n- \n\n## My Take\n\n',
      line_limit: 300,
      warn_only: true,
      instructions: 'Capture the source, the key points in your own words, and your reaction. Link to permanent notes that relate.',
    },
    person: {
      folder: 'notes/people',
      description: 'Card for a person — contact, context, history',
      template: '## Role\n\n## Context\n\nHow I know them, what we work on.\n\n## Contact\n\n## Notes\n\n- \n\n## Links\n\n',
      line_limit: 150,
      warn_only: true,
      instructions: 'Fill in their role and context. Add timestamped notes as you interact (meetings, emails, calls). Link to projects, companies, or topics they relate to.',
      fields: {
        role: { type: 'text', description: 'Job title or role' },
        org: { type: 'text', description: 'Organization or company' },
        contact: { type: 'text', description: 'Email, Slack, phone' },
      },
    },
    meeting: {
      folder: 'notes/meetings',
      description: 'Meeting notes with attendees, decisions, and actions',
      template: '## Attendees\n\n- \n\n## Agenda\n\n- \n\n## Notes\n\n\n\n## Decisions\n\n- \n\n## Actions\n\n- [ ] \n',
      line_limit: 300,
      warn_only: true,
      instructions: 'List attendees as [[person]] links. Capture decisions and action items clearly. Link to relevant projects or topics.',
      fields: {
        attendees: { type: 'list', of: 'wikilink', description: 'People present' },
        date: { type: 'date', description: 'Meeting date' },
        project: { type: 'wikilink', description: 'Related project' },
      },
    },
    project: {
      folder: 'notes/projects',
      description: 'Project overview — goals, status, people, links',
      template: '## Goal\n\n## Status\n\n## People\n\n- \n\n## Key Decisions\n\n- \n\n## Links\n\n',
      line_limit: 300,
      warn_only: true,
      instructions: 'Define the goal clearly. Keep status updated. Link to people involved, meeting notes, and related permanent notes.',
      fields: {
        people: { type: 'list', of: 'wikilink', description: 'Team members involved' },
        project_status: { type: 'enum', options: ['planning', 'active', 'paused', 'completed'], default: 'active', description: 'Project lifecycle' },
      },
    },
    decision: {
      folder: 'notes/decisions',
      description: 'Record of a decision — context, options, outcome',
      template: '## Context\n\nWhat prompted this decision.\n\n## Options Considered\n\n1. \n2. \n\n## Decision\n\n\n\n## Rationale\n\n## Status\n\nActive\n',
      line_limit: 200,
      warn_only: false,
      instructions: 'Document the context, what options were considered, what was decided, and why. This is a permanent record — future-you will thank you. Link to the project or topic.',
      fields: {
        context_for: { type: 'wikilink', description: 'Project or area this decision belongs to' },
        decision_status: { type: 'enum', options: ['active', 'superseded', 'revisit'], default: 'active', description: 'Decision lifecycle' },
        superseded_by: { type: 'wikilink', description: 'Replacement decision if superseded' },
      },
    },
  },
  defaults: {
    note_type: 'fleeting',
    editor: '$EDITOR',
  },
  index: {
    auto_rebuild: true,
  },
};

export function getDefaultConfig(): GraniteConfig {
  return structuredClone(DEFAULT_CONFIG);
}

export function writeDefaultConfig(dir: string): void {
  const configPath = path.join(dir, CONFIG_FILENAME);
  const content = yaml.dump(DEFAULT_CONFIG, { lineWidth: 120, noRefs: true });
  fs.writeFileSync(configPath, content, 'utf-8');
}

export function loadConfig(vaultRoot: string): GraniteConfig {
  const configPath = path.join(vaultRoot, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    throw new Error(`No ${CONFIG_FILENAME} found in ${vaultRoot}. Run "granite init" first.`);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = yaml.load(raw) as GraniteConfig;
  return parsed;
}

export { CONFIG_FILENAME };
