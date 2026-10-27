import { describe, expect, it } from 'vitest';
import type { Rule } from '../../config/rule.ts';
import { type ClinicId, clinicId } from '../../domain/ids.ts';
import type { RuleOverrideRecord } from '../../domain/rule-override.ts';
import type { RuleSource } from '../../ports/config-sources.ts';
import type { RuleOverrideStore } from '../../ports/rule-override-store.ts';
import { OverridingRuleSource } from './overrides.ts';

const CLINIC = clinicId('clinic-a');
const OTHER = clinicId('clinic-b');

function rule(id: string, dueInDays: number): Rule {
  return { id, version: '1.2.0', dueInDays } as Rule;
}

const BASE: readonly Rule[] = [rule('lab', 15), rule('imaging', 30)];

class Base implements RuleSource {
  listRules(): Promise<readonly Rule[]> {
    return Promise.resolve(BASE);
  }
  async getRule(_clinic: ClinicId, ruleId: string): Promise<Rule | undefined> {
    return (await this.listRules()).find((candidate) => candidate.id === ruleId);
  }
}

/** The reads of a store, with a counter of how often the overrides were listed. */
class Reads implements Pick<RuleOverrideStore, 'list' | 'revision'> {
  records: RuleOverrideRecord[] = [];
  changes = 0;
  lists = 0;

  set(record: Omit<RuleOverrideRecord, 'updatedAt' | 'updatedBy' | 'reason'>): void {
    this.records = [
      ...this.records.filter((current) => current.ruleId !== record.ruleId),
      { ...record, updatedAt: new Date(0), updatedBy: 'ops', reason: 'x' },
    ];
    this.changes += 1;
  }

  list(clinic: ClinicId): Promise<readonly RuleOverrideRecord[]> {
    this.lists += 1;
    return Promise.resolve(this.records.filter((record) => record.clinicId === clinic));
  }

  revision(clinic: ClinicId): Promise<number> {
    return Promise.resolve(clinic === CLINIC ? this.changes : 0);
  }
}

describe('OverridingRuleSource', () => {
  it('applies a clinic override and stamps the version; other clinics keep the rule', async () => {
    const reads = new Reads();
    reads.set({ clinicId: CLINIC, ruleId: 'lab', override: { dueInDays: 10 }, version: 3 });
    const source = new OverridingRuleSource(new Base(), reads);
    expect(await source.getRule(CLINIC, 'lab')).toMatchObject({
      dueInDays: 10,
      version: '1.2.0+clinic.3',
    });
    expect(await source.getRule(OTHER, 'lab')).toMatchObject({ dueInDays: 15, version: '1.2.0' });
  });

  it('retires a disabled rule: not listed, still known to what it created', async () => {
    const reads = new Reads();
    reads.set({ clinicId: CLINIC, ruleId: 'imaging', override: { enabled: false }, version: 1 });
    const source = new OverridingRuleSource(new Base(), reads);
    expect((await source.listRules(CLINIC)).map((candidate) => candidate.id)).toEqual(['lab']);
    expect((await source.listRetiredRules(CLINIC)).map((candidate) => candidate.id)).toEqual([
      'imaging',
    ]);
  });

  it('caches per clinic and reloads when the revision moves (another process changed it)', async () => {
    const reads = new Reads();
    const source = new OverridingRuleSource(new Base(), reads);
    await source.listRules(CLINIC);
    await source.listRules(CLINIC);
    expect(reads.lists).toBe(1);
    reads.set({ clinicId: CLINIC, ruleId: 'lab', override: { dueInDays: 7 }, version: 1 });
    expect((await source.getRule(CLINIC, 'lab'))?.dueInDays).toBe(7);
    expect(reads.lists).toBe(2);
    source.invalidate(CLINIC);
    await source.listRules(CLINIC);
    expect(reads.lists).toBe(3);
  });
});
