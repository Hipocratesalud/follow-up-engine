import { createHash } from 'node:crypto';
import { LlmProviderError } from '../errors.ts';
import type { DetailedUsage, ProviderCompletion, ProviderRequest } from '../usage.ts';
import type { StructuredLlmProvider } from './chat-completions.ts';
import { parseStructuredOutput } from './structured-output.ts';

export const FAKE_PROVIDER_NAME = 'fake';
export const FAKE_DEFAULT_MODEL = 'fake-extractor';

/**
 * Produces the reply for a request. Return a value to have it serialized as
 * JSON, a string to return raw text (for example invalid JSON, to exercise
 * repair), or `undefined` to fall through to the next responder.
 */
export type FakeResponder = (request: ProviderRequest<unknown>) => unknown;

export interface FakeProviderOptions {
  /** Replies keyed by {@link fakeRequestKey}. Checked before `respond`. */
  readonly responses?: Readonly<Record<string, unknown>>;
  readonly respond?: FakeResponder;
}

/** Stable key of a request: sha256 of the output name and the messages. */
export function fakeRequestKey(
  request: Pick<ProviderRequest<unknown>, 'messages' | 'output'>,
): string {
  const material = JSON.stringify({
    output: request.output.name,
    messages: request.messages.map((m) => [m.role, m.content]),
  });
  return createHash('sha256').update(material).digest('hex');
}

/** Rough token count (four characters per token), so the fake reports plausible usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Deterministic, offline provider for CI, tests and demos without a key.
 * Its reply goes through the same JSON parsing and zod validation as a real
 * model's, so repair and error paths behave exactly as in production.
 */
export function createFakeProvider(options: FakeProviderOptions = {}): StructuredLlmProvider {
  async function complete<TOutput>(
    request: ProviderRequest<TOutput>,
  ): Promise<ProviderCompletion<TOutput>> {
    await Promise.resolve();
    if (request.signal?.aborted) {
      throw request.signal.reason instanceof Error
        ? request.signal.reason
        : new LlmProviderError(FAKE_PROVIDER_NAME, 'Request aborted', { retryable: false });
    }
    const key = fakeRequestKey(request);
    let reply: unknown = options.responses?.[key];
    if (reply === undefined) reply = options.respond?.(request);
    if (reply === undefined) {
      throw new LlmProviderError(FAKE_PROVIDER_NAME, `No fake response for request ${key}`, {
        retryable: false,
      });
    }
    const raw = typeof reply === 'string' ? reply : JSON.stringify(reply);
    const prompt = request.messages.map((m) => m.content).join('\n');
    const usage: DetailedUsage = {
      inputTokens: estimateTokens(prompt),
      outputTokens: estimateTokens(raw),
    };
    const output = parseStructuredOutput(
      FAKE_PROVIDER_NAME,
      request.model,
      raw,
      request.output.schema,
      usage,
    );
    return {
      output,
      usage,
      latencyMs: 0,
      provider: FAKE_PROVIDER_NAME,
      model: request.model,
      rawOutput: raw,
    };
  }
  return { name: FAKE_PROVIDER_NAME, complete };
}
