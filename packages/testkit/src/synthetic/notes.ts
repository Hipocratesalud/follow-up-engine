import type { ConditionDefinition, MedicationDefinition, OrderDefinition } from './catalog.ts';
import type { Prng } from './prng.ts';

/**
 * Spanish progress notes written the way Latin American clinicians write
 * them: abbreviations (Pcte, DM2, HTA, TA, c/12h, VO, Dx, ctrl), mixed
 * structures (free text, SOAP, telegraphic) and some mess. Psychology notes
 * stay clinical and neutral: no crisis content.
 */

export interface FollowUp {
  readonly amount: number;
  readonly unit: 'días' | 'semanas' | 'meses';
}

export function followUpDays(followUp: FollowUp): number {
  switch (followUp.unit) {
    case 'días':
      return followUp.amount;
    case 'semanas':
      return followUp.amount * 7;
    case 'meses':
      return followUp.amount * 30;
  }
}

function amountText(followUp: FollowUp): string {
  if (followUp.amount === 1) {
    return followUp.unit === 'meses' ? '1 mes' : followUp.unit === 'semanas' ? '1 semana' : '1 día';
  }
  return `${String(followUp.amount)} ${followUp.unit}`;
}

function visitPhrase(rng: Prng, followUp: FollowUp): string {
  const amount = amountText(followUp);
  const short = amount.replace('semanas', 'sem').replace('semana', 'sem');
  return rng.pick([
    `Ctrl en ${amount}`,
    `ctrl en ${short}`,
    `Cita control en ${amount}`,
    `Control en ${amount}`,
    `Próximo control en ${amount}`,
    `Volver a consulta en ${amount}`,
    `cita control en ${short}`,
  ]);
}

function sessionPhrase(rng: Prng, followUp: FollowUp): string {
  const amount = amountText(followUp);
  return rng.pick([
    `Próx. sesión en ${amount}`,
    `Próxima sesión en ${amount}`,
    `Se acuerda próxima sesión en ${amount}`,
    `prox. sesion en ${amount}`,
  ]);
}

const ACCENTS: Record<string, string> = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u' };

/** Applies typing mess some clinicians leave in their notes: no accents, lowercase, one block. */
function roughen(rng: Prng, text: string): string {
  let out = text;
  if (rng.chance(0.35)) out = out.replace(/[áéíóú]/g, (char) => ACCENTS[char] ?? char);
  if (rng.chance(0.3)) out = out.replace(/\n+/g, ' ').replace(/ {2,}/g, ' ');
  if (rng.chance(0.25)) out = out.charAt(0).toLowerCase() + out.slice(1);
  return out;
}

/** Picks the masculine or feminine form of an adjective. */
function gendered(sex: 'female' | 'male', masculine: string, feminine: string): string {
  return sex === 'female' ? feminine : masculine;
}

function sexWord(rng: Prng, sex: 'female' | 'male'): string {
  return sex === 'female'
    ? rng.pick(['fem', 'femenina', 'F'])
    : rng.pick(['masc', 'masculino', 'M']);
}

function patientIntro(rng: Prng, sex: 'female' | 'male', age: number): string {
  return rng.pick([
    `Pcte ${sexWord(rng, sex)} ${String(age)}a`,
    `Pcte de ${String(age)} años`,
    `Paciente ${sex === 'female' ? 'femenina' : 'masculino'} de ${String(age)} años`,
    `${sex === 'female' ? 'Fem' : 'Masc'} ${String(age)} años`,
  ]);
}

