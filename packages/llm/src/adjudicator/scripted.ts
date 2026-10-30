import type { AdjudicationDecision, AdjudicationInput } from '@follow-up-engine/core';
import type { FakeResponder } from '../providers/fake.ts';
import type { ProviderRequest } from '../usage.ts';
import { ADJUDICATION_OUTPUT_NAME, type AdjudicationOutput } from './prompt.ts';

/** Model id of the scripted adjudicator on the fake provider. */
export const FAKE_ADJUDICATOR_MODEL = 'fake-adjudicator';

type MaskedInput = Omit<AdjudicationInput, 'noteText'> & { readonly note: string };

function parseInput(content: string): MaskedInput | undefined {
  const match = /<adjudication_input>([\s\S]*)<\/adjudication_input>/.exec(content);
  if (match?.[1] === undefined) return undefined;
  try {
    return JSON.parse(match[1]) as MaskedInput;
  } catch {
    return undefined;
  }
}

/** Lowercase, no accents, one UTF-16 unit per unit (so positions in the folded text are positions in the note). */
function fold(text: string): string {
  return text
    .split('')
    .map((char) => char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().charAt(0) || char)
    .join('');
}

interface Cue {
  readonly code: AdjudicationOutput['reasonCodes'][number];
  readonly pattern: RegExp;
}

const DISCARD_CUES: readonly Cue[] = [
  {
    code: 'negated',
    pattern:
      /\bno (requiere|amerita|necesita|es necesari[oa]|hace falta|se solicita|se indica)\b|\bsin necesidad de\b|\bse suspende\b|\bdescartad[oa]\b|\bnot (needed|required)\b/,
  },
  {
    code: 'already_done',
    pattern:
      /\bya (se )?(realiz|tom|hizo|tiene|trae|cuenta|fue)|\b(trae|aporta) (resultado|reporte)s?\b|\bresultados? (ya )?(disponibles?|recibidos?)\b|\balready (done|available)\b/,
  },
  { code: 'patient_declined', pattern: /\b(rechaza|no desea|se niega|declina|no acepta)\b/ },
  {
    code: 'deferred_to_other_provider',
    pattern:
      /\b(con|por) su (medico|cardiologo|ginecologo|endocrinologo|especialista) (tratante|de cabecera|externo|habitual)\b|\ben otr[oa] (centro|clinica|institucion)\b|\blo (hara|realizara|controlara) (su|el) (medico|especialista)\b/,
  },
];

const DOUBT_CUES: readonly Cue[] = [
  {
    code: 'conditional_plan',
    pattern:
      /\bsi (persiste|persisten|empeora|no mejora|aparece|aparecen|presenta|hay)\b|\bsegun (evolucion|respuesta|resultados?)\b|\ben caso de\b|\bde ser necesario\b|\bsolo si\b|\bif (needed|symptoms)\b/,
  },
  {
    code: 'hypothetical_mention',
    pattern: /\b(evaluar|considerar|valorar|eventual(mente)?|plantear|posible|quizas|tal vez)\b/,
  },
];

const VAGUE_TIMING = /\b(mas adelante|proximamente|a futuro|en algun momento|luego)\b/;
const EXPLICIT_INSTRUCTION =
  /\b(control|controles|solicito|se solicita|se indica|indico|repetir|repite|cita|citar|reevaluar|seguimiento|pido|ordeno|sesion|proxima sesion)\b/;
const EXPLICIT_TIMING =
  /\b(en|dentro de|a los|cada) \d+ ?(dias?|semanas?|mes(es)?|anos?)\b|\b\d+ ?(dias?|semanas?|mes(es)?)\b|\b(en|dentro de) (un|una|dos|tres|cuatro|seis) (dias?|semanas?|mes(es)?|ano)\b/;

/** The sentence of `note` around `[start, end)`, verbatim (bounded by `.`, `;` or a line break). */
function sentenceAround(note: string, start: number, end: number): string {
  let from = start;
  while (from > 0 && !/[.;\n]/.test(note.charAt(from - 1))) from -= 1;
  let to = end;
  while (to < note.length && !/[.;\n]/.test(note.charAt(to))) to += 1;
  return note.slice(from, to).trim();
}

