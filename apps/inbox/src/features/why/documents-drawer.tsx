import * as RadixDialog from '@radix-ui/react-dialog';
import { FileText, X } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { usePatientDocuments } from '../../api/queries.ts';
import type { PatientDocumentView, WhyDocumentKind } from '../../api/why-contract.ts';
import { ErrorState } from '../../components/states.tsx';
import { Badge, Button, Skeleton } from '../../components/ui.tsx';
import { useT } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { formatDate } from '../../lib/format.ts';
import { findQuote } from '../../lib/highlight.ts';
import { DocumentFacts, documentKey, KindIcon } from './document-facts.tsx';

/*
 * "View documents" (HIP-142): every record of the patient, newest first,
 * notes with their full text, so a clinician verifies each reason against
 * the whole record and not only the document it cites. One drawer per
 * patient view; any "Show in documents" opens it on that document.
 */

export interface DocumentFocus {
  /** `resourceType/id` of the document to bring into view. */
  readonly key: string;
  /** A quote to mark inside a note (the doctor's words a reason relies on). */
  readonly quote?: string;
}

interface DocumentsDrawerApi {
  readonly open: (focus?: DocumentFocus) => void;
}

const DocumentsContext = createContext<DocumentsDrawerApi | undefined>(undefined);

/** Opens the patient's documents drawer; `undefined` outside a {@link PatientDocumentsProvider}. */
export function useDocumentsDrawer(): DocumentsDrawerApi | undefined {
  return useContext(DocumentsContext);
}

export function PatientDocumentsProvider({
  patientId,
  patientName,
  children,
}: {
  readonly patientId: string;
  readonly patientName: string;
  readonly children: ReactNode;
}): ReactNode {
  const [isOpen, setOpen] = useState(false);
  const [focus, setFocus] = useState<DocumentFocus | undefined>(undefined);
  const opener = useRef<HTMLElement | null>(null);
  const open = useCallback((next?: DocumentFocus) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFocus(next);
    setOpen(true);
  }, []);
  const api = useMemo(() => ({ open }), [open]);
  function handleOpenChange(next: boolean): void {
    setOpen(next);
  }
  function handleCloseAutoFocus(event: Event): void {
    const target = opener.current;
    if (target?.isConnected !== true) return;
    event.preventDefault();
    target.focus();
  }
  return (
    <DocumentsContext.Provider value={api}>
      {children}
      <RadixDialog.Root open={isOpen} onOpenChange={handleOpenChange}>
        <RadixDialog.Portal>
          <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
          <RadixDialog.Content
            onCloseAutoFocus={handleCloseAutoFocus}
            className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-surface shadow-pop sm:w-[min(640px,calc(100vw-48px))]"
          >
            {isOpen ? (
              <DrawerBody patientId={patientId} patientName={patientName} focus={focus} />
            ) : null}
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>
    </DocumentsContext.Provider>
  );
}

/** The case's (or patient's) "View documents" button. */
export function ViewDocumentsButton({ className }: { readonly className?: string }): ReactNode {
  const t = useT();
  const drawer = useDocumentsDrawer();
  if (drawer === undefined) return null;
  function handleClick(): void {
    drawer?.open();
  }
  return (
    <Button
      size="sm"
      variant="secondary"
      icon={<FileText className="size-3.5" aria-hidden="true" />}
      onClick={handleClick}
      {...(className === undefined ? {} : { className })}
    >
      {t.why.viewDocuments}
    </Button>
  );
}

type Filter = 'all' | WhyDocumentKind;

function FilterButton({
  filter,
  active,
  count,
  onSelect,
}: {
  readonly filter: Filter;
  readonly active: boolean;
  readonly count: number;
  readonly onSelect: (filter: Filter) => void;
}): ReactNode {
  const t = useT();
  function handleClick(): void {
    onSelect(filter);
  }
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={handleClick}
      className={cx(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors',
        active
          ? 'border-primary bg-primary-soft text-primary'
          : 'border-border-strong text-muted hover:bg-surface-2 hover:text-fg',
      )}
    >
      {t.why.filters[filter]}
      <span className="text-xs tabular-nums">{count}</span>
    </button>
  );
}

