import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LlmProviderError, LlmSchemaError } from '../errors.ts';
import type { DetailedUsage, ProviderCompletion, ProviderRequest } from '../usage.ts';
import type { StructuredLlmProvider } from './chat-completions.ts';
import { parseStructuredOutput } from './structured-output.ts';

/**
 * Recorded model replies, replayed by {@link createSnapshotProvider}.
 *
 * A snapshot lets an eval be re-scored after a post-processing fix, and the
 * demo's initial backfill read hundreds of notes in seconds, with the
 * readings a real model gave once, instead of calling it again. Entries are
 * keyed by {@link snapshotKey}: the model, the output schema name, the tools
 * and every message. The messages hold the prompt (whose text changes with
 * its version) and the prepared note, so a new prompt or a different note
 * never replays an old reply.
 */
export interface LlmSnapshot {
  readonly format: 1;
  /** Provider the replies came from (`meta`): the replay answers under this name. */
  readonly provider: string;
  /** Prompt versions the replies were recorded with (informational, for staleness checks). */
  readonly promptVersions: readonly string[];
  readonly recordedAt?: string;
  readonly entries: Readonly<Record<string, LlmSnapshotEntry>>;
}

export interface LlmSnapshotEntry {
  readonly model: string;
  /** The reply as the provider normalized it (JSON text; a tool call as `{ thought, tool, arguments }`). */
  readonly rawOutput: string;
  readonly usage: DetailedUsage;
  readonly latencyMs: number;
  /**
   * The reply failed validation (a repairable schema error): replayed as the
   * same error, so the gateway's repair round trip replays too.
   */
  readonly invalid?: { readonly issues: string; readonly summary: string };
}

const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
});

const SnapshotSchema = z.object({
  format: z.literal(1),
  provider: z.string().min(1),
  promptVersions: z.array(z.string()),
  recordedAt: z.string().optional(),
  entries: z.record(
    z.string(),
    z.object({
      model: z.string().min(1),
      rawOutput: z.string(),
      usage: UsageSchema,
      latencyMs: z.number().nonnegative(),
      invalid: z.object({ issues: z.string(), summary: z.string() }).optional(),
    }),
  ),
});

export function emptySnapshot(
  provider: string,
  promptVersions: readonly string[] = [],
): LlmSnapshot {
  return { format: 1, provider, promptVersions: [...promptVersions], entries: {} };
}

/** Parses a snapshot file. Throws on anything but a well-formed format-1 snapshot. */
export function parseSnapshot(text: string): LlmSnapshot {
  const parsed = SnapshotSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`Invalid LLM snapshot: ${z.prettifyError(parsed.error)}`);
  }
  return dropUndefined(parsed.data);
}

function dropUndefined(snapshot: z.infer<typeof SnapshotSchema>): LlmSnapshot {
  const entries: Record<string, LlmSnapshotEntry> = {};
  for (const [key, entry] of Object.entries(snapshot.entries)) {
    const usage: DetailedUsage = {
      inputTokens: entry.usage.inputTokens,
      outputTokens: entry.usage.outputTokens,
      ...(entry.usage.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: entry.usage.cachedInputTokens }),
      ...(entry.usage.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: entry.usage.reasoningTokens }),
    };
    entries[key] = {
      model: entry.model,
      rawOutput: entry.rawOutput,
      usage,
      latencyMs: entry.latencyMs,
      ...(entry.invalid === undefined ? {} : { invalid: entry.invalid }),
    };
  }
  return {
    format: 1,
    provider: snapshot.provider,
    promptVersions: snapshot.promptVersions,
    ...(snapshot.recordedAt === undefined ? {} : { recordedAt: snapshot.recordedAt }),
    entries,
  };
}

/** Union of snapshots of one provider; on a shared key the later snapshot wins. */
export function mergeSnapshots(...snapshots: readonly LlmSnapshot[]): LlmSnapshot {
  const [first] = snapshots;
  if (first === undefined) throw new Error('mergeSnapshots needs at least one snapshot');
  const entries: Record<string, LlmSnapshotEntry> = {};
  const promptVersions = new Set<string>();
  for (const snapshot of snapshots) {
    if (snapshot.provider !== first.provider) {
      throw new Error(
        `Cannot merge snapshots of provider ${snapshot.provider} into ${first.provider}`,
      );
    }
    Object.assign(entries, snapshot.entries);
    for (const version of snapshot.promptVersions) promptVersions.add(version);
  }
  const recordedAt = snapshots
    .map((s) => s.recordedAt)
    .filter((at) => at !== undefined)
    .sort()
    .at(-1);
  return {
    format: 1,
    provider: first.provider,
    promptVersions: [...promptVersions].sort(),
    ...(recordedAt === undefined ? {} : { recordedAt }),
    entries,
  };
}

/** The snapshot as stable JSON (keys sorted), so a re-recording diffs cleanly. */
export function serializeSnapshot(snapshot: LlmSnapshot): string {
  const entries = Object.fromEntries(
    Object.keys(snapshot.entries)
      .sort()
      .map((key) => [key, snapshot.entries[key]]),
  );
  return `${JSON.stringify({ ...snapshot, entries }, null, 1)}\n`;
}

/**
 * The reviewer's opaque patient reference is new on every run
 * (`"patientRef":"P-<last 8 of the run id>"`, core's reviewer service): it is
 * left out of the key, so a recorded review replays on the next run.
 */
const RUN_REFERENCE = /"patientRef":"P-[^"\\]{1,32}"/g;

