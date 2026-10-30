# Rule-authoring agent

A clinician writes a follow-up rule in plain words, in any language:

- "Para mis pacientes con hipotiroidismo en levotiroxina, TSH cada 6 meses"
- "After a positive FIT, colonoscopy within 60 days"
- "If HbA1c comes back above 9%, a control visit within 30 days"

A tool-using agent on Muse Spark (through `llm_gateway`) turns it into **one draft in the engine's own configuration format**: a rule (`config/rules`, `RuleSchema`) or a protocol (`config/protocols`, `ProtocolSchema`). Code validates the draft and dry-runs it with the real engine over the clinic's records. The draft is stored per clinic and **never runs until a clinician enables it** (PRD V1, workstream C; `CLAUDE.md`: nothing is enabled for a clinic without clinical team validation).

The model never writes a date or computes an interval: it picks structured fields (an event type, codes, `dueInDays`, `everyDays`); the engine computes every due date.

## Flow

```
clinician's words
  └─ agent loop (packages/llm/src/rule-authoring/agent.ts), one tool call per step
       list_existing_rules ─ the clinic's catalog: rules, protocols (with their guideline sources),
                             escalation policies, suggested actions; one definition's full JSON by id
       lookup_terminology  ─ the repository's catalogs only (see below)
       validate_rule       ─ zod schema + engine checks; every issue back to the model
       dry_run_rule        ─ the real engine over the clinic's records, rolled back
       submit_draft        ─ checked again before the run ends on it; refused → issues back, one step
       abstain             ─ not a follow-up rule (or no codes for it): no draft
  └─ service (packages/core/src/engine/rule-authoring/service.ts)
       validates the submission again and runs its own dry run (the agent's claims are never stored)
  └─ AuthoredRuleCommands.saveDraft → rule override with `authored.status = draft`
  └─ clinician: "Enable for this clinic" (validatedBy, validatedAt) or "Discard"
```

Bounds: 12 model calls, 10 tool calls, 120k tokens per run (`DEFAULT_AUTHORING_LIMITS`). Every step is traced (tool, sanitized arguments: ids, codes, short strings; outcome; model; cost) and stored with the draft.

## Validation is code

`validateAuthoredDraft` (`packages/core/src/engine/rule-authoring/validate.ts`):

- the engine's zod schema (`RuleSchema` / `ProtocolSchema`), escalation policy references resolved by id;
- an id starting with `clinic_` that no versioned rule or protocol has; `reason.code` conventions;
- **every code known to the catalogs**: ICD-10 categories, LOINC tests, ATC drugs or classes, the engine's own procedure codes; an invented code is an issue naming it;
- intervals in a sane range (1 to 1,095 days; protocol items at least every 7 days);
- filters only on fields the engine fills (`code.code`, `interpretation`, `value.value`, `category`, `specialty`, ...), with their fixed vocabularies;
- fulfillment by the test the rule expects (same test group), a visit by `encounter.finished`/`appointment.booked`;
- suggested action codes and escalation policies that exist; protocol sources only ones the repository already cites (or, when none, a fixed "clinic-authored criterion" source pointing at this page: no URL is ever invented).

A clinic rule is a `universal` rule or a draft protocol with interval items; doctor's-plan and cadence rules stay engine internals.

## Terminology

`createRepositoryTerminology` (`packages/llm/src/rule-authoring/terminology.ts`) reads only what the repository already has: the note extractor's ICD-10 condition terms (Spanish and English), the engine's test lexicon (`TEST_GROUPS`, codes of one group are equivalent; this feature added the FIT and colonoscopy groups) and the engine's ATC medication name table. Search is by code, whole term, or shared words.

## Dry run

`dryRunAuthoredDefinition` (`packages/core/src/engine/rule-authoring/dry-run.ts`) replays every patient's stored events (up to 500 patients) step by step "as of" their own time through the same annotator as live ingestion (the reconciliation's replay), with the draft added to the clinic's catalog, inside a transaction that is always rolled back. It reports patients matched, the draft's expectations (overdue now, on schedule, already fulfilled), live expectations of existing rules that ask for the same thing (overlap, by rule), and a few pseudonymous examples (`P-3f2a9c`, a hash of clinic and patient ids). No model call: plans read from notes are stored events.

The dry run sees what the engine would really do. Example: a patient whose existing hypothyroidism protocol already asks for a TSH sooner gets no expectation from the 6-month draft (protocols cover the same test once, the earliest wins), and the dry run says so.

## Storage: the per-clinic override mechanism

