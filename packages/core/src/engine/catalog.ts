import type {
  EscalationPolicy,
  EventCorrelation,
  EventMatcher,
  SuggestedAction,
} from '../config/common.ts';
import type { Protocol, ProtocolItem } from '../config/protocol.ts';
import type { Rule } from '../config/rule.ts';
import type { PlanItemKind } from '../domain/clinical-event.ts';
import type { Reason } from '../domain/common.ts';
import type { ExpectationLayer } from '../domain/expectation.ts';
import type { Coding } from '../domain/resource.ts';

/**
 * Everything the engine needs to know about where an expectation came from,
 * whether a rule or a protocol item. Rules and protocol items are normalized
 * into this one shape so the watcher, fulfillment and escalation code never
 * branch on the layer.
 */
export interface ExpectationDefinition {
  /** Rule id, or `protocol_<protocolId>_<itemKey>` for protocol items. */
  readonly ruleId: string;
  readonly version: string;
  readonly layer: ExpectationLayer;
  readonly reason: Reason;
  /** What the definition asks for; `undefined` for doctor's plan rules (the plan item decides). */
  readonly expects?: PlanItemKind;
  /** Test code a protocol item asks for. */
  readonly code?: Coding;
  readonly caseGroup: string;
  readonly fulfilledBy: readonly EventCorrelation[];
  readonly supersededBy: readonly EventCorrelation[];
  readonly notFulfilledBy: readonly EventMatcher[];
  readonly priority: number;
  readonly escalationPolicy: EscalationPolicy;
  readonly suggestedAction: SuggestedAction;
  readonly protocol?: { readonly id: string; readonly version: string; readonly itemKey: string };
}

/** Rule id of a protocol item, for example `protocol_diabetes_hba1c`. */
export function protocolRuleId(
  protocol: Pick<Protocol, 'id'>,
  item: Pick<ProtocolItem, 'key'>,
): string {
  return `protocol_${protocol.id}_${item.key}`;
}

function defaultExpects(rule: Rule): PlanItemKind | undefined {
  if (rule.expects !== undefined) {
    return rule.expects;
  }
  if (rule.layer === 'doctor_plan') {
    return undefined;
  }
  const category = rule.trigger.filter?.['category'];
  if (category === 'laboratory') {
    return 'lab';
  }
  return category === 'imaging' ? 'imaging' : 'follow_up_visit';
}

function fromRule(rule: Rule): ExpectationDefinition {
  const expects = defaultExpects(rule);
  return {
    ruleId: rule.id,
    version: rule.version,
    layer: rule.layer,
    reason: rule.reason,
    ...(expects === undefined ? {} : { expects }),
    caseGroup: rule.caseGroup ?? rule.reason.code,
    fulfilledBy: rule.fulfilledBy,
    supersededBy: rule.supersededBy ?? [],
    notFulfilledBy: rule.notFulfilledBy ?? [],
    priority: rule.priority,
    escalationPolicy: rule.escalationPolicy,
    suggestedAction: rule.suggestedAction,
  };
}

function fromProtocolItem(protocol: Protocol, item: ProtocolItem): ExpectationDefinition {
  return {
    ruleId: protocolRuleId(protocol, item),
    version: protocol.version,
    layer: 'protocol',
    reason: item.reason,
    expects: item.kind,
    ...(item.code === undefined
      ? {}
      : {
          code: {
            system: item.code.system,
            code: item.code.code,
            ...(item.code.display === undefined ? {} : { display: item.code.display }),
          },
        }),
    caseGroup: protocol.caseGroup ?? protocol.reason.code,
    fulfilledBy: item.fulfilledBy,
    supersededBy: [],
    notFulfilledBy: [],
    priority: item.priority,
    escalationPolicy: protocol.escalationPolicy,
    suggestedAction: item.suggestedAction,
    protocol: { id: protocol.id, version: protocol.version, itemKey: item.key },
  };
}

/**
 * The rules and protocols enabled for one clinic, indexed for the engine.
 * Built once per operation from the `RuleSource` and `ProtocolSource`.
 */
export class Catalog {
  readonly rules: readonly Rule[];
  readonly protocols: readonly Protocol[];
  readonly #definitions: ReadonlyMap<string, ExpectationDefinition>;

  constructor(rules: readonly Rule[], protocols: readonly Protocol[]) {
    this.rules = rules;
    this.protocols = protocols;
    const definitions = new Map<string, ExpectationDefinition>();
    for (const rule of rules) {
      definitions.set(rule.id, fromRule(rule));
    }
    for (const protocol of protocols) {
      for (const item of protocol.items) {
        const definition = fromProtocolItem(protocol, item);
        definitions.set(definition.ruleId, definition);
      }
    }
    this.#definitions = definitions;
  }

  /** The definition behind an expectation's `ruleId`, if still enabled for the clinic. */
  definition(ruleId: string): ExpectationDefinition | undefined {
    return this.#definitions.get(ruleId);
  }

  rulesOfLayer(layer: Rule['layer']): readonly Rule[] {
    return this.rules.filter((rule) => rule.layer === layer);
  }

  /** Every definition, rules first. */
  definitions(): readonly ExpectationDefinition[] {
    return [...this.#definitions.values()];
  }
}
