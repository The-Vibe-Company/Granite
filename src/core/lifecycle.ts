import type { GraniteConfig, LifecycleTransition, Note } from './types.js';

export interface LifecycleSuggestion {
  slug: string;
  from: string;
  to: string;
  reason: string;
}

/**
 * Given a note and its type's lifecycle declaration, return automated transition
 * suggestions that are ready to fire (e.g. stale_days has elapsed). Never mutates.
 */
export function suggestLifecycleTransitions(
  note: Note,
  config: GraniteConfig,
  now: Date = new Date(),
): LifecycleSuggestion[] {
  const typeConfig = config.note_types[note.frontmatter.type];
  if (!typeConfig?.lifecycle) return [];

  const currentState = readCurrentState(note, typeConfig.lifecycle.states);
  if (!currentState) return [];

  const suggestions: LifecycleSuggestion[] = [];
  for (const transition of typeConfig.lifecycle.transitions) {
    if (transition.from !== currentState) continue;
    if (transition.trigger !== 'stale_days') continue;
    if (!transition.days) continue;
    const modifiedMs = Date.parse(note.frontmatter.modified);
    if (Number.isNaN(modifiedMs)) continue;
    const ageDays = (now.getTime() - modifiedMs) / (1000 * 60 * 60 * 24);
    if (ageDays >= transition.days) {
      suggestions.push({
        slug: note.slug,
        from: transition.from,
        to: transition.to,
        reason: `Untouched for ${Math.floor(ageDays)} days (threshold ${transition.days})`,
      });
    }
  }
  return suggestions;
}

function readCurrentState(note: Note, states: string[]): string | undefined {
  const candidateFields = ['status', 'lifecycle_state'];
  for (const f of candidateFields) {
    const v = note.frontmatter[f];
    if (typeof v === 'string' && states.includes(v)) return v;
  }
  return undefined;
}

export function isValidTransition(
  transitions: LifecycleTransition[],
  from: string,
  to: string,
): boolean {
  return transitions.some(t => t.from === from && t.to === to);
}