function medLine(medication: MedicationDefinition): string {
  const dosage = medication.dosage.replace('1 tab ', '').replace('1 cáps ', '');
  const base = `${medication.text.toLowerCase()} ${dosage}`;
  return medication.durationDays === undefined
    ? base
    : `${base} x ${String(medication.durationDays)} días`;
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1] ?? ''}`;
}

function bp(rng: Prng, controlled: boolean): string {
  const systolic = controlled ? rng.int(112, 134) : rng.int(142, 168);
  const diastolic = controlled ? rng.int(70, 84) : rng.int(88, 102);
  return `${String(systolic)}/${String(diastolic)}`;
}

export interface ChronicNoteInput {
  readonly rng: Prng;
  readonly sex: 'female' | 'male';
  readonly age: number;
  readonly firstVisit: boolean;
  readonly yearsSinceDiagnosis: number;
  readonly conditions: readonly ConditionDefinition[];
  readonly medications: readonly MedicationDefinition[];
  readonly orders: readonly OrderDefinition[];
  /** Orders from the previous visit that never came back and are re-ordered. */
  readonly reorders: readonly OrderDefinition[];
  readonly controlled: boolean;
  /** The patient's usual weight; each note varies it slightly. */
  readonly weightKg: number;
  readonly lastHba1c?: number;
  /** Absent: the note has no plan section (about a quarter of notes). */
  readonly followUp?: FollowUp;
}

export function diabetesNote(input: ChronicNoteInput): string {
  const { rng } = input;
  const intro = patientIntro(rng, input.sex, input.age);
  const meds = input.medications.map(medLine);
  const comorbid = input.conditions.filter((condition) => condition.noteName !== 'DM2');
  const history = input.firstVisit
    ? `${intro}, ${gendered(input.sex, 'referido', 'referida')} por médico general por DM2 de ${String(input.yearsSinceDiagnosis)} años de dx${comorbid.length > 0 ? ` y ${list(comorbid.map((c) => c.noteName))}` : ''}. Primera consulta en el servicio.`
    : `${intro}, conocido DM2 desde hace ${String(input.yearsSinceDiagnosis)} años, en tto con ${list(meds)}. Acude a ctrl.`;
  const symptoms = rng.pick([
    'Refiere buena adherencia al tto, niega hipoglicemias.',
    'Refiere olvidar dosis ocasionalmente. Niega poliuria ni polidipsia.',
    `${gendered(input.sex, 'Asintomático', 'Asintomática')}. Cumple dieta parcialmente.`,
    'Refiere poliuria leve y cansancio. Niega hipoglicemias.',
    'Sin quejas. Camina 30 min 3 veces por semana.',
  ]);
  const glucose = input.controlled ? rng.int(98, 135) : rng.int(160, 248);
  const exam = `EF: TA ${bp(rng, true)} mmHg, FC ${String(rng.int(64, 88))} lpm, peso ${String(input.weightKg + rng.int(-2, 2))} kg. Glicemia capilar ${String(glucose)} mg/dl. Pies sin lesiones, pulsos pedios presentes.`;
  const labs =
    input.lastHba1c === undefined ? '' : `Trae labs: HbA1c ${input.lastHba1c.toFixed(1)}%.`;
  const dx = `Dx: DM2 ${input.controlled ? 'en metas' : 'fuera de metas'}${comorbid.length > 0 ? `. ${list(comorbid.map((c) => c.noteName))}` : ''}.`;

  const planParts: string[] = [];
  if (!input.controlled && !input.firstVisit) planParts.push('Se ajusta dosis');
  if (meds.length > 0)
    planParts.push(`${rng.pick(['continuar', 'Continúa', 'mantener'])} ${list(meds)}`);
  if (input.reorders.length > 0) {
    planParts.push(`pendiente ${list(input.reorders.map((o) => o.noteName))}, se reitera orden`);
  }
  const newOrders = input.orders.filter((order) => !input.reorders.includes(order));
  if (newOrders.length > 0) planParts.push(`se solicita ${list(newOrders.map((o) => o.noteName))}`);
  planParts.push(
    rng.pick(['dieta hipocalórica', 'plan de alimentación', 'actividad física regular']),
  );

  const body = [history, symptoms, exam, labs, dx].filter((part) => part.length > 0);
  if (input.followUp) {
    const followUp = visitPhrase(rng, input.followUp);
    const withResults = input.orders.length > 0 && rng.chance(0.6) ? ' con resultados' : '';
    body.push(`Plan: ${planParts.join('. ')}. ${followUp}${withResults}.`);
  } else {
    body.push(rng.pick(['Se explica condición.', 'Se dan recomendaciones generales.', '']));
  }
  return roughen(rng, body.filter((part) => part.length > 0).join('\n'));
}

export function hypertensionNote(input: ChronicNoteInput): string {
  const { rng } = input;
  const intro = patientIntro(rng, input.sex, input.age);
  const meds = input.medications.map(medLine);
  const pressure = bp(rng, input.controlled);
  const others = input.conditions.filter((condition) => condition.noteName !== 'HTA');
  const style = rng.int(0, 2);
  const planParts: string[] = [];
  if (!input.controlled) planParts.push('se ajusta tto antihipertensivo');
  if (meds.length > 0) planParts.push(list(meds));
  if (input.reorders.length > 0) {
    planParts.push(
      `pendientes ${list(input.reorders.map((o) => o.noteName))}, se indica nuevamente`,
    );
  }
  const newOrders = input.orders.filter((order) => !input.reorders.includes(order));
  if (newOrders.length > 0) planParts.push(`se solicita ${list(newOrders.map((o) => o.noteName))}`);
  planParts.push(
    rng.pick(['dieta hiposódica', 'reducir sal y ultraprocesados', 'MAPA domiciliaria']),
  );
  const plan = input.followUp
    ? `Plan: ${planParts.join('. ')}. ${visitPhrase(rng, input.followUp)}.`
    : '';
  const dx = `HTA ${input.controlled ? 'controlada' : 'no controlada'}${others.length > 0 ? `, ${list(others.map((c) => c.noteName))}` : ''}`;

  if (style === 0) {
    return roughen(
      rng,
      [
        `${intro} con HTA de ${String(input.yearsSinceDiagnosis)} años de evolución${meds.length > 0 ? `, en tto con ${list(meds)}` : ''}.`,
        rng.pick([
          `${gendered(input.sex, 'Asintomático', 'Asintomática')}.`,
          'Refiere cefalea occipital ocasional.',
          'Niega dolor torácico, disnea o edemas.',
        ]),
        `TA ${pressure} mmHg, FC ${String(rng.int(60, 92))} lpm. RsCsRs, sin soplos. MsIs sin edema.`,
        `Dx: ${dx}.`,
        plan,
      ]
        .filter((part) => part.length > 0)
        .join('\n'),
    );
  }
  if (style === 1) {
    return roughen(
      rng,
      [
        `S: ${intro}, ${input.firstVisit ? 'primera consulta' : 'control'} por HTA. ${rng.pick(['Sin síntomas.', 'Refiere mareos ocasionales al levantarse.', 'Toma la medicación de forma irregular.'])}`,
        `O: TA ${pressure}, FC ${String(rng.int(60, 92))}, peso ${String(input.weightKg + rng.int(-2, 2))} kg.`,
        `A: ${dx}.`,
        input.followUp
          ? `P: ${planParts.join('. ')}. ${visitPhrase(rng, input.followUp)}.`
          : 'P: misma conducta.',
      ].join('\n'),
    );
  }
  return roughen(
    rng,
    `${intro.toLowerCase()}, hta ${input.controlled ? 'controlada' : 'descompensada'}, ta ${pressure}. ${meds.length > 0 ? `toma ${list(meds)}. ` : ''}${input.followUp ? `${planParts.join(', ')}. ${visitPhrase(rng, input.followUp).toLowerCase()}` : 'se dan indicaciones'}`,
  );
}

export interface AcuteNoteInput {
  readonly rng: Prng;
  readonly sex: 'female' | 'male';
  readonly age: number;
  readonly condition: ConditionDefinition;
  readonly medications: readonly MedicationDefinition[];
  readonly orders: readonly OrderDefinition[];
  readonly followUp?: FollowUp;
}

const ACUTE_PRESENTATIONS: Record<string, readonly string[]> = {
  ITU: [
    'consulta por disuria y polaquiuria de 2 días de evolución. Afebril. PPL negativa.',
    'refiere ardor al orinar y urgencia miccional desde hace 3 días. Niega fiebre.',
  ],
  'IRA alta': [
    'consulta por rinorrea, odinofagia y tos seca de 4 días. T 37.8 °C. Faringe hiperémica.',
    'cuadro de congestión nasal y malestar general de 3 días. Afebril. Murmullo vesicular conservado.',
  ],
  gastritis: [
    'refiere epigastralgia urente postprandial de 2 semanas, pirosis ocasional. Abdomen blando, dolor leve a la palpación en epigastrio.',
  ],
  lumbalgia: [
    'consulta por dolor lumbar mecánico de 5 días tras cargar peso. Lasègue negativo, sin déficit neurológico.',
  ],
  faringoamigdalitis: [
    'odinofagia intensa y fiebre de 38.5 °C de 2 días. Amígdalas hipertróficas con exudado.',
  ],
};

export function acuteNote(input: AcuteNoteInput): string {
  const { rng } = input;
  const presentation = rng.pick(
    ACUTE_PRESENTATIONS[input.condition.noteName] ?? ['consulta por cuadro agudo.'],
  );
  const meds = input.medications.map(medLine);
  const orders = input.orders.map((order) => order.noteName);
  const lines = [
    `${patientIntro(rng, input.sex, input.age)} ${presentation}`,
    `Dx: ${input.condition.noteName}.`,
  ];
  const planParts = [
    ...meds,
    ...(orders.length > 0 ? [`se solicita ${list(orders)}`] : []),
    rng.pick(['abundantes líquidos', 'reposo relativo', 'signos de alarma explicados']),
  ];
  if (input.followUp) {
    lines.push(`Plan: ${planParts.join('. ')}. ${visitPhrase(rng, input.followUp)}.`);
  } else {
    lines.push(
      rng.pick([
        `Indicaciones: ${planParts.join(', ')}.`,
        `Tto: ${planParts.join(', ')}.`,
        `${planParts.join('. ')}. Si persisten síntomas, reconsultar.`,
      ]),
    );
  }
  return roughen(rng, lines.join('\n'));
}

const THERAPY_FOCUS = [
  'psicoeducación sobre ansiedad',
  'técnicas de respiración diafragmática',
  'reestructuración cognitiva de pensamientos automáticos',
  'registro de pensamientos',
  'higiene del sueño',
  'activación conductual',
  'habilidades de comunicación asertiva',
  'manejo del tiempo y organización de rutinas',
  'identificación de disparadores de estrés laboral',
  'relajación muscular progresiva',
] as const;

const SESSION_REPORTS = [
  'refiere mejoría en el manejo de la ansiedad en el trabajo',
  'refiere semana con mayor carga laboral, aplicó técnicas de respiración',
  'refiere dificultad para conciliar el sueño 2-3 noches por semana',
  'refiere avances con las tareas asignadas',
  'refiere conflictos familiares puntuales, los maneja con mayor calma',
  'refiere disminución de la preocupación excesiva',
  'refiere que retomó actividad física',
  'comenta que logró sostener sus rutinas de la semana',
] as const;

const PRESENTING_COMPLAINTS: Record<string, readonly string[]> = {
  TAG: [
    'ansiedad asociada a estrés laboral',
    'preocupación constante difícil de controlar desde hace 6 meses',
  ],
  'trastorno adaptativo': [
    'cambios recientes en su vida (mudanza, nuevo empleo)',
    'dificultad para adaptarse tras una separación',
  ],
  'episodio depresivo leve': [
    'bajo estado de ánimo de 2 meses de evolución',
    'desánimo y cansancio de varias semanas',
  ],
  insomnio: ['dificultades para conciliar el sueño de 3 meses', 'despertares nocturnos frecuentes'],
  'trastorno de pánico': [
    'episodios súbitos de palpitaciones y miedo intenso en lugares concurridos',
    'crisis de ansiedad recurrentes con evaluación cardiológica normal',
  ],
};

export interface PsychologyNoteInput {
  readonly rng: Prng;
  readonly sex: 'female' | 'male';
  readonly age: number;
  readonly sessionNumber: number;
  readonly condition: ConditionDefinition;
  readonly followUp?: FollowUp;
  /** Planned end of therapy. */
  readonly discharge?: boolean;
}

export function psychologyNote(input: PsychologyNoteInput): string {
  const { rng } = input;
  if (input.sessionNumber === 1) {
    const lines = [
      `Primera sesión. ${patientIntro(rng, input.sex, input.age)}, consulta por ${rng.pick(PRESENTING_COMPLAINTS[input.condition.noteName] ?? ['malestar emocional'])}.`,
      `Se realiza entrevista inicial y encuadre terapéutico. Afecto ${rng.pick(['ansioso', 'eutímico', 'levemente hipotímico'])}, discurso coherente, ${gendered(input.sex, 'orientado', 'orientada')}.`,
      `Impresión dx: ${input.condition.noteName}.`,
    ];
    lines.push(
      input.followUp
        ? `Plan: TCC. ${sessionPhrase(rng, input.followUp)}.`
        : 'Plan: iniciar proceso con enfoque cognitivo-conductual.',
    );
    return roughen(rng, lines.join('\n'));
  }
  const lines = [
    `Sesión ${String(input.sessionNumber)}. Pcte ${rng.pick(SESSION_REPORTS)}.`,
    `Se trabaja ${rng.pick(THERAPY_FOCUS)}. ${rng.pick(['Buena disposición.', 'Participa activamente.', 'Afecto eutímico, discurso coherente.'])}`,
  ];
  if (input.discharge) {
    lines.push(
      'Se revisan logros del proceso. Se da de alta, puede solicitar cita si lo requiere.',
    );
  } else if (input.followUp) {
    lines.push(`Tarea: ${rng.pick(THERAPY_FOCUS)}. ${sessionPhrase(rng, input.followUp)}.`);
  } else {
    lines.push(
      rng.pick(['Se continúa proceso terapéutico.', 'Tarea para la casa: registro diario.', '']),
    );
  }
  return roughen(rng, lines.filter((line) => line.length > 0).join('\n'));
}

export interface GynecologyNoteInput {
  readonly rng: Prng;
  readonly age: number;
  readonly kind: 'annual' | 'results' | 'pcos' | 'prenatal' | 'postpartum' | 'acute';
  readonly condition: ConditionDefinition;
  readonly medications: readonly MedicationDefinition[];
  readonly orders: readonly OrderDefinition[];
  readonly gestationalWeeks?: number;
  readonly postpartumDays?: number;
  readonly gravida: number;
  readonly followUp?: FollowUp;
}

export function gynecologyNote(input: GynecologyNoteInput): string {
  const { rng } = input;
  const meds = input.medications.map(medLine);
  const orders = input.orders.map((order) => order.noteName);
  const gravida = input.gravida;
  const obstetric = gravida === 0 ? 'G0' : `G${String(gravida)}P${String(gravida - 1)}`;
  const planParts = [...(orders.length > 0 ? [`se solicita ${list(orders)}`] : []), ...meds];
  const plan = (fallback: string) =>
    input.followUp
      ? `Plan: ${[...planParts, visitPhrase(rng, input.followUp)].join('. ')}.`
      : planParts.length > 0
        ? `Indicaciones: ${planParts.join(', ')}. ${fallback}`
        : fallback;

  switch (input.kind) {
    case 'annual':
      return roughen(
        rng,
        [
          `Pcte ${String(input.age)}a, ${obstetric}, acude a control ginecológico. ${rng.pick(['Asintomática.', 'Refiere ciclos regulares.', 'Niega sangrado anormal.'])}`,
          `EF: mamas simétricas sin nódulos palpables. Especuloscopia: cuello de aspecto sano, sin leucorrea patológica. TV: útero en AVF, anexos no palpables.`,
          `Dx: control ginecológico ${input.age >= 45 ? 'en climaterio' : 'de rutina'}.`,
          plan('Se dan recomendaciones.'),
        ].join('\n'),
      );
    case 'results':
      return roughen(
        rng,
        [
          `Pcte ${String(input.age)}a acude con resultados. ${rng.pick(['Asintomática.', 'Sin cambios desde la consulta anterior.'])}`,
          rng.pick([
            'Resultados dentro de límites normales.',
            'Se revisan resultados con la paciente, sin hallazgos de importancia.',
          ]),
          plan('Control anual.'),
        ].join('\n'),
      );
    case 'pcos':
      return roughen(
        rng,
        [
          `Pcte ${String(input.age)}a, ${obstetric}, con SOP. Refiere ciclos ${rng.pick(['irregulares cada 40-45 días', 'más regulares desde que inició ACO'])}, ${rng.pick(['acné leve', 'hirsutismo leve', 'sin otras quejas'])}.`,
          `IMC ${String(rng.int(24, 31))}. TA ${String(rng.int(104, 124))}/${String(rng.int(64, 80))}.`,
          'Dx: SOP.',
          plan('Se refuerzan cambios en estilo de vida.'),
        ].join('\n'),
      );
    case 'prenatal': {
      const weeks = input.gestationalWeeks ?? 12;
      return roughen(
        rng,
        [
          `${gravida <= 1 ? 'Primigesta' : `Pcte ${obstetric}`} de ${String(input.age)}a cursando embarazo de ${String(weeks)} sem por FUM. ${weeks >= 20 ? rng.pick(['Refiere movimientos fetales presentes.', 'Niega sangrado, pérdida de líquido o contracciones.']) : rng.pick(['Náuseas matutinas ocasionales.', 'Niega sangrado ni dolor pélvico.'])}`,
          `TA ${String(rng.int(100, 120))}/${String(rng.int(60, 78))} mmHg${weeks >= 20 ? `, AU ${String(weeks - rng.int(1, 3))} cm, FCF ${String(rng.int(132, 152))} lpm` : ''}. Sin edemas.`,
          `Dx: embarazo de ${String(weeks)} sem, evolución normal.`,
          plan('Signos de alarma explicados.'),
        ].join('\n'),
      );
    }
    case 'postpartum': {
      const days = input.postpartumDays ?? 10;
      return roughen(
        rng,
        [
          `Puérpera de ${String(days)} días, ${rng.pick(['parto eutócico', 'cesárea segmentaria'])} sin complicaciones. Lactancia materna exclusiva.`,
          `TA ${String(rng.int(100, 122))}/${String(rng.int(62, 80))}. Útero involucionado, loquios normales${days > 30 ? ', ya sin loquios' : ''}. ${rng.pick(['Herida en buen estado.', 'Mamas sin signos de mastitis.'])}`,
          `Dx: puerperio ${days > 30 ? 'tardío' : 'mediato'} normal.`,
          plan('Asesoría anticonceptiva.'),
        ].join('\n'),
      );
    }
    case 'acute':
      return roughen(
        rng,
        [
          `Pcte ${String(input.age)}a consulta por ${rng.pick(['leucorrea y prurito vulvar de 5 días', 'flujo vaginal con mal olor', 'dolor pélvico leve y flujo'])}. ${obstetric}.`,
          `Especuloscopia: ${rng.pick(['flujo blanquecino grumoso', 'flujo grisáceo homogéneo', 'mucosa eritematosa'])}.`,
          `Dx: ${input.condition.noteName}.`,
          plan('Reconsultar si persiste.'),
        ].join('\n'),
      );
  }
}
