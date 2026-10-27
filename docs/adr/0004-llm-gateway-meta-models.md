# 0004. Single llm_gateway, Meta models first

- Status: Accepted
- Date: 2026-10-27

## Context

The engine uses an LLM to extract the doctor's plan from free-text notes. LLM calls cost money, leak data if careless, and are nondeterministic.

## Decision

Every LLM call goes through one `LlmGateway` in `packages/llm`, built on the `LlmProvider` port.

- Primary provider: Meta models (Muse Spark via the Meta Model API; Muse Spark Open via Baseten). An OpenAI-compatible adapter exists for portability; a fake provider runs in CI.
- Calls are structured completions against a JSON schema; output is validated before it reaches the domain.
- The gateway records tokens, latency and cost per clinic and enforces a per-clinic budget cap.
- `clinic_id` and direct patient identifiers are never sent to the model.
- An eval harness scores extraction on synthetic notes and gates prompt or model changes.

## Consequences

- Swapping or adding a model is configuration plus an adapter.
- CI is deterministic and free; quality is measured by the eval harness, not by unit tests.
