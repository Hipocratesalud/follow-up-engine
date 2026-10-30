import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from './en.ts';
import { es } from './es.ts';

/*
 * Every evaluator event type the API records (EVALUATOR_ACTIONS in
 * packages/runtime/src/evaluator-events.ts) has a label in English and in
 * Spanish on the Evaluators page. The inbox only talks HTTP to the engine
 * (it never imports a workspace package), so the list is read from the
 * runtime's source file instead of imported.
 */
const RELATIVE_SOURCE = join('packages', 'runtime', 'src', 'evaluator-events.ts');

/** The runtime's source file, from wherever the tests run (repo root or apps/inbox). */
function sourcePath(): string {
  let directory = process.cwd();
  for (;;) {
    const candidate = join(directory, RELATIVE_SOURCE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`${RELATIVE_SOURCE} not found`);
    directory = parent;
  }
}

function evaluatorActions(): string[] {
  const source = readFileSync(sourcePath(), 'utf8');
  const list = /export const EVALUATOR_ACTIONS = \[([\s\S]*?)\] as const;/.exec(source)?.[1];
  if (list === undefined) throw new Error('EVALUATOR_ACTIONS not found in the runtime source');
  return [...list.matchAll(/^\s*'([a-z_]+)',/gm)].map((match) => match[1] ?? '');
}

describe('evaluator event labels', () => {
  const actions = evaluatorActions();

  it('reads the full list of event types', () => {
    expect(actions.length).toBeGreaterThan(20);
    expect(actions).toContain('login');
    expect(actions).toContain('page_viewed');
  });

  it.each([
    ['en', en],
    ['es', es],
  ] as const)('labels every event type in %s', (_locale, messages) => {
    const missing = actions.filter((action) => !(messages.evaluators.action[action] ?? '').trim());
    expect(missing).toEqual([]);
  });

  it('never shows an English label in Spanish', () => {
    const same = actions.filter(
      (action) => en.evaluators.action[action] === es.evaluators.action[action],
    );
    expect(same).toEqual([]);
  });
});