function NoteText({
  text,
  quote,
}: {
  readonly text: string;
  readonly quote: string | undefined;
}): ReactNode {
  const match = quote === undefined ? undefined : findQuote(text, quote);
  return (
    <p className="rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-fg">
      {match ? (
        <>
          {match.before}
          <mark className="evidence-mark" data-testid="document-quote">
            {match.match}
          </mark>
          {match.after}
        </>
      ) : (
        text
      )}
    </p>
  );
}

function DocumentItem({
  doc,
  focus,
}: {
  readonly doc: PatientDocumentView;
  readonly focus: DocumentFocus | undefined;
}): ReactNode {
  const t = useT();
  const focused = focus?.key === documentKey(doc);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'center' });
  }, [focused]);
  return (
    <li
      ref={ref}
      data-document={documentKey(doc)}
      className={cx(
        'flex flex-col gap-2 rounded-xl border p-3',
        focused ? 'border-primary ring-2 ring-primary/30' : 'border-border',
        doc.withdrawn === true && 'opacity-70',
      )}
    >
      <div className="flex items-start gap-2.5">
        <KindIcon kind={doc.kind} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span className="font-medium text-fg">{doc.kindLabel}</span>
            <time dateTime={doc.at}>{formatDate(doc.at)}</time>
            {focused ? <Badge tone="primary">{t.why.cited}</Badge> : null}
            {doc.withdrawn === true ? <Badge tone="warning">{t.why.withdrawn}</Badge> : null}
          </p>
          <DocumentFacts doc={doc} />
        </div>
      </div>
      {doc.text === undefined ? null : (
        <NoteText text={doc.text} quote={focused ? focus.quote : undefined} />
      )}
    </li>
  );
}

function DrawerBody({
  patientId,
  patientName,
  focus,
}: {
  readonly patientId: string;
  readonly patientName: string;
  readonly focus: DocumentFocus | undefined;
}): ReactNode {
  const t = useT();
  const query = usePatientDocuments(patientId, true);
  const [filter, setFilter] = useState<Filter>('all');
  const items = useMemo(() => [...(query.data?.items ?? [])].reverse(), [query.data]);
  const counts = useMemo(() => {
    const byKind = new Map<Filter, number>([['all', items.length]]);
    for (const item of items) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
    return byKind;
  }, [items]);
  const shown = filter === 'all' ? items : items.filter((item) => item.kind === filter);
  const filters = (['all', ...new Set(items.map((item) => item.kind))] as Filter[]).filter(
    (candidate) => (counts.get(candidate) ?? 0) > 0,
  );
  function handleRetry(): void {
    void query.refetch();
  }
  return (
    <>
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <RadixDialog.Title className="text-base font-semibold text-fg">
            {t.why.documentsTitle(patientName)}
          </RadixDialog.Title>
          <RadixDialog.Description className="mt-1 text-sm text-muted">
            {t.why.documentsDescription}
          </RadixDialog.Description>
        </div>
        <RadixDialog.Close
          className="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
          aria-label={t.common.close}
        >
          <X className="size-4" aria-hidden="true" />
        </RadixDialog.Close>
      </div>
      {query.isPending ? (
        <div aria-busy="true" aria-label={t.why.loading} className="flex flex-col gap-3 p-5">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
        </div>
      ) : query.isError ? (
        <div className="p-5">
          <ErrorState error={query.error} onRetry={handleRetry} title={t.why.error} />
        </div>
      ) : (
        <>
          <div
            role="group"
            aria-label={t.why.filterLabel}
            className="flex gap-1.5 overflow-x-auto border-b border-border px-5 py-3"
          >
            {filters.map((candidate) => (
              <FilterButton
                key={candidate}
                filter={candidate}
                active={filter === candidate}
                count={counts.get(candidate) ?? 0}
                onSelect={setFilter}
              />
            ))}
          </div>
          <div
            className="flex-1 overflow-y-auto px-5 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            tabIndex={0}
            role="region"
            aria-label={t.why.documentsTitle(patientName)}
          >
            <p className="mb-3 text-xs text-muted" aria-live="polite">
              {t.why.documentsCount(shown.length)}
            </p>
            {shown.length === 0 ? (
              <p className="text-sm text-muted">{t.why.empty}</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {shown.map((doc) => (
                  <DocumentItem key={documentKey(doc)} doc={doc} focus={focus} />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </>
  );
}
