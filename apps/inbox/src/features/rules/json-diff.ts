/** One line of a line diff. */
export interface DiffLine {
  readonly kind: 'same' | 'added' | 'removed';
  readonly text: string;
}

/** Keys sorted at every depth, so two definitions diff by content, not by key order. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Pretty JSON lines, keys sorted. */
export function jsonLines(value: unknown): string[] {
  return JSON.stringify(sorted(value), null, 2).split('\n');
}

/**
 * A line diff (longest common subsequence) of two pretty-printed JSON
 * documents. Without a `before`, every line is added (a new definition).
 */
export function jsonDiff(before: unknown, after: unknown): DiffLine[] {
  const next = jsonLines(after);
  if (before === undefined) return next.map((text) => ({ kind: 'added', text }));
  const previous = jsonLines(before);
  const rows = previous.length;
  const columns = next.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    Array.from({ length: columns + 1 }, () => 0),
  );
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      const row = table[i] ?? [];
      row[j] =
        previous[i] === next[j]
          ? (table[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (previous[i] === next[j]) {
      lines.push({ kind: 'same', text: next[j] ?? '' });
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      lines.push({ kind: 'removed', text: previous[i] ?? '' });
      i += 1;
    } else {
      lines.push({ kind: 'added', text: next[j] ?? '' });
      j += 1;
    }
  }
  for (; i < rows; i += 1) lines.push({ kind: 'removed', text: previous[i] ?? '' });
  for (; j < columns; j += 1) lines.push({ kind: 'added', text: next[j] ?? '' });
  return lines;
}
