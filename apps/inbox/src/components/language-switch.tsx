import { useQueryClient } from '@tanstack/react-query';
import { Languages } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { isLocale, LOCALES, setLocale, useLocale, useT } from '../i18n/index.ts';
import { cx } from '../lib/cx.ts';

/**
 * The UI language: English (default) or Spanish. One control, a two-option
 * group; each option names its language in that language (and says so with
 * `lang`), so a viewer who reads neither label well still finds their own.
 * Switching remembers the choice and refetches every query, so the labels
 * the API writes come back in the new language too.
 */
export function LanguageSwitch({ compact = false }: { readonly compact?: boolean }): ReactNode {
  const t = useT();
  const locale = useLocale();
  const queryClient = useQueryClient();

  function handleClick(event: MouseEvent<HTMLButtonElement>): void {
    const next = event.currentTarget.value;
    if (!isLocale(next) || next === locale) return;
    setLocale(next);
    void queryClient.invalidateQueries();
  }

  return (
    <div
      role="group"
      aria-label={t.common.language}
      className="inline-flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5"
    >
      <Languages className="mx-1 size-3.5 text-muted" aria-hidden="true" />
      {LOCALES.map((option) => (
        <button
          key={option}
          type="button"
          value={option}
          lang={option}
          aria-pressed={locale === option}
          title={compact ? t.common.languageNames[option] : undefined}
          onClick={handleClick}
          className={cx(
            'rounded-md px-2 py-1 text-xs font-medium transition-colors',
            locale === option ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
          )}
        >
          {compact ? (
            <>
              <span aria-hidden="true">{option.toUpperCase()}</span>
              <span className="sr-only">{t.common.languageNames[option]}</span>
            </>
          ) : (
            t.common.languageNames[option]
          )}
        </button>
      ))}
    </div>
  );
}
