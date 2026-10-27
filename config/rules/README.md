# Rules

Versioned JSON rule definitions loaded through the `RuleSource` port.

A rule turns a clinical event into an expectation ("an imaging order should have a result within 30 days") and says what fulfills, supersedes or escalates it. Each file carries an `id` and a `version`; the version is recorded on every expectation the rule creates, so any decision can be traced back to the exact rule text that produced it.

Rules are never enabled for a clinic without clinical team validation.
