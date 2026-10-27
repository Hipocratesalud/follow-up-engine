import { firstDate } from '../../support/datetime.ts';
import { decodeBase64Text, normalizeWhitespace, xhtmlToText } from '../../support/text.ts';
import { specialtyOf, withdrawal, type EntryContext, type MappedResource } from '../context.ts';
import type { CompositionSectionInput, ParsedResourceOf } from '../schemas.ts';

const MARKUP_TYPES = /^(text\/html|application\/xhtml\+xml)\b/i;
const TEXT_TYPES = /^(text\/|application\/(json|xml)\b)/i;

function attachmentText(
  document: ParsedResourceOf<'DocumentReference'>,
  ctx: EntryContext,
): string | undefined {
  const parts: string[] = [];
  document.content.forEach(({ attachment }, index) => {
    const path = `content[${String(index)}].attachment`;
    const contentType = attachment.contentType ?? 'text/plain';
    if (attachment.data === undefined) {
      return;
    }
    if (!TEXT_TYPES.test(contentType)) {
      ctx.report('warning', 'not-supported', `attachment of type ${contentType} is not read`, path);
      return;
    }
    const decoded = decodeBase64Text(attachment.data, contentType);
    if (decoded === undefined) {
      ctx.report('warning', 'value', 'attachment data is not base64-encoded', `${path}.data`);
      return;
    }
    if (decoded.repaired.includes('charset')) {
      ctx.report(
        'warning',
        'value',
        `unknown charset in contentType "${contentType}"; read as UTF-8`,
        `${path}.contentType`,
      );
    }
    if (decoded.repaired.includes('bytes')) {
      ctx.report(
        'warning',
        'value',
        'attachment text has bytes that are not valid in its charset; replaced by U+FFFD',
        `${path}.data`,
      );
    }
    if (decoded.repaired.includes('control')) {
      ctx.report(
        'warning',
        'invalid',
        'control characters (or invalid Unicode) removed from the text',
        `${path}.data`,
      );
    }
    parts.push(
      MARKUP_TYPES.test(contentType)
        ? xhtmlToText(decoded.text)
        : normalizeWhitespace(decoded.text),
    );
  });
  const text = parts.filter((part) => part !== '').join('\n\n');
  return text === '' ? undefined : text;
}

/**
 * DocumentReference entered in error or superseded → `record.withdrawn`.
 * DocumentReference (current) → `note.received` (with the notes it
 * replaces, `relatesTo.code = replaces`). Text comes from inline
 * attachments (`attachment.data`, base64; HTML is reduced to text), else the
 * narrative, else the description. Attachments by URL are never fetched.
 */
export function mapDocumentReference(
  document: ParsedResourceOf<'DocumentReference'>,
  ctx: EntryContext,
): MappedResource | undefined {
  const patient = ctx.follow(document.subject, 'subject', ['Patient'], true);
  if (patient === undefined) {
    return undefined;
  }
  const encounterRefs = document.context?.encounter ?? [];
  const encounter = encounterRefs
    .map((reference, index) =>
      ctx.follow(reference, `context.encounter[${String(index)}]`, ['Encounter'], false),
    )
    .find((target) => target !== undefined);
  const scope = {
    patientId: patient.id,
    ...(encounter === undefined ? {} : { encounterId: encounter.id }),
  };
  // A note entered in error or superseded withdraws the plan read from it;
  // its replacement (`relatesTo` replaces) brings the plan that stands.
  if (document.status === 'entered-in-error' || document.docStatus === 'entered-in-error') {
    return withdrawal(ctx, scope, 'entered_in_error', document.meta?.lastUpdated);
  }
  if (document.status === 'superseded') {
    return withdrawal(ctx, scope, 'superseded', document.meta?.lastUpdated);
  }
  if ((document.docStatus ?? 'final') === 'preliminary') {
    ctx.report(
      'information',
      'informational',
      'only current, non-preliminary DocumentReferences produce a note event',
      'status',
    );
    return { ...scope, events: [] };
  }
  const narrative = document.text === undefined ? '' : xhtmlToText(document.text.div);
  const text =
    attachmentText(document, ctx) ??
    (narrative === '' ? undefined : narrative) ??
    document.description;
  if (text === undefined) {
    ctx.report(
      'warning',
      'incomplete',
      'DocumentReference has no inline text (attachment.data, narrative or description); no event',
      'content',
    );
    return { ...scope, events: [] };
  }
  const authoredAt = firstDate(
    document.date,
    document.context?.period?.end,
    document.context?.period?.start,
  );
  const specialty = specialtyOf(document.context?.practiceSetting);
  const replaces = (document.relatesTo ?? []).flatMap((relation, index) => {
    if (relation.code !== 'replaces') {
      return [];
    }
    const target = ctx.follow(
      relation.target,
      `relatesTo[${String(index)}].target`,
      ['DocumentReference'],
      false,
    );
    return target === undefined ? [] : [target.id];
  });
  return {
    ...scope,
    events: [
      {
        ...ctx.base('note.received', authoredAt),
        documentId: ctx.entry.ref.id,
        text,
        authoredAt: authoredAt ?? ctx.receivedAt,
        ...(specialty === undefined ? {} : { specialty }),
        ...(replaces.length === 0 ? {} : { replacesDocumentIds: replaces }),
      },
    ],
  };
}

function sectionText(sections: readonly CompositionSectionInput[] | undefined): string[] {
  return (sections ?? []).flatMap((section) => {
    const body = section.text === undefined ? '' : xhtmlToText(section.text.div);
    const own = [section.title, body].filter((part) => part !== undefined && part !== '');
    const nested = sectionText(section.section);
    const block = own.join('\n');
    return block === '' ? nested : [block, ...nested];
  });
}

/** Composition (final or amended) → `note.received` with its sections as plain text. */
export function mapComposition(
  composition: ParsedResourceOf<'Composition'>,
  ctx: EntryContext,
): MappedResource | undefined {
  const patient = ctx.follow(composition.subject, 'subject', ['Patient'], true);
  if (patient === undefined) {
    return undefined;
  }
  const encounter = ctx.follow(composition.encounter, 'encounter', ['Encounter'], false);
  const scope = {
    patientId: patient.id,
    ...(encounter === undefined ? {} : { encounterId: encounter.id }),
  };
  if (composition.status === 'entered-in-error') {
    return withdrawal(ctx, scope, 'entered_in_error', composition.meta?.lastUpdated);
  }
  if (composition.status !== 'final' && composition.status !== 'amended') {
    ctx.report(
      'information',
      'informational',
      `Composition status "${composition.status}" produces no event (needs final)`,
      'status',
    );
    return { ...scope, events: [] };
  }
  const sections = sectionText(composition.section);
  const body =
    sections.length > 0
      ? sections.join('\n\n')
      : composition.text === undefined
        ? ''
        : xhtmlToText(composition.text.div);
  if (body === '') {
    ctx.report('warning', 'incomplete', 'Composition has no section text; no event', 'section');
    return { ...scope, events: [] };
  }
  const authoredAt = firstDate(composition.date);
  return {
    ...scope,
    events: [
      {
        ...ctx.base('note.received', authoredAt),
        documentId: ctx.entry.ref.id,
        text: `${composition.title}\n\n${body}`,
        authoredAt: authoredAt ?? ctx.receivedAt,
      },
    ],
  };
}
