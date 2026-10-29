import type { MouseEvent, ReactNode } from 'react';
import type { PatientQueueFacets } from '../../api/patient-queue-contract.ts';
import { cx } from '../../lib/cx.ts';
import { useT } from '../../i18n/index.ts';

/*
 * The patient queue's filter bar (HIP-141): chips for the reason type (the
 * engine layer behind the open reasons) and the condition (the protocol
 * behind a protocol-layer reason), each with how many patients of the
 * current view and search it matches. Chip text is API data, already in
 * the response language; only the bar's own chrome goes through the
 * catalogs.
 */

interface Chip {
  readonly id: string;
  readonly label: string;
  readonly count: number;
}

interface ChipGroupProps {
  readonly groupLabel: string;
  readonly selected: readonly string[];
  readonly onToggle: (id: string) => void;
  readonly chips: readonly Chip[];
}

/** One row of toggle chips (reason type, or condition): several can be pressed at once. */
function ChipGroup({ groupLabel, selected, onToggle, chips }: ChipGroupProps): ReactNode {
  function handleClick(event: MouseEvent<HTMLButtonElement>): void {
    onToggle(event.currentTarget.value);
  }
  return (
    <div role="group" aria-label={groupLabel} className="flex flex-wrap gap-1.5">
      {chips.map((chip) => {
        const pressed = selected.includes(chip.id);
        return (
          <button
            key={chip.id}
            type="button"
            value={chip.id}
            aria-pressed={pressed}
            onClick={handleClick}
            className={cx(
              'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
              pressed
                ? 'border-primary bg-primary-soft text-primary'
                : 'border-border text-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            {chip.label}
            <span className="tabular-nums opacity-70">{chip.count}</span>
          </button>
        );
      })}
    </div>
  );
}

export interface QueueFiltersProps {
  readonly facets: PatientQueueFacets | undefined;
  readonly selectedLayers: readonly string[];
  readonly selectedProtocols: readonly string[];
  readonly onToggleLayer: (layer: string) => void;
  readonly onToggleProtocol: (protocolId: string) => void;
  readonly onClear: () => void;
}

/**
 * The filter bar: reason-type chips always shown once facets load, condition
 * chips only for protocols with a match (or already selected, so clearing a
 * stack of filters never hides the chip the clinician is about to unpick).
 */
export function QueueFilters({
  facets,
  selectedLayers,
  selectedProtocols,
  onToggleLayer,
  onToggleProtocol,
  onClear,
}: QueueFiltersProps): ReactNode {
  const t = useT();
  if (facets === undefined) {
    return null;
  }
  const protocolChips = facets.protocols.filter(
    (protocol) => protocol.count > 0 || selectedProtocols.includes(protocol.id),
  );
  const active = selectedLayers.length > 0 || selectedProtocols.length > 0;
  return (
    <div aria-label={t.inbox.filters.groupLabel} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-muted">{t.inbox.filters.reasonType}</span>
        {active ? (
          <button
            type="button"
            onClick={onClear}
            className="text-xs font-medium text-primary hover:underline"
          >
            {t.inbox.filters.clear}
          </button>
        ) : null}
      </div>
      <ChipGroup
        groupLabel={t.inbox.filters.reasonType}
        selected={selectedLayers}
        onToggle={onToggleLayer}
        chips={facets.layers.map((facet) => ({
          id: facet.layer,
          label: facet.label,
          count: facet.count,
        }))}
      />
      {protocolChips.length > 0 ? (
        <>
          <span className="text-xs font-semibold text-muted">{t.inbox.filters.condition}</span>
          <ChipGroup
            groupLabel={t.inbox.filters.condition}
            selected={selectedProtocols}
            onToggle={onToggleProtocol}
            chips={protocolChips.map((facet) => ({
              id: facet.id,
              label: facet.label,
              count: facet.count,
            }))}
          />
        </>
      ) : null}
    </div>
  );
}