/**
 * Stable key of a request: sha256 of the model, the output name, the tool
 * names and descriptions, and every message (without per-run references),
 * images included (by their own sha256). Never contains note text.
 *
 * A message's images are part of what the model reads: two photos sent
 * with the same prompt are two requests. Without them in the key, every
 * photo after the first replayed the first one's reading (a patient's
 * HbA1c report read back as another patient's creatinine and LDL). A
 * message with no image keeps its former key, so recorded text replies
 * still replay.
 */
export function snapshotKey(
  request: Pick<ProviderRequest<unknown>, 'model' | 'messages' | 'output' | 'tools'>,
): string {
  const material = JSON.stringify({
    model: request.model,
    output: request.output.name,
    tools: (request.tools ?? []).map((tool) => [tool.name, tool.description]),
    messages: request.messages.map((m) => {
      const entry: unknown[] = [m.role, m.content.replace(RUN_REFERENCE, '"patientRef":"P"')];
      if (m.images !== undefined && m.images.length > 0) {
        entry.push(
          m.images.map((image) => createHash('sha256').update(image.dataUrl).digest('hex')),
        );
      }
      return entry;
    }),
  });
  return createHash('sha256').update(material).digest('hex');
}

export interface SnapshotProviderOptions {
  readonly snapshot: LlmSnapshot;
  /**
   * Called on a miss; its reply is recorded. Without it a miss fails with a
   * non-retryable `snapshot_miss` error (offline replay).
   */
  readonly live?: StructuredLlmProvider;
  /**
   * `recorded` (default): a replay reports the tokens and latency of the
   * original call, so its cost reproduces (the gateway still measures its
   * own, near-zero, latency). `none`: zero tokens and latency.
   */
  readonly replayUsage?: 'recorded' | 'none';
  /**
   * Whether a miss may call `live` right now (default: always). The demo
   * seed replays only (a miss fails like an outage, and the gateway's next
   * route entry answers); live traffic after it calls the model. Recording
   * scripts use it as a spending cap.
   */
  readonly allowLive?: () => boolean;
  /** Called after a live reply is recorded. */
  readonly onRecord?: (key: string, entry: LlmSnapshotEntry) => void;
  /** Called when a recorded reply is replayed (to keep only the entries a run still uses). */
  readonly onReplay?: (key: string, entry: LlmSnapshotEntry) => void;
}

export interface SnapshotProvider extends StructuredLlmProvider {
  /** Replays and live calls so far. */
  stats(): { readonly hits: number; readonly misses: number };
  /** The replayed snapshot plus every reply recorded since. */
  snapshot(): LlmSnapshot;
}

/**
 * Replays recorded replies and records new ones. Answers under the
 * snapshot's provider name, so the gateway prices and logs a replay as the
 * model that produced it. A replayed reply goes through the same parsing and
 * zod validation as a live one.
 */
export function createSnapshotProvider(options: SnapshotProviderOptions): SnapshotProvider {
  const entries: Record<string, LlmSnapshotEntry> = { ...options.snapshot.entries };
  const name = options.live?.name ?? options.snapshot.provider;
  const replayUsage = options.replayUsage ?? 'recorded';
  let hits = 0;
  let misses = 0;

  async function complete<TOutput>(
    request: ProviderRequest<TOutput>,
  ): Promise<ProviderCompletion<TOutput>> {
    const key = snapshotKey(request);
    const entry = entries[key];
    if (entry !== undefined) {
      hits += 1;
      options.onReplay?.(key, entry);
      const usage: DetailedUsage =
        replayUsage === 'recorded' ? entry.usage : { inputTokens: 0, outputTokens: 0 };
      await Promise.resolve();
      if (entry.invalid !== undefined) {
        throw new LlmSchemaError(name, {
          model: request.model,
          rawOutput: entry.rawOutput,
          issues: entry.invalid.issues,
          summary: entry.invalid.summary,
          usage,
          repairable: true,
        });
      }
      const output = parseStructuredOutput(
        name,
        request.model,
        entry.rawOutput,
        request.output.schema,
        usage,
      );
      return {
        output,
        usage,
        latencyMs: replayUsage === 'recorded' ? entry.latencyMs : 0,
        provider: name,
        model: request.model,
        rawOutput: entry.rawOutput,
      };
    }
    misses += 1;
    if (options.live === undefined || options.allowLive?.() === false) {
      throw new LlmProviderError(name, `No snapshot entry for request ${key.slice(0, 12)}`, {
        retryable: false,
        code: 'snapshot_miss',
      });
    }
    const record = (entry: LlmSnapshotEntry): void => {
      entries[key] = entry;
      options.onRecord?.(key, entry);
    };
    let completion: ProviderCompletion<TOutput>;
    const started = performance.now();
    try {
      completion = await options.live.complete(request);
    } catch (error) {
      // A repairable invalid reply is replayed as the same error, so the
      // repair request that follows (recorded on its own) replays too.
      if (error instanceof LlmSchemaError && error.repairable && error.rawOutput !== '') {
        record({
          model: request.model,
          rawOutput: error.rawOutput,
          usage: error.usage,
          latencyMs: Math.round(performance.now() - started),
          invalid: { issues: error.issues, summary: error.summary },
        });
      }
      throw error;
    }
    if (completion.rawOutput !== undefined) {
      record({
        model: request.model,
        rawOutput: completion.rawOutput,
        usage: completion.usage,
        latencyMs: completion.latencyMs,
      });
    }
    return completion;
  }

  return {
    name,
    complete,
    stats: () => ({ hits, misses }),
    snapshot: () => ({ ...options.snapshot, provider: name, entries: { ...entries } }),
  };
}
