import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LlmConfigError } from '../errors.ts';
import type { StructuredLlmProvider } from '../providers/chat-completions.ts';
import {
  createSnapshotProvider,
  emptySnapshot,
  parseSnapshot,
  serializeSnapshot,
  type SnapshotProvider,
} from '../providers/snapshot.ts';

export interface SnapshotFile {
  readonly provider: SnapshotProvider;
  /** Writes the snapshot back when a live reply was recorded. Returns the replay stats. */
  save(): Promise<{ readonly hits: number; readonly misses: number }>;
}

/**
 * The eval CLIs' `--snapshot <file>`: replays the replies recorded in the
 * file and records the rest from `live` (or fails them with `offline`).
 */
export async function openSnapshotFile(options: {
  readonly path: string;
  readonly label: string;
  readonly live: StructuredLlmProvider;
  readonly offline: boolean;
  readonly promptVersions: readonly string[];
}): Promise<SnapshotFile> {
  const recorded = existsSync(options.path)
    ? parseSnapshot(await readFile(options.path, 'utf8'))
    : emptySnapshot(options.label, options.promptVersions);
  if (recorded.provider !== options.label) {
    throw new LlmConfigError(
      `${options.path} holds ${recorded.provider} replies, not ${options.label}`,
    );
  }
  const provider = createSnapshotProvider({
    snapshot: {
      ...recorded,
      promptVersions: [...new Set([...recorded.promptVersions, ...options.promptVersions])].sort(),
    },
    ...(options.offline ? {} : { live: options.live }),
  });
  return {
    provider,
    async save() {
      const stats = provider.stats();
      if (stats.misses > 0 && !options.offline) {
        await mkdir(dirname(options.path), { recursive: true });
        await writeFile(
          options.path,
          serializeSnapshot({ ...provider.snapshot(), recordedAt: new Date().toISOString() }),
          'utf8',
        );
      }
      return stats;
    },
  };
}
