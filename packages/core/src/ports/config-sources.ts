import type { NamedEscalationPolicy } from '../config/loader.ts';
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
  /**
   * Rules the clinic switched off (a per-clinic override): never drafted
   * again, but still known to the expectations they created before.
   */
  listRetiredRules?(clinicId: ClinicId): Promise<readonly Rule[]>;
}

/** Versioned care protocols (config/protocols), filtered like {@link RuleSource}. */
export interface ProtocolSource {
  listProtocols(clinicId: ClinicId): Promise<readonly Protocol[]>;
  getProtocol(clinicId: ClinicId, protocolId: string): Promise<Protocol | undefined>;
}

/**
 * Named, versioned escalation policies (config/rules/escalation): what a
 * clinic's `escalationPolicyId` and a case's pinned policy resolve against.
 */
export interface EscalationPolicySource {
  listPolicies(clinicId: ClinicId): Promise<readonly NamedEscalationPolicy[]>;
}
