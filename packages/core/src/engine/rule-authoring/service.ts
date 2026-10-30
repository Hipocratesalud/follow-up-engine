import type { AuthoringProvenance, AuthoringStep } from '../../domain/authored-rule.ts';
import { ValidationError } from '../../domain/errors.ts';
import type { ClinicId } from '../../domain/ids.ts';
import type { Clock } from '../../ports/clock.ts';
import {
  type AuthoringLimits,
  type AuthoringStopReason,
  DEFAULT_AUTHORING_LIMITS,
  type RuleAuthoringAgent,
  type RuleTerminology,
} from '../../ports/rule-authoring.ts';
import type { Catalog } from '../catalog.ts';
import type { AuthoredRuleCommands, AuthoredRuleView } from './commands.ts';
import { createAuthoringToolbox, SubmitDraftArgs } from './tools.ts';
import { type DraftValidation, validateAuthoredDraft, type ValidationContext } from './validate.ts';

/** Longest clinician request the agent reads. */
export const MAX_AUTHORING_REQUEST_LENGTH = 500;

export type AuthoringMode = 'scripted' | 'live';

export interface RuleAuthoringInput {
  /** The clinician's words, any language. */
  readonly request: string;
  /** `scripted`: the deterministic stand-in, never spends. `live`: the configured model. */
  readonly mode: AuthoringMode;
  /** Who asked (kept with the draft). */
  readonly actor: string;
  /** The clinic's own "today" (a lab clinic has its own clock). */
  readonly now?: Date;
}

/** What one authoring run cost and did, whatever came of it. */
export interface AuthoringRunSummary {
  readonly stopReason: AuthoringStopReason;
  readonly steps: number;
  readonly toolCalls: number;
  readonly trace: readonly AuthoringStep[];
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelId: string;
  readonly promptVersion: string;
}

export type RuleAuthoringOutcome =
  | {
      readonly status: 'drafted';
      readonly rule: AuthoredRuleView;
      readonly run: AuthoringRunSummary;
    }
  | {
      readonly status: 'failed';
      /**
       * `no_submission`: the agent stopped before submitting. `abstained`:
       * it declined the request. `invalid_submission`: code refused it.
       */
      readonly reason: 'no_submission' | 'abstained' | 'invalid_submission';
      readonly issues: readonly string[];
      readonly run: AuthoringRunSummary;
    };

export interface RuleAuthoringService {
  /**
   * Runs the agent on the clinician's request and stores what it submitted
   * as a draft, after code re-validated it and ran its dry run (the agent's
   * own claims are never stored as facts). The draft never runs until a
   * clinician enables it (`AuthoredRuleCommands.enable`).
   */
  draft(clinicId: ClinicId, input: RuleAuthoringInput): Promise<RuleAuthoringOutcome>;
}

export interface RuleAuthoringDeps {
  readonly catalog: (clinicId: ClinicId) => Promise<Catalog>;
  readonly authoredRules: AuthoredRuleCommands;
  readonly agents: { readonly live: RuleAuthoringAgent; readonly scripted: RuleAuthoringAgent };
  readonly terminology: RuleTerminology;
  readonly clock: Clock;
  readonly limits?: AuthoringLimits;
}

export function createRuleAuthoring(deps: RuleAuthoringDeps): RuleAuthoringService {
  return {
    async draft(clinicId, input) {
      const request = input.request.trim();
      if (request === '' || request.length > MAX_AUTHORING_REQUEST_LENGTH) {
        throw new ValidationError(
          'request',
          `Describe the rule in 1 to ${String(MAX_AUTHORING_REQUEST_LENGTH)} characters`,
        );
      }
      const now = input.now ?? deps.clock.now();
      const [catalog, authored] = await Promise.all([
        deps.catalog(clinicId),
        deps.authoredRules.list(clinicId),
      ]);
      const validation: ValidationContext = {
        terminology: deps.terminology,
        catalog,
        authoredIds: new Set(authored.map((rule) => rule.ruleId)),
        knownSources: catalog.protocols.flatMap((protocol) => protocol.sources),
        now,
      };
      const validations: DraftValidation[] = [];
      const toolbox = createAuthoringToolbox({
        catalog,
        validation,
        authored: authored.map((rule) => ({
          id: rule.ruleId,
          status: rule.live ? 'enabled' : rule.authored.status,
          request: rule.authored.request.slice(0, 160),
        })),
        dryRun: (definition) => deps.authoredRules.dryRun(clinicId, definition, { now }),
        onValidation: (result) => validations.push(result),
      });
      const agent = input.mode === 'live' ? deps.agents.live : deps.agents.scripted;
      const result = await agent.author(clinicId, {
        request,
        toolbox,
        limits: deps.limits ?? DEFAULT_AUTHORING_LIMITS,
      });
      const run: AuthoringRunSummary = {
        stopReason: result.stopReason,
        steps: result.steps,
        toolCalls: result.toolCalls,
        trace: result.trace,
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        modelId: result.modelId,
        promptVersion: result.promptVersion,
      };
      if (result.stopReason === 'abstained') {
        return {
          status: 'failed',
          reason: 'abstained',
          issues: result.abstention === undefined ? [] : [result.abstention],
          run,
        };
      }
      if (result.submission === undefined) {
        return { status: 'failed', reason: 'no_submission', issues: [], run };
      }
      const submission = SubmitDraftArgs.safeParse(result.submission);
      if (!submission.success) {
        return {
          status: 'failed',
          reason: 'invalid_submission',
          issues: submission.error.issues.map(
            (issue) => `${issue.path.join('.')}: ${issue.message}`,
          ),
          run,
        };
      }
      // Code decides: the submitted draft is validated again, whatever the agent saw.
      const checked = validateAuthoredDraft(submission.data, validation);
      if (!checked.ok || checked.definition === undefined) {
        return { status: 'failed', reason: 'invalid_submission', issues: checked.issues, run };
      }
      const dryRun = await deps.authoredRules.dryRun(clinicId, checked.definition, { now });
      const provenance: AuthoringProvenance = {
        mode: input.mode,
        modelId: result.modelId,
        promptVersion: result.promptVersion,
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        steps: result.steps,
        trace: result.trace,
        firstValidationPassed: (validations[0] ?? checked).ok,
        dryRun,
        terminology: checked.terminology,
        ...(submission.data.basedOn === null ? {} : { basedOn: submission.data.basedOn }),
        rationale: submission.data.rationale,
        draftedBy: input.actor,
        draftedAt: deps.clock.now().toISOString(),
      };
      const saved = await deps.authoredRules.saveDraft(
        clinicId,
        {
          definition: checked.definition,
          request,
          labels: submission.data.labels,
          provenance,
        },
        { actor: input.actor, reason: `Draft by the rule-authoring agent (${input.mode})` },
      );
      if (saved.rule === undefined) {
        throw new Error('unreachable: a saved draft is readable in the same transaction');
      }
      return { status: 'drafted', rule: saved.rule, run };
    },
  };
}