A clinic-authored rule lives in the clinic's rule overrides (`RuleOverride.authored`, memory and Postgres stores, migration `0022_clinic_authored_rules.sql`), so every change is versioned and audited like `PUT /api/admin/rules` (who, when, old → new, why; `GET /api/admin/rules/history`). `OverridingRuleSource` adds an **enabled** authored rule to the clinic's rules (version `1.0.0+clinic.N`) and an enabled authored protocol to its protocols; a draft is invisible to the engine. "Discard" removes a draft (the history keeps it) or switches an enabled rule off (its existing expectations still close under it). Enabling applies to records ingested from then on; existing records are not re-annotated (a rule change is never retroactive, as with every override).

## API

| Route                                                        | Who                                                                  |
| ------------------------------------------------------------ | -------------------------------------------------------------------- |
| `GET/POST /api/admin/rules/authored`                         | a real clinic, scope `admin:rules`, clinician from `X-FollowUp-User` |
| `POST /api/admin/rules/authored/{ruleId}/enable`, `/discard` | same                                                                 |
| `GET /api/demo/lab/rules`                                    | the evaluator's lab sandbox (fake clock only)                        |
| `POST /api/demo/lab/rules/drafts` `{ request, mode }`        | `mode`: `scripted` (never spends) or `live` (the configured model)   |
| `POST /api/demo/lab/rules/{ruleId}/enable`, `/discard`       | the evaluator is recorded as `validatedBy`                           |
| `POST /api/demo/lab/rules/samples`                           | nine synthetic patients (idempotent) so the dry runs count something |

## Inbox

**Rules** (`/rules`, in the lab's navigation): a text box, three example prompts, the agent mode, then a card with the rule in sentences (written by code from the structured fields, in the UI language), the dry-run numbers and examples, the codes and sources it cites, the JSON (a diff against the rule it adapts, or every line added), the agent's trace (`AgentTraceTimeline`), and **Enable for this clinic** / **Discard**. A declined or refused draft shows why, with its trace.

## Scripted and live

- **Scripted** (`scriptedRuleAuthorResponder`): a deterministic stand-in on the fake provider, through the real loop, validator and dry run. It knows the three example requests (English or Spanish) and abstains on anything else. Used by tests, CI and the sandbox without a key.
- **Live**: the configured provider (`muse-spark-1.3` with `META_API_KEY`), task `rule_authoring`, 8,000 output tokens per step (Muse Spark bills reasoning as output).

### Live results (2026-10-30, Muse Spark 1.3, the three examples)

| Run | What happened                                                                                                                                                              | Valid drafts | Cost   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------ |
| 1   | The model wrote `{"id": "null"}`; the tool read it as an id and the model looped on `list_existing_rules`, then submitted invented LOINC codes: **code refused them**.     | 1 of 3       | $0.088 |
| 2   | Fixed (`"null"` strings read as null). One submission dropped `trigger` after a valid `validate_rule`: refused at the end of the run.                                      | 2 of 3       | $0.083 |
| 3   | Fixed (a refused `submit_draft` goes back to the agent with the issues; token-based terminology search ranks the FIT group first). Each draft passed its first validation. | 3 of 3       | $0.085 |

About $0.03 and 15 to 35 seconds per draft, 50k to 70k input tokens. Both failures were caught by code, never stored.

## Tests

- `packages/acceptance/test/rule-authoring.test.ts`: the three examples drafted valid on the first validation; validation rejects invented ICD-10/LOINC/ATC codes, insane intervals, unknown fields, fulfillment by another test, an existing id; the dry run on a seeded clinic (exact counts, pseudonymous handles, overlap with the hypothyroidism protocol, nothing written); a draft never runs until enabled (`validatedBy` kept, not retroactive, switched off stops new ones and keeps closing old ones); tenant isolation (another clinic never lists, runs, enables or dry-runs over it).
- `packages/testkit/src/contracts/rule-override-store.contract.ts`: authored rules round-trip in the memory and Postgres stores, versioned, with history.
- `packages/llm/src/rule-authoring/agent.test.ts`: the loop (null strings, unknown tools, a refused submission handed back) and the terminology.
- `apps/api/src/rule-authoring-routes.test.ts`: the lab routes end to end; `apps/inbox/src/features/rules/rules-page.test.tsx`: the page in English and Spanish.

## Not done

- Enabling does not re-annotate existing records (by design, like every override); the dry run shows what they would have produced.
- Inbox case labels of an authored rule use its English `reason.label` outside the Rules page (the presenter has no per-rule Spanish label for clinic rules yet).
- Only interval protocols and universal rules; treatment-change, gestational and CKD-stage schedules stay hand-written config.
