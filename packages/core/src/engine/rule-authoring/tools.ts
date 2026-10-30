import { z } from 'zod';
import type { Protocol } from '../../config/protocol.ts';
import type { Rule } from '../../config/rule.ts';
import type { AuthoredDefinition, RuleDryRunReport } from '../../domain/authored-rule.ts';
import {
  type AuthoringToolbox,
  type AuthoringToolDefinition,
  TERMINOLOGY_SYSTEMS,
} from '../../ports/rule-authoring.ts';
import type { Catalog } from '../catalog.ts';
import { type DraftValidation, validateAuthoredDraft, type ValidationContext } from './validate.ts';

/** A draft as the agent passes it to `validate_rule`, `dry_run_rule` and `submit_draft`. */
const DraftShape = {
  kind: z
    .enum(['rule', 'protocol'])
    .describe('"rule" (a trigger) or "protocol" (a cadence for patients with a condition)'),
  definition: z
    .record(z.string(), z.unknown())
    .describe('The rule or protocol JSON, in the engine config format'),
};

export const ListExistingRulesArgs = z
  .object({
    query: z
      .string()
      .max(80)
      .nullable()
      .describe('Words or codes to filter by (an id, a test, a condition), or null for all'),
    id: z
      .string()
      .max(80)
      .nullable()
      .describe('An id from a previous listing, to get its full JSON; null otherwise'),
  })
  .strict();

export const LookupTerminologyArgs = z
  .object({
    query: z
      .string()
      .min(1)
      .max(80)
      .describe('A test, condition or drug name, in any language, or a code'),
    system: z.enum(TERMINOLOGY_SYSTEMS).nullable().describe('Restrict to one code system, or null'),
  })
  .strict();

export const DraftArgs = z.object(DraftShape).strict();

export const SubmitDraftArgs = z
  .object({
    ...DraftShape,
    labels: z
      .object({
        en: z.string().min(1).max(80).describe('Inbox reason label in English'),
        es: z.string().min(1).max(80).describe('The same label in neutral Spanish'),
      })
      .strict(),
    basedOn: z
      .string()
      .max(80)
      .nullable()
      .describe('Id of the existing rule or protocol this adapts, or null'),
    rationale: z
      .object({
        en: z
          .string()
          .min(1)
          .max(300)
          .describe(
            'One sentence for the clinician: what the draft does and how it relates to existing rules',
          ),
        es: z.string().min(1).max(300).describe('The same sentence in neutral Spanish'),
      })
      .strict(),
  })
  .strict();
export type SubmitDraft = z.infer<typeof SubmitDraftArgs>;

export const AbstainArgs = z
  .object({
    reason: z
      .string()
      .min(1)
      .max(300)
      .describe(
        'Why no draft: the request is not a follow-up rule, or cannot be built from the catalogs',
      ),
  })
  .strict();

/** Tool names, for the prompt and the scripted agent. */
export const AUTHORING_TOOLS = {
  listExistingRules: 'list_existing_rules',
  lookupTerminology: 'lookup_terminology',
  validateRule: 'validate_rule',
  dryRunRule: 'dry_run_rule',
  submitDraft: 'submit_draft',
  abstain: 'abstain',
} as const;

export const AUTHORING_TOOL_DEFINITIONS: readonly AuthoringToolDefinition[] = [
  {
    name: AUTHORING_TOOLS.listExistingRules,
    description:
      "The clinic's rules and protocols (ids, what they expect, intervals, codes, guideline sources), escalation policies and suggested action codes. Call it first, to reuse codes and not duplicate an existing rule; pass an id to get that definition's full JSON as a template.",
    parameters: ListExistingRulesArgs,
    terminal: false,
  },
  {
    name: AUTHORING_TOOLS.lookupTerminology,
    description:
      "Searches the repository's catalogs: ICD-10 categories (conditions), LOINC test groups (labs and studies; codes of one group are equivalent) and ATC drugs. Every code in a draft must come from here.",
    parameters: LookupTerminologyArgs,
    terminal: false,
  },
  {
    name: AUTHORING_TOOLS.validateRule,
    description:
      "Validates a draft with the engine's schema and checks (known codes, sane intervals, fulfillment by the expected test). Returns every issue; fix them all and validate again.",
    parameters: DraftArgs,
    terminal: false,
  },
  {
    name: AUTHORING_TOOLS.dryRunRule,
    description:
      "Runs a valid draft against the clinic's current records with the real engine (nothing is written): how many patients and expectations it would open, how many are overdue now, how many overlap with existing rules.",
    parameters: DraftArgs,
    terminal: false,
  },
  {
    name: AUTHORING_TOOLS.submitDraft,
    description:
      'Submits the draft for clinical validation (it never runs until a clinician enables it). Only a draft validate_rule accepted.',
    parameters: SubmitDraftArgs,
    terminal: true,
  },
  {
    name: AUTHORING_TOOLS.abstain,
    description:
      'Ends without a draft when the request is not a follow-up rule (a message to a patient, a diagnosis, anything else) or needs codes the catalogs do not have.',
    parameters: AbstainArgs,
    terminal: true,
  },
];

