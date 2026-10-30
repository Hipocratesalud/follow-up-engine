import type { ProtocolStatus } from '@follow-up-engine/core';
import type { ApiLocale } from '../i18n/index.ts';
import type { ItemSection, SignoffPageData, SignoffTestRef } from './model.ts';

/** Section headings and fixed labels, in both languages. Everything else on the page is generated from config or the catalog. */
const T: Readonly<
  Record<
    ApiLocale,
    {
      readonly titleSuffix: string;
      readonly status: string;
      /** The protocol's own `status` field (config), so this line can never drift from it. */
      readonly statusValue: Readonly<Record<ProtocolStatus, string>>;
      readonly protocolId: string;
      readonly version: string;
      readonly intro: (file: string) => string;
      readonly whoHeading: string;
      readonly whatHeading: string;
      readonly tableHeaders: readonly [string, string, string, string, string, string];
      readonly evidence: string;
      readonly planTermsLabel: string;
      readonly sharedWithLabel: (names: string) => string;
      readonly exceptionsHeading: string;
      readonly notApplicableHeading: string;
      readonly signoffHeading: string;
      readonly signoffIntro: string;
      readonly signoffTableHeaders: readonly [string, string, string, string];
      readonly approve: string;
      readonly changes: string;
      readonly nameLabel: string;
      readonly dateLabel: string;
      readonly signatureLabel: string;
      readonly overallLabel: string;
      readonly appendixHeading: string;
      readonly appendixIntro: string;
      readonly appendixHeaders: readonly [string, string, string, string];
      readonly firesLabel: string;
      readonly suppressedByLabel: string;
      readonly none: string;
    }
  >
> = {
  en: {
    titleSuffix: 'clinical sign-off package',
    status: 'Status',
    statusValue: {
      draft: 'Draft — no sign-off package yet, not validated by the clinic’s clinical team',
      ready_for_signoff: 'Ready for sign-off — not yet validated by the clinic’s clinical team',
      validated: 'Validated by the clinic’s clinical team',
    },
    protocolId: 'Protocol id',
    version: 'Version',
    intro: (file) =>
      `This page is generated from \`${file}\` (and, for a shared test, from the other ` +
      'protocol file named below) plus the engine’s reason-and-action catalog ' +
      '(`apps/api/src/i18n`). Regenerate it with `pnpm protocols:signoff` after changing ' +
      'either; `pnpm test` fails if a committed page no longer matches a fresh generation. ' +
      'Nothing on this page is free text: every number, code and citation below is read ' +
      'back from config, so it cannot say something the engine does not do.',
    whoHeading: 'Who this protocol applies to',
    whatHeading: 'What is expected, and how often',
    tableHeaders: ['#', 'Item', 'Expected', 'How often', 'Due date rule', 'Guideline'],
    evidence: 'Accepted evidence (codes the engine treats as fulfilling this item)',
    planTermsLabel: 'Also covered by an uncoded plan item whose quote names',
    sharedWithLabel: (names) =>
      `Shares this test with: ${names}. One test, one expectation — see Exceptions below.`,
    exceptionsHeading: 'Exceptions and suppressions',
    notApplicableHeading: 'Not declared for this protocol',
    signoffHeading: 'Sign-off',
    signoffIntro:
      'One row per point above. A point not approved keeps running as written until a new ' +
      'version of the config file changes it — this page does not change behavior by itself.',
    signoffTableHeaders: ['Item', 'Approve', 'Needs changes', 'Comment'],
    approve: '☐ Approve',
    changes: '☐ Needs changes',
    nameLabel: 'Physician name',
    dateLabel: 'Date',
    signatureLabel: 'Signature',
    overallLabel: 'Overall protocol decision',
    appendixHeading: 'Appendix: point → test',
    appendixIntro:
      'Generated from `tests.ts`; `generate.test.ts` fails if a title below is not the exact ' +
      'name of a test in the file it cites.',
    appendixHeaders: ['Item', 'Reason code', 'Fires (correct due date)', 'Suppressed by'],
    firesLabel: 'Fires',
    suppressedByLabel: 'Suppressed by',
    none: '—',
  },
  es: {
    titleSuffix: 'paquete de aval clínico',
    status: 'Estado',
    statusValue: {
      draft:
        'Borrador — sin paquete de aval todavía, sin validar por el equipo clínico del consultorio',
      ready_for_signoff:
        'Listo para aval médico — aún sin validar por el equipo clínico del consultorio',
      validated: 'Validado por el equipo clínico del consultorio',
    },
    protocolId: 'Id del protocolo',
    version: 'Versión',
    intro: (file) =>
      `Esta página se genera a partir de \`${file}\` (y, cuando comparte una prueba, del otro ` +
      'archivo de protocolo que se nombra abajo) y del catálogo de motivos y acciones del ' +
      'motor (`apps/api/src/i18n`). Se regenera con `pnpm protocols:signoff` después de ' +
      'cambiar cualquiera de los dos; `pnpm test` falla si una página ya guardada deja de ' +
      'coincidir con una generación nueva. Nada en esta página es texto libre: cada número, ' +
      'código y cita de abajo se lee de la configuración, así que no puede decir algo que el ' +
      'motor no hace.',
    whoHeading: 'A quién aplica este protocolo',
    whatHeading: 'Qué se espera, y con qué frecuencia',
    tableHeaders: [
      '#',
      'Punto',
      'Qué se espera',
      'Con qué frecuencia',
      'Regla de vencimiento',
      'Guía',
    ],
    evidence: 'Evidencia aceptada (códigos que el motor trata como cumplimiento de este punto)',
    planTermsLabel: 'También lo cubre un punto del plan sin código cuya cita nombra',
    sharedWithLabel: (names) =>
      `Comparte esta prueba con: ${names}. Una prueba, una expectativa — ver Excepciones abajo.`,
    exceptionsHeading: 'Excepciones y supresiones',
    notApplicableHeading: 'No declarado para este protocolo',
    signoffHeading: 'Aval',
    signoffIntro:
      'Una fila por cada punto de arriba. Un punto sin aprobar sigue funcionando tal como está ' +
      'escrito hasta que una nueva versión del archivo de configuración lo cambie — esta ' +
      'página no cambia el comportamiento por sí sola.',
    signoffTableHeaders: ['Punto', 'Aprobar', 'Necesita cambios', 'Comentario'],
    approve: '☐ Aprobar',
    changes: '☐ Necesita cambios',
    nameLabel: 'Nombre del médico',
    dateLabel: 'Fecha',
    signatureLabel: 'Firma',
    overallLabel: 'Decisión general del protocolo',
    appendixHeading: 'Apéndice: punto → prueba',
    appendixIntro:
      'Generado a partir de `tests.ts`; `generate.test.ts` falla si un título de abajo no es ' +
      'el nombre exacto de una prueba en el archivo que cita.',
    appendixHeaders: ['Punto', 'Código de motivo', 'Se activa (fecha correcta)', 'Se suprime con'],
    firesLabel: 'Se activa',
    suppressedByLabel: 'Se suprime con',
    none: '—',
  },
};

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

