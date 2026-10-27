import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parseIsoDate } from '../extraction/due-date.ts';
import { ExpectedExtractionSchema } from '../extraction/fixtures.ts';

/** A synthetic note with its expected extraction (shared gold-note format, see the testkit fixtures). */
export const GoldNoteSchema = z.object({
  id: z.string().min(1),
  specialty: z.string().min(1),
  /** `YYYY-MM-DD` (read as noon UTC) or a full ISO instant. */
  authoredAt: z.string().min(1),
  /** BCP-47 language of the note; absent: Spanish (`es`). Scored against the extractor's detection. */
  language: z.string().min(1).optional(),
  text: z.string().min(1),
  expected: ExpectedExtractionSchema,
});
export type GoldNote = z.infer<typeof GoldNoteSchema>;

/** The instant a gold note was authored. */
export function goldAuthoredAt(note: Pick<GoldNote, 'authoredAt' | 'id'>): Date {
  const date = parseIsoDate(note.authoredAt) ?? new Date(note.authoredAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Gold note ${note.id} has an invalid authoredAt: ${note.authoredAt}`);
  }
  return date;
}

/** Reads and validates every `*.json` gold note in a directory, sorted by file name. */
export async function loadGoldNotes(dir: string): Promise<GoldNote[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const notes: GoldNote[] = [];
  for (const file of files) {
    const raw: unknown = JSON.parse(await readFile(join(dir, file), 'utf8'));
    const parsed = GoldNoteSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid gold note ${file}:\n${z.prettifyError(parsed.error)}`);
    }
    notes.push(parsed.data);
  }
  return notes;
}

/** The language a gold note is written in (`es` when the note does not say). */
export function goldLanguage(note: Pick<GoldNote, 'language'>): string {
  return note.language ?? 'es';
}
