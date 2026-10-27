import {
  Activity,
  CalendarCheck,
  ClipboardList,
  FileText,
  FlaskConical,
  HeartPulse,
  Pill,
  ShieldAlert,
  Stethoscope,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { DocumentRefView, WhyDocumentKind } from '../../api/why-contract.ts';
import { useT } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';

const KIND_ICONS: Record<WhyDocumentKind, typeof FileText> = {
  note: FileText,
  order: ClipboardList,
  result: FlaskConical,
  prescription: Pill,
  visit: Stethoscope,
  appointment: CalendarCheck,
  diagnosis: HeartPulse,
  allergy: ShieldAlert,
  other: Activity,
};

/** `resourceType/id`: how a cited document is found in the drawer. */
export function documentKey(doc: Pick<DocumentRefView, 'resourceType' | 'id'>): string {
  return `${doc.resourceType}/${doc.id}`;
}

export function KindIcon({ kind }: { readonly kind: WhyDocumentKind }): ReactNode {
  const Icon = KIND_ICONS[kind];
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted">
      <Icon className="size-3.5" aria-hidden="true" />
    </span>
  );
}

const INTERPRETATION_TONES: Record<NonNullable<DocumentRefView['interpretation']>, string> = {
  normal: 'text-muted',
  unknown: 'text-muted',
  abnormal: 'text-warning font-medium',
  critical: 'text-danger font-semibold',
};

/** What a document is: its title, value or dosage, code, status, specialty and author. */
export function DocumentFacts({ doc }: { readonly doc: DocumentRefView }): ReactNode {
  const t = useT();
  const specialty =
    doc.specialty === undefined
      ? undefined
      : ((t.labels.specialties as Record<string, string>)[doc.specialty] ?? doc.specialty);
  // A visit or an appointment is named by its specialty.
  const titledBySpecialty =
    specialty !== undefined && (doc.kind === 'visit' || doc.kind === 'appointment');
  const status =
    doc.status === undefined
      ? undefined
      : ((t.why.statuses as Record<string, string>)[doc.status] ?? doc.status);
  const meta = [
    doc.code === undefined ? undefined : t.why.code(doc.code),
    status === undefined ? undefined : t.why.status(status),
    titledBySpecialty ? undefined : specialty,
    doc.author === undefined ? undefined : t.why.by(doc.author),
  ].filter((part): part is string => part !== undefined);
  return (
    <div className="mt-0.5 min-w-0">
      <p className="text-sm font-medium break-words text-fg">
        {titledBySpecialty ? specialty : doc.title}
      </p>
      {doc.detail === undefined ? null : (
        <p className={cx('text-sm', INTERPRETATION_TONES[doc.interpretation ?? 'unknown'])}>
          {doc.detail}
        </p>
      )}
      {meta.length === 0 ? null : (
        <p className="mt-0.5 text-xs break-words text-muted">{meta.join(t.common.separator)}</p>
      )}
    </div>
  );
}