function testCitation(test: SignoffTestRef): string {
  return `\`${test.file}\` › ${escapeCell(test.describe)} › ${escapeCell(test.it)}`;
}

function itemRow(locale: ApiLocale, index: number, item: ItemSection): string {
  const t = T[locale];
  const detail: string[] = [`**${item.expected}**`, item.why];
  if (item.evidenceCodes.length > 0) {
    detail.push(`${t.evidence}: ${item.evidenceCodes.join(', ')}`);
  }
  if (item.planTerms.length > 0) {
    detail.push(`${t.planTermsLabel}: ${item.planTerms.join(', ')}`);
  }
  if (item.sharedWith.length > 0) {
    detail.push(
      t.sharedWithLabel(
        item.sharedWith.map((ref) => `${ref.protocolName} (\`${ref.itemKey}\`)`).join(', '),
      ),
    );
  }
  return `| ${String(index)} | \`${item.key}\` | ${escapeCell(detail.join('<br>'))} | ${escapeCell(item.howOften)} | ${escapeCell(item.dueRule)} | ${escapeCell(item.guideline)} |`;
}

/** Renders one protocol's sign-off page, in `locale`. Deterministic: no clocks, no randomness. */
export function renderSignoffPage(locale: ApiLocale, data: SignoffPageData): string {
  const t = T[locale];
  const lines: string[] = [];
  lines.push(`# ${data.name} — ${t.titleSuffix}`, '');
  lines.push(
    `**${t.status}:** ${t.statusValue[data.protocol.status]}`,
    '',
    `**${t.protocolId}:** \`${data.protocol.id}\` · **${t.version}:** \`${data.protocol.version}\``,
    '',
  );
  lines.push(t.intro(`config/protocols/${data.protocol.id.replace(/_/g, '-')}.json`), '');
  lines.push(`## ${t.whoHeading}`, '');
  for (const bullet of data.enrollment) {
    lines.push(`- ${bullet}`);
  }
  lines.push('');
  lines.push(`## ${t.whatHeading}`, '');
  lines.push(
    `| ${t.tableHeaders.join(' | ')} |`,
    `|${t.tableHeaders.map(() => ' --- ').join('|')}|`,
  );
  data.items.forEach((item, index) => {
    lines.push(itemRow(locale, index + 1, item));
  });
  lines.push('');
  lines.push(`## ${t.exceptionsHeading}`, '');
  for (const exception of data.exceptions) {
    lines.push(`### ${exception.title}`, '', exception.body, '');
  }
  if (data.notApplicable.length > 0) {
    lines.push(`### ${t.notApplicableHeading}`, '');
    for (const fact of data.notApplicable) {
      lines.push(`- ${fact}`);
    }
    lines.push('');
  }
  lines.push(`## ${t.signoffHeading}`, '');
  lines.push(t.signoffIntro, '');
  lines.push(
    `| ${t.signoffTableHeaders.join(' | ')} |`,
    `|${t.signoffTableHeaders.map(() => ' --- ').join('|')}|`,
  );
  for (const item of data.items) {
    lines.push(
      `| \`${item.key}\` — ${escapeCell(item.expected)} | ${t.approve} | ${t.changes} | |`,
    );
  }
  lines.push('');
  lines.push(`**${t.overallLabel}:** ${t.approve} ${t.changes}`, '');
  lines.push(
    `**${t.nameLabel}:** `,
    '',
    `**${t.dateLabel}:** `,
    '',
    `**${t.signatureLabel}:** `,
    '',
  );
  lines.push(`## ${t.appendixHeading}`, '');
  lines.push(t.appendixIntro, '');
  lines.push(
    `| ${t.appendixHeaders.join(' | ')} |`,
    `|${t.appendixHeaders.map(() => ' --- ').join('|')}|`,
  );
  for (const entry of data.appendix) {
    const suppressedBy =
      entry.exceptionTests.length === 0
        ? t.none
        : entry.exceptionTests
            .map((exception) => `${exception.id}: ${testCitation(exception.test)}`)
            .join('<br>');
    lines.push(
      `| \`${entry.key}\` | \`${entry.ruleId}\` | ${testCitation(entry.firesTest)} | ${suppressedBy} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
