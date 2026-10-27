# Protocols

Versioned JSON care protocols loaded through the `ProtocolSource` port.

A protocol is a cadence of expectations tied to a condition (for example, periodic controls for a chronic patient). Each file carries an `id` and a `version`, recorded on every expectation it creates.

Protocols are never enabled for a clinic without clinical team validation.

## Layout

One protocol per file (`diabetes.json`, `hypertension.json`), validated by `ProtocolSchema`. Item rule ids are `protocol_<protocol id>_<item key>` (for example `protocol_diabetes_hba1c`). Enrollment is by ICD-10 prefix (confirmed or probable) and, when no diagnosis is coded, by medications or results that make the condition probable. A protocol item is skipped when the doctor's plan or a universal rule already asks for the same thing: the same code, a code of the item's equivalence group (every code its `fulfilledBy` filters accept, for example any lipid panel LOINC) or, for an uncoded plan item, a quote that names the test (`planTerms`). An order or plan item that arrives later withdraws the live protocol expectation (`covered_by_later_request`). Results count under any LOINC code of the same measurement (the HbA1c item accepts 4548-4, 17856-6, 4549-2, 62388-4 and IFCC 59261-8; the lipid item any lipid panel or component code), and an enrollment result threshold is compared in its own unit (HbA1c >= 6.5 % is about 48 mmol/mol IFCC).
