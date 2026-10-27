import { clinicId } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { createLlmGateway } from '../gateway/gateway.ts';
import { createFakeProvider, FAKE_DEFAULT_MODEL } from '../providers/fake.ts';
import type { ProviderRequest } from '../usage.ts';
import { InMemoryLlmUsageLog } from '../usage-log.ts';
import { heuristicResponder } from './heuristic-baseline.ts';
import { testGroupsIn } from './lab-tests.ts';
import { createNoteExtractor } from './note-extractor.ts';
import { postProcessExtraction } from './post-process.ts';
import { prepareNote } from './prepare.ts';
import { normalizeForMatch } from './quote.ts';
import type { ModelExtraction } from './schema.ts';

/*
 * HIP-135, QA round 3 follow-ups of the demo reader (heuristic baseline) and
 * the note masking: inbox.json #2, api-fhir.json #0, clinical.json #1,
 * security.json #0.
 */

const CLINIC = clinicId('clinic-qa3');
const AUTHORED = new Date('2026-01-05T12:00:00Z');

/** What the heuristic reader (the default demo extractor) makes of a note, through the real pipeline. */
async function read(text: string, redactTerms?: readonly string[]) {
  const seen: ProviderRequest<unknown>[] = [];
  const gateway = createLlmGateway({
    providers: {
      fake: createFakeProvider({
        respond: (request) => {
          seen.push(request);
          return heuristicResponder(request);
        },
      }),
    },
    tasks: { note_extraction: { route: [{ provider: 'fake', model: FAKE_DEFAULT_MODEL }] } },
    usageLog: new InMemoryLlmUsageLog(),
  });
  const result = await createNoteExtractor({ gateway }).extract(CLINIC, {
    documentId: 'doc',
    text,
    authoredAt: AUTHORED,
    ...(redactTerms === undefined ? {} : { redactTerms }),
  });
  const sent = seen
    .flatMap((request) => request.messages.map((message) => message.content))
    .join('\n');
  return { result, sent };
}

const day = (date: Date | undefined): string | undefined => date?.toISOString().slice(0, 10);

async function planOf(text: string) {
  const { result } = await read(text);
  return result.planItems.map((p) => [p.kind, day(p.dueAt), p.evidenceQuote]);
}

describe('the "Diabetes con plan" demo note lists each test once (inbox #2)', () => {
  const NOTE =
    'Paciente femenina de 61 años con DM2 diagnosticada hace 6 años e HTA. Refiere poliuria y cansancio. Glicemia en ayunas 186 mg/dL, HbA1c 8,9 %. PA 138/86. Se ajusta metformina a 1000 mg c/12h y se inicia sitagliptina 100 mg/día por 90 días. Plan: control en 3 meses con HbA1c; perfil lipídico y microalbuminuria antes de la próxima consulta.';

  it('no lab quote names another lab item’s test', async () => {
    const { result } = await read(NOTE);
    const labs = result.planItems.filter((item) => item.kind === 'lab');
    expect(labs.map((item) => item.description)).toEqual([
      'HbA1c',
      'lipid panel',
      'urine microalbumin',
    ]);
    for (const item of labs) {
      expect(testGroupsIn(normalizeForMatch(item.evidenceQuote), 'lab').size).toBe(1);
    }
    expect(result.planItems.map((p) => [p.kind, day(p.dueAt), p.evidenceQuote])).toEqual([
      ['lab', '2026-04-05', 'en 3 meses con HbA1c'],
      ['follow_up_visit', '2026-04-05', 'control en 3 meses'],
      ['lab', '2026-04-05', 'perfil lipídico'],
      ['lab', '2026-04-05', 'microalbuminuria antes de la próxima consulta'],
    ]);
  });
});