function output(
  decision: AdjudicationDecision,
  probability: number,
  reasonCodes: AdjudicationOutput['reasonCodes'],
  quote: string,
  rationale: { en: string; es: string },
): AdjudicationOutput {
  return {
    decision,
    probability,
    reasonCodes,
    rationaleEn: rationale.en,
    rationaleEs: rationale.es,
    quotes: quote === '' ? [] : [quote],
  };
}

/**
 * The decision the scripted adjudicator makes, from cue words in the
 * sentence that holds the item's quote: a negation, "already done", a
 * declined or deferred item is `discard`; a conditional or hypothetical one
 * is `needs_human`; an explicit instruction with its timing is `open`;
 * anything else is `needs_human`. It quotes that sentence verbatim.
 */
export function scriptedAdjudication(input: MaskedInput): AdjudicationOutput {
  const note = input.note;
  const folded = fold(note);
  const wanted = fold(input.evidenceQuote.trim());
  const at = wanted === '' ? -1 : folded.indexOf(wanted);
  const sentence = at < 0 ? '' : sentenceAround(note, at, at + wanted.length);
  const context = fold(sentence === '' ? input.evidenceQuote : sentence);
  const quote = sentence === '' ? input.evidenceQuote : sentence;

  for (const cue of DISCARD_CUES) {
    if (cue.pattern.test(context)) {
      return output('discard', 0.12, [cue.code], quote, {
        en: 'The note mentions the item but says it is not needed, already done, declined or handled elsewhere.',
        es: 'La nota menciona el ítem, pero dice que no hace falta, que ya se hizo, que se rechazó o que lo lleva otro profesional.',
      });
    }
  }
  for (const cue of DOUBT_CUES) {
    if (cue.pattern.test(context)) {
      return output('needs_human', 0.45, [cue.code], quote, {
        en: 'The note only asks for it under a condition or as a possibility: a doctor should decide.',
        es: 'La nota solo lo pide bajo una condición o como posibilidad: conviene que lo decida un médico.',
      });
    }
  }
  const explicit = EXPLICIT_INSTRUCTION.test(context);
  if (explicit && EXPLICIT_TIMING.test(context)) {
    return output('open', 0.86, ['explicit_instruction', 'timing_explicit'], quote, {
      en: 'The note gives the instruction and its timing plainly.',
      es: 'La nota da la indicación y su plazo de forma explícita.',
    });
  }
  if (explicit && VAGUE_TIMING.test(context)) {
    return output('needs_human', 0.55, ['explicit_instruction', 'timing_vague'], quote, {
      en: 'The note asks for it, but its timing is vague.',
      es: 'La nota lo pide, pero el plazo es impreciso.',
    });
  }
  if (explicit) {
    return output('open', 0.74, ['explicit_instruction'], quote, {
      en: 'The note gives the instruction plainly.',
      es: 'La nota da la indicación de forma explícita.',
    });
  }
  return output('needs_human', 0.5, ['insufficient_context'], quote, {
    en: 'The note does not say enough to decide.',
    es: 'La nota no dice lo suficiente para decidir.',
  });
}

/**
 * A deterministic stand-in for the adjudicating model, for CI, the eval
 * baseline and the key-less demo. It speaks the real protocol through the
 * real gateway (masked input in, the same structured output out) and
 * decides from cue words; what it shows is the protocol, the engine's checks
 * and the flow, not clinical judgment.
 */
export const scriptedAdjudicatorResponder: FakeResponder = (request: ProviderRequest<unknown>) => {
  if (request.output.name !== ADJUDICATION_OUTPUT_NAME) return undefined;
  const input = request.messages
    .map((message) => (message.role === 'user' ? parseInput(message.content) : undefined))
    .find((parsed) => parsed !== undefined);
  if (input === undefined) {
    return output('needs_human', 0.5, ['insufficient_context'], '', {
      en: 'No input.',
      es: 'Sin datos.',
    });
  }
  return scriptedAdjudication(input);
};
