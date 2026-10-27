import { firstDate } from '../../support/datetime.ts';
import { decodeBase64Utf8, normalizeWhitespace, xhtmlToText } from '../../support/text.ts';
import { specialtyOf, type EntryContext, type MappedResource } from '../context.ts';
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
    const decoded = decodeBase64Utf8(attachment.data);
    if (decoded === undefined) {
      ctx.report(
        'warning',
        'value',
        'attachment data is not base64-encoded UTF-8 text',
        `${path}.data`,
      );
      return;
    }
    parts.push(
      MARKUP_TYPES.test(contentType) ? xhtmlToText(decoded) : normalizeWhitespace(decoded),
    );
  });
  const text = parts.filter((part) => part !== '').join('\n\n');
  return text === '' ? undefined : text;
}

/**
 * DocumentReference (current) → `note.received`. Text comes from inline
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
  if (document.status !== 'current' || (document.docStatus ?? 'final') === 'preliminary') {
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
  return {
    ...scope,
    events: [
      {
        ...ctx.base('note.received', authoredAt),
        documentId: ctx.entry.ref.id,
        text,
        authoredAt: authoredAt ?? ctx.receivedAt,
        ...(specialty === undefined ? {} : { specialty }),
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