describe('each plan item keeps its own interval (api-fhir #0)', () => {
  it('"TSH en 6 semanas, control en 3 meses"', async () => {
    expect(
      await planOf('Paciente con hipotiroidismo.\nPlan: TSH en 6 semanas, control en 3 meses.'),
    ).toEqual([
      ['lab', '2026-02-16', 'TSH en 6 semanas'],
      ['follow_up_visit', '2026-04-05', 'control en 3 meses'],
    ]);
  });

  it('"control en 3 meses, TSH en 6 semanas"', async () => {
    expect(
      await planOf('Paciente con hipotiroidismo.\nPlan: control en 3 meses, TSH en 6 semanas.'),
    ).toEqual([
      ['lab', '2026-02-16', 'TSH en 6 semanas'],
      ['follow_up_visit', '2026-04-05', 'control en 3 meses'],
    ]);
  });

  it('"HbA1c en 1 mes y control en 3 meses"', async () => {
    expect(await planOf('Plan: HbA1c en 1 mes y control en 3 meses.')).toEqual([
      ['lab', '2026-02-05', 'HbA1c en 1 mes'],
      ['follow_up_visit', '2026-04-05', 'control en 3 meses'],
    ]);
  });

  it('a list shares the interval written after it', async () => {
    expect(await planOf('Plan: HbA1c, perfil lipídico y creatinina en 3 meses.')).toEqual([
      ['lab', '2026-04-05', 'HbA1c'],
      ['lab', '2026-04-05', 'perfil lipídico'],
      ['lab', '2026-04-05', 'creatinina en 3 meses'],
    ]);
  });

  it('tests listed after the control share its interval', async () => {
    expect(await planOf('Plan: control en 3 meses con HbA1c y perfil lipídico.')).toEqual([
      ['lab', '2026-04-05', 'en 3 meses con HbA1c'],
      ['lab', '2026-04-05', 'perfil lipídico'],
      ['follow_up_visit', '2026-04-05', 'control en 3 meses'],
    ]);
  });

  it('a short test name is quoted with its interval', async () => {
    expect(await planOf('Plan: control en 3 meses; TSH y T4 en 6 semanas.')).toEqual([
      ['follow_up_visit', '2026-04-05', 'control en 3 meses'],
      ['lab', '2026-02-16', 'TSH y T4 en 6 semanas'],
    ]);
  });
});

describe('frequency words and suspended controls (clinical #1)', () => {
  it.each([
    ['Paciente sano. Control anual.', '2027-01-05', 'Control anual'],
    ['Evolucion favorable. Control semestral.', '2026-07-05', 'Control semestral'],
    ['Estable. control trimestral.', '2026-04-05', 'control trimestral'],
    ['Estable. control mensual.', '2026-02-05', 'control mensual'],
  ])('%s', async (note, due, quote) => {
    expect(await planOf(note)).toEqual([['follow_up_visit', due, quote]]);
  });

  it('"Control anual." alone is a plan', async () => {
    const { result } = await read('Control anual.');
    expect(result.hasPlan).toBe(true);
    expect(result.planItems).toHaveLength(1);
  });

  it('a suspended control is not scheduled', async () => {
    expect(
      await planOf('Se suspende el control en 1 mes que estaba previsto; control en 6 meses.'),
    ).toEqual([['follow_up_visit', '2026-07-05', 'control en 6 meses']]);
    expect(await planOf('Paciente estable, sin control por ahora.')).toEqual([]);
    expect(await planOf('El control en 1 mes queda suspendido.')).toEqual([]);
  });

  it('suspending a drug does not suspend the control next to it', async () => {
    expect(await planOf('Se suspende metformina, control en 3 meses.')).toEqual([
      ['follow_up_visit', '2026-04-05', 'control en 3 meses'],
    ]);
  });

  it('a frequency word on a medication is not a plan item', async () => {
    expect(await planOf('Vitamina D 50000 UI mensual. Sin otros cambios.')).toEqual([]);
  });

  it('a model item quoting a suspended control is dropped', () => {
    const model: ModelExtraction = {
      hasPlan: true,
      discharge: null,
      conditions: [],
      medications: [],
      planItems: [
        {
          kind: 'follow_up_visit',
          description: 'follow-up visit',
          timing: { amount: 1, unit: 'month', date: null },
          loincCode: null,
          evidenceQuote: 'control en 1 mes',
          confidence: 0.9,
        },
      ],
    };
    const out = postProcessExtraction(model, {
      text: 'Se suspende el control en 1 mes que estaba previsto.',
      authoredAt: AUTHORED,
    });
    expect(out.planItems).toEqual([]);
    expect(out.rejected.map((r) => r.reason)).toEqual(['cancelled']);
  });
});

describe('identifiers written with comma group separators are masked (security #0)', () => {
  it('"C.I. 12,345,678" for V-12.345.678', async () => {
    const { result, sent } = await read(
      'Paciente C.I. 12,345,678 con DM2. Plan: Control en 3 meses.',
      ['Zacarías Marcadorapellido', 'V-12.345.678', '+58 412 555 1234'],
    );
    expect(sent).not.toContain('12,345,678');
    expect(sent).toContain('C.I. [REDACTADO] con DM2');
    expect(result.warnings).toContain('names_masked');
  });

  it('decimal doses with a comma stay', () => {
    const prepared = prepareNote(
      'Bisoprolol 2,5 mg c/24h, levotiroxina 12,5 mcg. C.I. 12,345,678. Peso 12,345 kg.',
      { redactTerms: ['V-12.345.678'] },
    );
    expect(prepared.text).toBe(
      'Bisoprolol 2,5 mg c/24h, levotiroxina 12,5 mcg. C.I. [REDACTADO]. Peso 12,345 kg.',
    );
  });
});
