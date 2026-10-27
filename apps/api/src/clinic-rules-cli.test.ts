import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clinicId } from '@follow-up-engine/core';
import { runClinicRulesCommand } from './clinic-rules-cli.ts';
import { createHarness, type Harness, STORAGES } from './test/harness.ts';

/** HIP-141: `clinic:rules`, per-clinic rule overrides from the command line. */

const LAB = 'lab_order_result_pending';

describe.each(STORAGES)('clinic:rules (%s)', (storage) => {
  let h: Harness;
  const run = (...argv: string[]) =>
    runClinicRulesCommand(h.runtime, ['--clinic', 'clinic-demo', ...argv], { actor: 'cli:ops' });

  beforeEach(async () => {
    h = await createHarness({ storage });
  });
  afterEach(async () => {
    await h.close();
  });

  it('lists the rules with their defaults (the default action)', async () => {
    const listed = await run('--list');
    expect(listed.code).toBe(0);
    expect(listed.output).toMatch(/^rule\s+layer\s+due in days\s+enabled\s+version\s+changed/);
    expect(listed.output).toMatch(new RegExp(`${LAB}\\s+universal\\s+15\\s+yes`));
    expect((await run()).output).toBe(listed.output);
  });

  it('sets a deadline, disables and resets a rule, each versioned and audited', async () => {
    const set = await run('--set', `${LAB}.dueInDays=10`, '--reason', 'Lab answers in a week');
    expect(set.code).toBe(0);
    expect(set.output).toMatch(
      new RegExp(`${LAB} v1 \\(set\\): \\(versioned rule\\) -> dueInDays=10`),
    );
    expect((await run('--list')).output).toMatch(/10 \(default 15\)\s+yes\s+\S+\+clinic\.1/);

    const disabled = await run('--disable', LAB, '--reason', 'Paused');
    expect(disabled.output).toMatch(/v2 \(set\): dueInDays=10 -> dueInDays=10 enabled=false/);
    const catalog = await h.runtime.engine.catalog(clinicId('clinic-demo'));
    expect(catalog.rules.map((rule) => rule.id)).not.toContain(LAB);

    const reset = await run(
      '--reset',
      LAB,
      '--reason',
      'Back to the versioned rule',
      '--actor',
      'dr-ruiz',
    );
    expect(reset.output).toMatch(/v3 \(reset\): dueInDays=10 enabled=false -> \(versioned rule\)/);
    expect(
      (await h.runtime.engine.catalog(clinicId('clinic-demo'))).rules.map((r) => r.id),
    ).toContain(LAB);

    const history = await run('--history', LAB);
    const lines = history.output.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/v3 reset .* by dr-ruiz: Back to the versioned rule$/);
    expect(lines[2]).toMatch(/v1 set .* by cli:ops: Lab answers in a week$/);
  });

  it('refuses unknown rules and fields, bad days and a missing reason, and changes nothing', async () => {
    for (const argv of [
      ['--set', 'no_such_rule.dueInDays=10', '--reason', 'x'],
      ['--set', `${LAB}.dueInDays=-5`, '--reason', 'x'],
      ['--set', `${LAB}.dueInDays=0`, '--reason', 'x'],
      ['--set', `${LAB}.priority=5`, '--reason', 'x'],
      ['--set', `${LAB}.dueInDays=10`],
      ['--disable', 'protocol_diabetes_hba1c', '--reason', 'x'],
    ]) {
      const result = await run(...argv);
      expect(result.code, argv.join(' ')).toBe(1);
      expect(result.output).toMatch(/Usage: pnpm --filter @follow-up-engine\/api clinic:rules/);
    }
    expect((await run('--history')).output).toBe('(no changes)\n');
    expect((await runClinicRulesCommand(h.runtime, ['--clinic', 'nope', '--list'])).output).toMatch(
      /Clinic nope does not exist/,
    );
  });
});
