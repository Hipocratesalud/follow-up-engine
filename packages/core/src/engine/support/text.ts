/** Lowercase without accents, so "Losartán" matches "losartan" and "Reconsultar" matches "reconsultar". */
export function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `text` contains one of `phrases` as whole words, ignoring case and
 * accents: "PRN" matches "c/8h PRN dolor" but not "PRNX", "si persiste"
 * matches "Reconsultar si persiste.".
 */
export function containsPhrase(text: string, phrases: readonly string[]): boolean {
  const folded = foldText(text);
  return phrases.some((phrase) =>
    new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(foldText(phrase))}($|[^\\p{L}\\p{N}])`, 'u').test(
      folded,
    ),
  );
}

/** Whether `text` contains one of `fragments` anywhere (drug name stems such as "atorvastat"). */
export function containsFragment(text: string, fragments: readonly string[]): boolean {
  const folded = foldText(text);
  return fragments.some((fragment) => folded.includes(foldText(fragment)));
}
