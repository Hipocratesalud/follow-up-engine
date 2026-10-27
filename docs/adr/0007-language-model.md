# 0007. Language model: clinic, user, patient and note languages

- Status: Accepted
- Date: 2026-10-27
- Ticket: HIP-138

## Context

The engine started as a Spanish-only module for Hipócrates: UI copy, API labels, validation messages and rule names were neutral Spanish, and the deterministic checks of the note extractor only knew Spanish wording. It is now judged by an international audience and meant for any EHR: the inbox must read in English by default, Spanish must stay a first-class second locale for hosts in Latin America, and nothing may assume that the people involved share one language. A clinic in Miami can have an English-speaking front desk, Spanish-speaking patients and notes written in either language by different doctors.

Translating clinical content is out of the question: a quote that backs a finding must be the doctor's exact words, and a machine translation of a note is a new, unvalidated clinical document.

## Decision

Four languages, each from its own source, each deciding one thing. They are independent: none is derived from another.

| Language  | Source                                                                                                                                        | Decides                                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| User (UI) | The inbox's own switch, remembered per viewer; sent as `Accept-Language` on every API call                                                    | Every label and message the inbox and the JSON API show                                                                                       |
| Clinic    | `ClinicSettings.locale` (BCP-47, default `en-US`; `clinic:create --locale`)                                                                   | The API's fallback when `Accept-Language` names no language with a catalog; the language the clinical reviewer writes findings in             |
| Patient   | FHIR `Patient.communication` (the `preferred` one first) → `patient.language_recorded` event                                                  | Forwarded on every contact request (`patient_contact.requested.language`, `CommunicationRequest.language`): the host writes the message in it |
| Note      | FHIR `DocumentReference.language` (or the attachment's, `Composition.language`); absent: a deterministic stopword detector (`es`, `en`, `pt`) | Which lexicons the extractor's deterministic checks use; reported as `noteLanguage` on the extraction and on `plan.extracted`                 |

- **Locale resolution in the API.** First language of `Accept-Language` (by `q`) that has a catalog, else the clinic locale's language when it has one, else English. Before authentication only the header counts. Responses carry `Content-Language` and `Vary: Accept-Language`.
- **Catalogs, typed.** The inbox and the API each keep an English catalog (source of truth) and a Spanish one with the same shape: the Spanish catalog `satisfies` the English type, so a missing key or a wrong parameter is a compile error. Dates, numbers and relative times go through `Intl` with the active locale. A lint rule in the inbox fails on hard-coded user-facing strings in components, with an allowlist for clinical data.
- **Rule and protocol names.** The config JSON keeps codes and one English `label` (the source text the engine records on expectations and writes to FHIR, where no request locale exists). Display text per locale lives in the API catalogs, keyed by reason code (rule id or protocol item). We chose catalogs over `labels: { en, es }` inside each rule file because config files are clinical artifacts reviewed by the clinical team, versioned and hashed into expectations: a copy-only change (a translation) must not bump a rule version or touch a validated file. A test fails when a reason code in `config/` has no text in a catalog, when a catalog keeps a code `config/` no longer has, or when the English catalog drifts from the config label.
- **Validation messages.** The zod error map is per locale; a schema `refine` names its message by key (`params: { message: 'snoozeDaysRequired' }`) so it is localized like every built-in issue.
- **Clinical content is data.** Note text, evidence quotes, the host's own displays (`code.text` of an order), patient and practitioner names, drug names from the record and example notes are never translated in either direction. The catalogs hold code display names (LOINC, ICD-10) only for codes the host sent without its own text.
- **Lexicons by note language.** Spanish lexicons stay as they were (their eval must not regress); English lexicons cover negation, family history, discharge, conditional returns, cancelled follow-ups, timing expressions (`f/u in 3 months`, `RTC 6 wks`), PRN, chronic-drug names, condition terms and test names. The eval reports metrics per note language.

## Consequences

- An English-speaking team sees English labels for Spanish notes with Spanish quotes; a Spanish-speaking team switches the inbox and every API label follows, with no restart and no clinic setting.
- The host, not the engine, writes patient messages, so the patient's language is metadata on the request; a patient without one gets the clinic's language.
- Findings of the clinical reviewer are stored in the clinic's language at generation time and are not re-rendered when a user switches locale (they are clinical suggestions with citations, not labels).
- Adding a third UI locale is a catalog per app plus its entry in the locale lists; adding a note language is a lexicon set plus gold notes in that language.
- Storage: the clinic locale lives in `clinics.settings` (jsonb), the patient language in `clinical_events`, and the language of each contact attempt in `contact_requests.language` (migration 0012).
