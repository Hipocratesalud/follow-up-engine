import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyRuleOverrides,
  type ClinicId,
  loadEscalationPoliciesFromJson,
  loadProtocolsFromJson,
  loadRulesFromJson,
  type EscalationPolicySource,
  type NamedEscalationPolicy,
  type Protocol,
  type ProtocolSource,
  type Rule,
  type RuleOverride,
  type RuleSource,
} from '@follow-up-engine/core';

/** The repository's `config/` directory (versioned rules and protocols). */
export const DEFAULT_CONFIG_DIR = fileURLToPath(new URL('../../../config', import.meta.url));

export interface SourceOptions {
  /**
   * Clinics the configuration is enabled for (validated by the clinical
   * team). All clinics when absent, which is only right for tests and demos.
   */
  readonly enabledClinics?: readonly ClinicId[];
}

export interface RuleSourceOptions extends SourceOptions {
  /** Per-clinic overrides, for example `{ 'clinic-a': { lab_order_result_pending: { dueInDays: 10 } } }`. */
  readonly overrides?: Readonly<Record<string, Readonly<Record<string, RuleOverride>>>>;
}

function enabled(options: SourceOptions, clinicId: ClinicId): boolean {
  return options.enabledClinics === undefined || options.enabledClinics.includes(clinicId);
}

/** {@link RuleSource} over rules already loaded (from files or built in a test). */
export class StaticRuleSource implements RuleSource {
  readonly #rules: readonly Rule[];
  readonly #options: RuleSourceOptions;

  constructor(rules: readonly Rule[], options: RuleSourceOptions = {}) {
    this.#rules = rules;
    this.#options = options;
  }

  listRules(clinicId: ClinicId): Promise<readonly Rule[]> {
    if (!enabled(this.#options, clinicId)) {
      return Promise.resolve([]);
    }
    return Promise.resolve(
      applyRuleOverrides(this.#rules, this.#options.overrides?.[clinicId] ?? {}),
    );
  }

  async getRule(clinicId: ClinicId, ruleId: string): Promise<Rule | undefined> {
    return (await this.listRules(clinicId)).find((rule) => rule.id === ruleId);
  }
}

/** {@link ProtocolSource} over protocols already loaded. */
export class StaticProtocolSource implements ProtocolSource {
  readonly #protocols: readonly Protocol[];
  readonly #options: SourceOptions;

  constructor(protocols: readonly Protocol[], options: SourceOptions = {}) {
    this.#protocols = protocols;
    this.#options = options;
  }

  listProtocols(clinicId: ClinicId): Promise<readonly Protocol[]> {
    return Promise.resolve(enabled(this.#options, clinicId) ? this.#protocols : []);
  }

  async getProtocol(clinicId: ClinicId, protocolId: string): Promise<Protocol | undefined> {
    return (await this.listProtocols(clinicId)).find((protocol) => protocol.id === protocolId);
  }
}

function readJsonFiles(directory: string): {
  readonly names: string[];
  readonly documents: unknown[];
} {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(directory, name))
    .filter((path) => statSync(path).isFile());
  return {
    names,
    documents: names.map((path) => JSON.parse(readFileSync(path, 'utf8')) as unknown),
  };
}

/** Everything under a config directory, validated. */
export interface LoadedConfig {
  readonly rules: readonly Rule[];
  readonly protocols: readonly Protocol[];
  readonly escalationPolicies: readonly NamedEscalationPolicy[];
}

/**
 * Reads and validates `<dir>/rules/*.json`, `<dir>/rules/escalation/*.json`
 * and `<dir>/protocols/*.json`. Throws `ConfigValidationError` listing every
 * problem, with file names.
 */
export function loadConfigDirectory(configDir: string = DEFAULT_CONFIG_DIR): LoadedConfig {
  const policyFiles = readJsonFiles(join(configDir, 'rules', 'escalation'));
  const escalationPolicies = loadEscalationPoliciesFromJson(policyFiles.documents, {
    documentNames: policyFiles.names,
  });
  const ruleFiles = readJsonFiles(join(configDir, 'rules'));
  const protocolFiles = readJsonFiles(join(configDir, 'protocols'));
  return {
    escalationPolicies,
    rules: loadRulesFromJson(ruleFiles.documents, {
      documentNames: ruleFiles.names,
      escalationPolicies,
    }),
    protocols: loadProtocolsFromJson(protocolFiles.documents, {
      documentNames: protocolFiles.names,
      escalationPolicies,
    }),
  };
}

/** {@link RuleSource} reading `config/rules` once, at construction. */
export class FileRuleSource extends StaticRuleSource {
  constructor(configDir: string = DEFAULT_CONFIG_DIR, options: RuleSourceOptions = {}) {
    super(loadConfigDirectory(configDir).rules, options);
  }
}

/** {@link ProtocolSource} reading `config/protocols` once, at construction. */
export class FileProtocolSource extends StaticProtocolSource {
  constructor(configDir: string = DEFAULT_CONFIG_DIR, options: SourceOptions = {}) {
    super(loadConfigDirectory(configDir).protocols, options);
  }
}

/** {@link EscalationPolicySource} over named policies already loaded (the same for every clinic). */
export class StaticEscalationPolicySource implements EscalationPolicySource {
  readonly #policies: readonly NamedEscalationPolicy[];

  constructor(policies: readonly NamedEscalationPolicy[]) {
    this.#policies = policies;
  }

  listPolicies(): Promise<readonly NamedEscalationPolicy[]> {
    return Promise.resolve(this.#policies);
  }
}

/** {@link EscalationPolicySource} reading `config/rules/escalation` once, at construction. */
export class FileEscalationPolicySource extends StaticEscalationPolicySource {
  constructor(configDir: string = DEFAULT_CONFIG_DIR) {
    super(loadConfigDirectory(configDir).escalationPolicies);
  }
}
