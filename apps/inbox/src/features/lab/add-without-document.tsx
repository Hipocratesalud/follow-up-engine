import { ChevronDown, ChevronUp, ClipboardPlus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { LabRecordResponse } from '../../api/contract.ts';
import { Button, Card } from '../../components/ui.tsx';
import { useT } from '../../i18n/index.ts';
import { RecordForm } from './record-form.tsx';

/**
 * "Add something without a document" (docs/deploy.md#hosted-demo): the
 * structured record form, collapsed by default so the upload card above
 * stays the obvious first action.
 */
export function AddWithoutDocument({
  patientId,
  onRecordSaved,
}: {
  readonly patientId: string;
  readonly onRecordSaved: (response: LabRecordResponse) => void;
}): ReactNode {
  const t = useT();
  const [open, setOpen] = useState(false);

  function handleToggle(): void {
    setOpen((previous) => !previous);
  }

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <ClipboardPlus className="mt-0.5 size-4 text-muted" aria-hidden="true" />
          <div>
            <h2 className="text-base font-semibold text-fg">{t.lab.addWithoutDocumentTitle}</h2>
            <p className="mt-1 text-sm text-muted">{t.lab.addWithoutDocumentIntro}</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleToggle}
          aria-expanded={open}
          icon={
            open ? (
              <ChevronUp className="size-3.5" aria-hidden="true" />
            ) : (
              <ChevronDown className="size-3.5" aria-hidden="true" />
            )
          }
        >
          {open ? t.lab.hideForm : t.lab.showForm}
        </Button>
      </div>
      {open ? <RecordForm patientId={patientId} onRecordSaved={onRecordSaved} /> : null}
    </Card>
  );
}
