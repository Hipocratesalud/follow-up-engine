import type { Protocol } from '../config/protocol.ts';
import type { Rule } from '../config/rule.ts';
import type { ClinicId } from '../domain/ids.ts';

/**
 * Versioned rules (config/rules). Returns only the rules enabled for the
 * clinic: nothing is enabled without clinical team validation.
 */
export interface RuleSource {
  listRules(clinicId: ClinicId): Promise<readonly Rule[]>;
  getRule(clinicId: ClinicId, ruleId: string): Promise<Rule | undefined>;
}

/** Versioned care protocols (config/protocols), filtered like {@link RuleSource}. */
export interface ProtocolSource {
  listProtocols(clinicId: ClinicId): Promise<readonly Protocol[]>;
  getProtocol(clinicId: ClinicId, protocolId: string): Promise<Protocol | undefined>;
}
