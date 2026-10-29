import { UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEvaluator, useLogoutEvaluator } from '../api/queries.ts';
import { useT } from '../i18n/index.ts';

/**
 * "Evaluating as <email>" (docs/deploy.md#hosted-demo): shown whenever the
 * access gate identified an evaluator. Empty (nothing rendered) on a plain
 * deployment with no access gate configured.
 */
export function EvaluatorBanner(): ReactNode {
  const t = useT();
  const evaluator = useEvaluator();
  const logout = useLogoutEvaluator();

  function handleChange(): void {
    if (logout.isPending) return;
    logout.mutate(undefined, {
      onSuccess: () => {
        // The server now sends every request back to the code page: a full
        // reload (not a client route change) is what gets us there.
        globalThis.location.assign('/');
      },
    });
  }

  const email = evaluator.data?.email;
  if (email === undefined) return null;

  return (
    <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border-strong bg-surface-2 px-2.5 py-1 text-xs font-medium text-fg">
      <UserRound className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
      <span className="min-w-0 truncate" title={t.common.evaluatingAs(email)}>
        {t.common.evaluatingAs(email)}
      </span>
      <button
        type="button"
        onClick={handleChange}
        disabled={logout.isPending}
        className="shrink-0 font-semibold text-primary hover:underline disabled:opacity-60"
      >
        {t.common.change}
      </button>
    </div>
  );
}