function short(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function ruleSummary(rule: Rule): Record<string, unknown> {
  return {
    id: rule.id,
    type: 'rule',
    layer: rule.layer,
    description: short(rule.description, 220),
    trigger: rule.trigger,
    dueInDays: rule.dueInDays,
    expects: rule.expects ?? null,
  };
}

function protocolSummary(protocol: Protocol): Record<string, unknown> {
  return {
    id: protocol.id,
    type: 'protocol',
    status: protocol.status,
    description: short(protocol.description, 220),
    conditionCodes: protocol.enrollment.conditionCodes,
    activeTreatment: protocol.enrollment.activeTreatment ?? null,
    items: protocol.items.map((item) => ({
      key: item.key,
      kind: item.kind,
      code: item.code?.code ?? null,
      everyDays:
        item.everyDays ?? (item.schedule?.type === 'interval' ? item.schedule.everyDays : null),
      schedule: item.schedule?.type ?? 'interval',
    })),
    sources: protocol.sources,
  };
}

function matches(value: unknown, query: string): boolean {
  return JSON.stringify(value).toLowerCase().includes(query.toLowerCase());
}

/** The JSON a draft's dry run returns to the model: counts and pseudonymous examples only. */
export function dryRunForModel(report: RuleDryRunReport): Record<string, unknown> {
  return {
    patientsScanned: report.patientsScanned,
    truncated: report.truncated,
    patientsMatched: report.patientsMatched,
    expectations: report.expectations,
    overlaps: report.overlaps,
    examples: report.examples,
  };
}

export interface AuthoringToolboxDeps {
  readonly catalog: Catalog;
  readonly validation: ValidationContext;
  /** The clinic's own authored rules (drafts included), as summaries. */
  readonly authored: readonly {
    readonly id: string;
    readonly status: string;
    readonly request: string;
  }[];
  readonly dryRun: (definition: AuthoredDefinition) => Promise<RuleDryRunReport>;
  /** Every validation the agent asked for, in order (the service records whether the first passed). */
  readonly onValidation?: (validation: DraftValidation) => void;
}

/**
 * The authoring agent's tools over one clinic. Read only: the dry run
 * replays the clinic's records in a transaction that is always rolled
 * back, and returns counts and pseudonymous handles, never a name or a
 * host id.
 */
export function createAuthoringToolbox(deps: AuthoringToolboxDeps): AuthoringToolbox {
  const policies = [
    ...new Set(
      deps.catalog
        .definitions()
        .flatMap((definition) =>
          definition.escalationPolicy.id === undefined ? [] : [definition.escalationPolicy.id],
        ),
    ),
  ].sort();
  const actions = [
    ...new Set(deps.catalog.definitions().map((definition) => definition.suggestedAction.code)),
  ].sort();

  function validate(args: z.infer<typeof DraftArgs>): DraftValidation {
    const validation = validateAuthoredDraft(args, deps.validation);
    deps.onValidation?.(validation);
    return validation;
  }

  return {
    definitions: AUTHORING_TOOL_DEFINITIONS,
    checkSubmission(rawArgs) {
      const parsed = SubmitDraftArgs.safeParse(rawArgs);
      if (!parsed.success) return { ok: false, error: 'invalid submit_draft arguments' };
      const validation = validateAuthoredDraft(parsed.data, deps.validation);
      return validation.ok
        ? { ok: true, result: { valid: true }, summary: 'valid' }
        : {
            ok: false,
            error: `the engine refused this draft: ${validation.issues.join('; ')}. Fix every issue and submit_draft the whole definition again`,
          };
    },
    async execute(name, rawArgs) {
      switch (name) {
        case AUTHORING_TOOLS.listExistingRules: {
          const args = ListExistingRulesArgs.parse(rawArgs);
          if (args.id !== null) {
            const rule = deps.catalog.rules.find((item) => item.id === args.id);
            const protocol = deps.catalog.protocols.find((item) => item.id === args.id);
            const found = rule ?? protocol;
            if (found === undefined) {
              return {
                ok: false,
                error: `no rule or protocol "${args.id}": call with id null to list them all`,
              };
            }
            return { ok: true, result: found, summary: `full JSON of ${args.id}` };
          }
          const query = args.query?.trim() ?? '';
          const rules = deps.catalog.rules.map(ruleSummary);
          const protocols = deps.catalog.protocols.map(protocolSummary);
          const all = [...rules, ...protocols].filter(
            (item) => query === '' || matches(item, query),
          );
          return {
            ok: true,
            result: {
              definitions: all,
              clinicAuthored: deps.authored,
              escalationPolicies: policies,
              suggestedActions: actions,
            },
            summary: `${String(all.length)} rules and protocols`,
          };
        }
        case AUTHORING_TOOLS.lookupTerminology: {
          const args = LookupTerminologyArgs.parse(rawArgs);
          const entries = deps.validation.terminology.search(args.query, {
            ...(args.system === null ? {} : { system: args.system }),
            limit: 8,
          });
          return {
            ok: true,
            result: { query: args.query, entries },
            summary:
              entries.length === 0
                ? 'no match'
                : entries
                    .slice(0, 4)
                    .map((entry) => `${entry.system}:${entry.code}`)
                    .join(', '),
          };
        }
        case AUTHORING_TOOLS.validateRule: {
          const validation = validate(DraftArgs.parse(rawArgs));
          return {
            ok: true,
            result: {
              valid: validation.ok,
              issues: validation.issues,
              codes: validation.terminology,
            },
            summary: validation.ok ? 'valid' : `${String(validation.issues.length)} issues`,
          };
        }
        case AUTHORING_TOOLS.dryRunRule: {
          const validation = validateAuthoredDraft(DraftArgs.parse(rawArgs), deps.validation);
          if (!validation.ok || validation.definition === undefined) {
            return {
              ok: true,
              result: { error: 'invalid draft: validate_rule it first', issues: validation.issues },
              summary: 'invalid draft',
            };
          }
          const report = await deps.dryRun(validation.definition);
          return {
            ok: true,
            result: dryRunForModel(report),
            summary: `${String(report.patientsMatched)} patients, ${String(report.expectations.overdue)} overdue, ${String(report.overlaps.expectations)} overlaps`,
          };
        }
        default:
          return { ok: false, error: `unknown tool ${name}` };
      }
    },
  };
}
