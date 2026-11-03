# Submission checklist: Meta AI Developer Hackathon 2026

Values to paste into the submission form. Deadline: Nov 4, 2026, 9 PM ET.

## Form fields

- **Project name:** Follow-up Engine
- **One-line description:** An AI-powered patient continuity engine that executes clinician-defined follow-up workflows, coordinates patient outreach, and schedules care without providing autonomous medical advice.
- **Demo URL:** https://follow-up-engine-demo-production.up.railway.app
  - The access code goes in the form's private field for judges. It is not in this file or anywhere in the repository.
- **Repository URL:** https://github.com/Hipocratesalud/follow-up-engine
- **Video (3 min):** <link — to fill>
- **Team:**
  - Simeón Aldana
  - Luis <SURNAME — to fill>, physician, co-founder (<role wording — to fill>)
- **Track:** Startup
- **Bonus category:** Best Agentic Use-Case

## Meta models used

| Model id                    | Used for                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `muse-spark-1.3`            | The order-to-completion agent (tool calling), note extraction, the clinical reviewer, the adjudicator, rule authoring, and vision: photos of lab reports and scanned PDF lab reports |
| `muse-voice-transcribe-1.0` | Transcribing a patient's voice note                                                                                                                                                  |

Muse Spark Open was not used (no Baseten credits), so it has no eval and no number in the repository. Measured costs per use are in the README's [Meta AI usage](README.md#meta-ai-usage) table.

## What to look at in 3 minutes

1. **`/agent`, María's story.** Start it, reply "I can't make it on Tuesday", then "Number 2 works for me", then send the sample lab photo. The console shows every step of the loop: the order detected, the context read, the tool the model chose and why, the message and its safety check, the photo read by Muse Spark, the booking, and the engine (not the agent) closing the order. Scripted mode costs nothing; live Muse Spark is offered within the demo's budget.
2. **Guardrails in code.** Slots computed by code, booking only on an explicit yes, no diagnosis, value or test name to the patient, final opt-out recorded as a FHIR `Consent` ([README](README.md#guardrails-enforced-in-code)).
3. **Inbox, "Why this?".** The due date recomputed from the record, the doctor's own words highlighted in the note, and Confirm, Correct or Reject on Muse Spark's reading.
4. **Lab.** Import a patient's history; a report printed for another person is held for review, never recorded.
5. **Value.** The simulated comparison with fixed reminders (50.6 % → 74.6 % of orders fulfilled within 90 days, synthetic patients, stated assumptions).

Full walkthrough: [README](README.md#walkthrough-for-judges-about-3-minutes).

## Open items for Simeón

- [ ] Video link: record it, then fill it in the form, in this file and in the README's "Video (3 min)" line.
- [ ] Luis's surname and role wording, in this file and in the README's Team section (remove the HTML comment there).
- [ ] License: decide one; the README's License line is a placeholder and there is no LICENSE file.
- [ ] Team members' names in the form.
- [ ] Post on X.
- [ ] Access code in the form's private field.
