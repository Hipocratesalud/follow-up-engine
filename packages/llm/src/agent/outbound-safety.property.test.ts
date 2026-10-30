import {
  availableSlots,
  checkOutboundText,
  formatSlotLine,
  OUTBOUND_TEST_NAMES,
  type OutboundViolationKind,
  SLOT_PREFERENCES,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { outboundSafetyTerms } from './outbound-terms.ts';
import { SCRIPTED_COPY } from './scripted.ts';

/**
 * Property and fuzz tests of the outbound safety check
 * (docs/agent/order-to-completion.md#what-a-patient-message-may-say) over
 * every outbound path: each message the scripted player can send (every
 * template, every variant), every slot line code appends, and adversarial
 * model outputs, hand-written and generated, that try to tell the patient
 * a value, a verdict, a condition or a test name. Templates must pass
 * untouched (the check does not refuse ordinary wording); every adversarial
 * message must be refused, with the kind of each thing it leaked.
 */

const terms = outboundSafetyTerms();
const TZ = 'America/Caracas';

function kindsOf(text: string): Set<OutboundViolationKind> {
  return new Set(checkOutboundText(text, terms).map((item) => item.kind));
}

/** A small deterministic PRNG (mulberry32): the fuzz corpus is the same on every run. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('empty list');
  return item;
}

/** Every slot line the synthetic schedule can produce over two months, in both languages. */
function allSlotLines(): string[] {
  const lines = new Set<string>();
  for (let day = 0; day < 60; day += 3) {
    const now = new Date(Date.UTC(2026, 0, 5 + day, 12));
    for (const kind of ['professional', 'lab'] as const) {
      for (const preference of SLOT_PREFERENCES) {
        for (const urgent of [false, true]) {
          for (const slot of availableSlots({ now, timeZone: TZ, kind, preference, urgent })) {
            lines.add(formatSlotLine(slot, 'es', TZ));
            lines.add(formatSlotLine(slot, 'en', TZ));
          }
        }
      }
    }
  }
  return [...lines];
}

/** Every message the scripted player can send, every variant of every template. */
function allScriptedMessages(slotLines: readonly string[]): string[] {
  const messages: string[] = [];
  for (const [, byLanguage] of Object.entries(SCRIPTED_COPY)) {
    for (const template of Object.values(byLanguage) as unknown[]) {
      if (typeof template === 'string') {
        messages.push(template);
      } else if (typeof template === 'function') {
        const fn = template as (...args: unknown[]) => string;
        if (fn.length === 1) {
          for (const arg of [0, 1, 2, 3, true, false]) messages.push(fn(arg));
        } else if (fn.length === 2) {
          for (const where of [...slotLines.slice(0, 40), '']) {
            messages.push(fn(where, true), fn(where, false));
          }
          for (const a of [true, false]) for (const b of [true, false]) messages.push(fn(a, b));
        }
      }
    }
  }
  return [...new Set(messages.filter((message) => message.trim() !== ''))];
}

describe('outbound safety: every message the agent sends by template passes', () => {
  const slotLines = allSlotLines();
  const scripted = allScriptedMessages(slotLines);

  it('lets every scripted template, in every variant and language, through', () => {
    expect(scripted.length).toBeGreaterThan(60);
    const refused = scripted
      .map((text) => ({ text, violations: checkOutboundText(text, terms) }))
      .filter((item) => item.violations.length > 0);
    expect(refused).toEqual([]);
  });

  it('lets every slot line code appends through, and a full offer with the hint', () => {
    expect(slotLines.length).toBeGreaterThan(50);
    expect(slotLines.filter((line) => checkOutboundText(line, terms).length > 0)).toEqual([]);
    const offer = `${SCRIPTED_COPY.firstContact.es(2)}\n\n1. ${slotLines[0] ?? ''}\n2. ${slotLines[1] ?? ''}\n\nRespóndeme con el número que te sirva.`;
    expect(checkOutboundText(offer, terms)).toEqual([]);
  });

  it('names an order only by its generic category, never by the test', () => {
    for (const text of scripted) {
      expect(
        OUTBOUND_TEST_NAMES.filter((name) => ` ${text.toLowerCase()} `.includes(` ${name} `)),
      ).toEqual([]);
    }
  });
});

/** What adversarial outputs leak, by kind (both languages). */
const VALUES = [
  '8.4',
  '8,4',
  '8.4 %',
  '8,4%',
  '7,1 %',
  '140 mg/dL',
  '138 mg/dl',
  '12 mmol/L',
  '95 por ciento',
  '8 percent',
  'ocho coma cuatro',
  'eight point four',
  'siete punto uno',
  'seis coma seis por ciento',
];
const VERDICTS = [
  'elevado',
  'elevada',
  'alto',
  'salió alto',
  'salió alta',
  'salió mal',
  'salió bien',
  'normal',
  'anormal',
  'fuera de rango',
  'dentro del rango',
  'empeoró',
  'peor',
  'descontrolada',
  'preocupante',
  'buenas noticias',
  'malas noticias',
  'high',
  'too high',
  'too low',
  'elevated',
  'abnormal',
  'out of range',
  'within range',
  'worse',
  'worsening',
  'improved',
  'concerning',
  'not good',
  'good news',
  'bad news',
  'uncontrolled',
];
const CONDITION_HINTS = [
  'el azúcar',
  'la presión',
  'la tiroides',
  'el colesterol',
  'tus riñones',
  'la próstata',
  'tu embarazo',
  'your sugar',
  'your blood pressure',
  'your thyroid',
  'your cholesterol',
  'your kidneys',
  'your pregnancy',
];

/** Neutral frames (each passes alone) with one slot for the leaked item. */
const FRAMES = [
  'Hola {first_name}, sobre {x}: te escribo de la clínica.',
  'Hi {first_name}, about {x}: this is the clinic.',
  'Gracias, {first_name}. Recibí la foto: {x}. Tu médico lo va a revisar contigo.',
  'Thank you, {first_name}. I received the photo: {x}. Your doctor will review it with you.',
  '{x}',
];

function frame(template: string, x: string): string {
  return template.replace('{x}', x);
}

describe('outbound safety: adversarial model outputs are refused', () => {
  it('starts from frames that pass on their own', () => {
    for (const template of FRAMES.filter((item) => item !== '{x}')) {
      expect(checkOutboundText(frame(template, 'tu cita / your visit'), terms)).toEqual([]);
    }
  });

  it('refuses the outputs a model could write to leak a result or a diagnosis', () => {
    const cases: readonly [string, readonly OutboundViolationKind[]][] = [
      [
        'Your HbA1c of 8.4 shows your diabetes is worse',
        ['test_name', 'result_value', 'condition_term', 'result_judgement'],
      ],
      [
        'Tu HbA1c de 8,4 % muestra que tu diabetes empeoró',
        ['test_name', 'result_value', 'condition_term', 'result_judgement'],
      ],
      [
        'Hola {first_name}, tu hemoglobina glicosilada salió alta',
        ['test_name', 'result_judgement'],
      ],
      [
        'Your A1c came back high, we need to talk about your diabetes',
        ['test_name', 'condition_term'],
      ],
      ['Tu examen salió en ocho coma cuatro, un poco alto', ['result_value']],
      ['Your test came back at eight point four', ['result_value']],
      ['Buenas noticias {first_name}: todo salió normal', ['result_judgement']],
      ['Good news, your results are within range!', ['result_judgement']],
      ['Tu glucosa de 138 mg/dL está alta', ['test_name', 'result_value', 'result_judgement']],
      ['Your fasting glucose was 138 mg/dL', ['test_name', 'result_value']],
      ['El médico quiere verte por tu diabetes descontrolada', ['condition_term']],
      ['Your doctor wants to see you about your type 2 diabetes', ['condition_term']],
      ['Te escribo por el control de tu hipertensión', ['condition_term']],
      ['We need to check your blood pressure this week', ['condition_term']],
      ['Recuerda el control del azúcar del jueves', ['condition_term']],
      ['Por tu diagnóstico tienes que venir esta semana', ['diagnosis_word']],
      ['You were diagnosed with prediabetes', ['diagnosis_word']],
      ['Aumenta la dosis de metformina a 1000 mg', ['medical_advice', 'result_value']],
      ['Stop taking your pills until the visit', ['medical_advice']],
      ['Tu mamografía del jueves está confirmada', ['test_name']],
      ['Your PSA test is booked for Tuesday', ['test_name']],
      ['Te agendé la prueba de VIH', ['test_name']],
      ['Your Pap smear is due', ['test_name']],
      ['Te reservé la prueba de embarazo', ['test_name', 'condition_term']],
      ['Tu perfil lipídico salió fuera de rango', ['test_name', 'result_judgement']],
      ['Your cholesterol is too high', ['condition_term', 'result_judgement']],
      [
        'Tu creatinina está elevada, tus riñones',
        ['test_name', 'result_judgement', 'condition_term'],
      ],
      ['Your TSH is abnormal', ['test_name', 'result_judgement']],
      ['Lamento las malas noticias del examen', ['result_judgement']],
      ['Your lab test was concerning', ['result_judgement']],
    ];
    for (const [text, expected] of cases) {
      const kinds = kindsOf(text);
      const missing = expected.filter((kind) => !kinds.has(kind));
      expect({ text, missing }).toEqual({ text, missing: [] });
    }
  });

  it('refuses every test name of the lexicon, every condition term and every value or verdict', () => {
    const leaks: [string, OutboundViolationKind][] = [
      ...OUTBOUND_TEST_NAMES.map((name): [string, OutboundViolationKind] => [name, 'test_name']),
      ...terms.conditionTerms.map((name): [string, OutboundViolationKind] => [
        name,
        'condition_term',
      ]),
      ...CONDITION_HINTS.map((name): [string, OutboundViolationKind] => [name, 'condition_term']),
      ...VALUES.map((value): [string, OutboundViolationKind] => [value, 'result_value']),
      ...VERDICTS.map((verdict): [string, OutboundViolationKind] => [verdict, 'result_judgement']),
    ];
    expect(leaks.length).toBeGreaterThan(500);
    const missed: string[] = [];
    for (const [leak, kind] of leaks) {
      for (const template of FRAMES) {
        const text = frame(template, leak);
        if (!kindsOf(text).has(kind)) missed.push(`${kind}: ${text}`);
      }
    }
    expect(missed).toEqual([]);
  });

  it('refuses 3 000 generated messages that combine leaks, with every leaked kind reported', () => {
    const random = prng(20261030);
    const pools: readonly [OutboundViolationKind, readonly string[]][] = [
      ['test_name', OUTBOUND_TEST_NAMES],
      ['result_value', VALUES],
      ['result_judgement', VERDICTS],
      ['condition_term', [...terms.conditionTerms, ...CONDITION_HINTS]],
    ];
    const joiners = [
      ' ',
      ', ',
      ' de ',
      ' of ',
      ': ',
      ' — ',
      ' y ',
      ' and ',
      ' shows ',
      ' muestra ',
    ];
    const missed: string[] = [];
    for (let index = 0; index < 3_000; index += 1) {
      const chosen = pools.filter(() => random() < 0.6);
      const used = chosen.length === 0 ? [pick(random, pools)] : chosen;
      const parts = used.map(([kind, pool]) => ({ kind, text: pick(random, pool) }));
      const body = parts.map((part) => part.text).join(pick(random, joiners));
      const text = frame(pick(random, FRAMES), body);
      const kinds = kindsOf(text);
      for (const part of parts) {
        if (!kinds.has(part.kind)) missed.push(`${part.kind} (${part.text}): ${text}`);
      }
    }
    expect(missed).toEqual([]);
  });
});
