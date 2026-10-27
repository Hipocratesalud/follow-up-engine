import type { ConditionDefinition, MedicationDefinition, OrderDefinition } from './catalog.ts';
import {
  bp,
  type FollowUp,
  gendered,
  list,
  medLine,
  patientIntro,
  roughen,
  visitPhrase,
} from './notes.ts';
import type { Prng } from './prng.ts';

/**
 * Spanish progress notes of the patients that exercise the care protocols:
 * prenatal controls dated by FUM/FPP or by ultrasound, deliveries and
 * losses, antidepressants started and titrated, levothyroxine and statin
 * dose changes, chronic kidney disease. Same style as `notes.ts`. Notes of
 * patients followed in psychology stay clinical and neutral (no crisis
 * content), including the internist's.
 */

/** `dd/mm/aaaa` of a UTC date. */
export function shortDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${String(date.getUTCFullYear())}`;
}

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function planLine(rng: Prng, parts: readonly string[], followUp: FollowUp | undefined): string {
  const all = followUp ? [...parts, visitPhrase(rng, followUp)] : parts;
  return all.length > 0 ? `Plan: ${all.map(capitalized).join('. ')}.` : '';
}

const orderPhrase = (orders: readonly OrderDefinition[]): string[] =>
  orders.length > 0 ? [`se solicita ${list(orders.map((order) => order.noteName))}`] : [];

// --- Pregnancy ---------------------------------------------------------------

export type PregnancyDatingSource = 'lmp' | 'ultrasound' | 'note';

export interface PrenatalNoteInput {
  readonly rng: Prng;
  readonly age: number;
  /** Obstetric formula as written: "Primigesta", "G3P2", "G3P1A1". */
  readonly obstetric: string;
  readonly firstVisit: boolean;
  /** Completed weeks at the visit. */
  readonly weeks: number;
  readonly dating: PregnancyDatingSource;
  readonly lmp: Date;
  readonly edd: Date;
  readonly orders: readonly OrderDefinition[];
  readonly medications: readonly MedicationDefinition[];
  /** The previous visit's OGTT, when its result is back. */
  readonly ogttReviewed?: { readonly fasting: number; readonly twoHour: number };
  /** The previous visit's ultrasound is back. */
  readonly ultrasoundReviewed?: boolean;
  readonly followUp?: FollowUp;
}

export function prenatalNote(input: PrenatalNoteInput): string {
  const { rng } = input;
  const weeks = String(input.weeks);
  const plan = planLine(
    rng,
    [
      ...orderPhrase(input.orders),
      ...input.medications.map(medLine),
      'signos de alarma explicados',
    ],
    input.followUp,
  );
  if (input.firstVisit) {
    const datingLine =
      input.dating === 'lmp'
        ? `FUM ${shortDate(input.lmp)}, FPP ${shortDate(input.edd)}.`
        : input.dating === 'ultrasound'
          ? 'FUM incierta (ciclos irregulares), se solicita eco para datación.'
          : `Embarazo de ${weeks} semanas por FUM.`;
    return roughen(
      rng,
      [
        `${input.obstetric} de ${String(input.age)} años, acude por amenorrea y prueba de embarazo en orina positiva. ${datingLine}`,
        rng.pick([
          'Náuseas matutinas ocasionales. Niega sangrado ni dolor pélvico.',
          'Refiere mastalgia y somnolencia. Niega sangrado.',
          'Asintomática. Niega sangrado ni flujo anormal.',
        ]),
        `TA ${String(rng.int(100, 120))}/${String(rng.int(60, 78))} mmHg. Mamas sin alteraciones. Abdomen blando, depresible.`,
        input.dating === 'ultrasound'
          ? 'Dx: embarazo de primer trimestre por datar.'
          : `Dx: embarazo de ${weeks} semanas por FUM.`,
        plan,
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
    );
  }
  const by = input.dating === 'ultrasound' ? 'eco del primer trimestre' : 'FUM';
  const fpp =
    input.dating === 'note' || rng.chance(0.4)
      ? ''
      : ` FPP ${shortDate(input.edd)}${input.dating === 'ultrasound' ? ' por eco' : ''}.`;
  const reviewed: string[] = [];
  if (input.ultrasoundReviewed)
    reviewed.push(
      rng.pick([
        'Eco obstétrico: embarazo único activo, biometría acorde a edad gestacional.',
        'Trae eco: feto único, vivo, LA normal, placenta normoinserta.',
      ]),
    );
  if (input.ogttReviewed)
    reviewed.push(
      `Trae PTOG 75 g: basal ${String(input.ogttReviewed.fasting)} mg/dl, 2 h ${String(input.ogttReviewed.twoHour)} mg/dl, normal.`,
    );
  const late = input.weeks >= 20;
  return roughen(
    rng,
    [
      `Control prenatal. ${input.obstetric} de ${String(input.age)}a, embarazo de ${weeks} semanas por ${by}.${fpp}`,
      late
        ? rng.pick([
            'Refiere movimientos fetales presentes.',
            'Niega sangrado, pérdida de líquido o contracciones.',
            'Movimientos fetales activos, niega cefalea ni edemas.',
          ])
        : rng.pick(['Náuseas en mejoría.', 'Niega sangrado ni dolor pélvico.', 'Asintomática.']),
      `TA ${String(rng.int(100, 122))}/${String(rng.int(60, 78))} mmHg${late ? `, AU ${String(input.weeks - rng.int(1, 3))} cm, FCF ${String(rng.int(132, 152))} lpm` : ''}. Sin edemas.`,
      ...reviewed,
      `Dx: embarazo de ${weeks} semanas, evolución normal.`,
      plan,
    ]
      .filter((line) => line.length > 0)
      .join('\n'),
  );
}

export interface DeliveryVisitNoteInput {
  readonly rng: Prng;
  readonly age: number;
  readonly obstetric: string;
  readonly days: number;
  readonly deliveredAt: Date;
  readonly gestationalWeeks: number;
  readonly mode: 'vaginal' | 'cesarean';
  readonly medications: readonly MedicationDefinition[];
  readonly followUp?: FollowUp;
}

/** The first puerperal visit: says when and how the baby was born. */
export function deliveryVisitNote(input: DeliveryVisitNoteInput): string {
  const { rng } = input;
  const delivery =
    input.mode === 'vaginal'
      ? `parto vaginal el ${shortDate(input.deliveredAt)}`
      : `cesárea segmentaria el ${shortDate(input.deliveredAt)} por ${rng.pick(['desproporción cefalopélvica', 'presentación podálica', 'cesárea anterior'])}`;
  return roughen(
    rng,
    [
      `Puérpera de ${String(input.days)} días, ${input.obstetric}. ${capitalized(delivery)}, a las ${String(input.gestationalWeeks)} semanas, sin complicaciones. RN sano, ${rng.pick(['lactancia materna exclusiva', 'lactancia mixta'])}.`,
      `TA ${String(rng.int(100, 122))}/${String(rng.int(62, 80))}. Útero involucionado, loquios serohemáticos escasos. ${input.mode === 'cesarean' ? 'Herida quirúrgica limpia, sin signos de infección.' : 'Episiorrafia en buen estado.'}`,
      'Dx: puerperio mediato normal.',
      planLine(rng, [...input.medications.map(medLine), 'asesoría anticonceptiva'], input.followUp),
    ]
      .filter((line) => line.length > 0)
      .join('\n'),
  );
}

export interface PuerperalControlNoteInput {
  readonly rng: Prng;
  readonly days: number;
  readonly mode: 'vaginal' | 'cesarean';
  readonly medications: readonly MedicationDefinition[];
}

/** The 6-week puerperal control, where contraception starts. */
export function puerperalControlNote(input: PuerperalControlNoteInput): string {
  const { rng } = input;
  return roughen(
    rng,
    [
      `Control puerperal. Puérpera de ${String(input.days)} días (${input.mode === 'vaginal' ? 'parto vaginal' : 'cesárea segmentaria'}). ${rng.pick(['Asintomática.', 'Sin quejas.', 'Refiere cansancio por desvelo, sin otros síntomas.'])} ${rng.pick(['Lactancia materna exclusiva.', 'Lactancia mixta.'])}`,
      `TA ${String(rng.int(100, 122))}/${String(rng.int(62, 80))}. Útero involucionado, ya sin loquios. ${input.mode === 'cesarean' ? 'Cicatriz quirúrgica sana.' : 'Periné sin alteraciones.'}`,
      'Dx: puerperio tardío normal. Anticoncepción.',
      `Indicaciones: ${input.medications.map(medLine).join(', ')}. Control ginecológico anual.`,
    ].join('\n'),
  );
}

export interface LossNoteInput {
  readonly rng: Prng;
  readonly age: number;
  readonly obstetric: string;
  readonly weeks: number;
  readonly followUp?: FollowUp;
}

export function miscarriageNote(input: LossNoteInput): string {
  const { rng } = input;
  return roughen(
    rng,
    [
      `${input.obstetric} de ${String(input.age)} años con embarazo de ${String(input.weeks)} semanas por FUM, consulta por sangrado transvaginal y dolor hipogástrico tipo cólico de ${rng.pick(['1 día', '2 días', '12 horas'])} de evolución.`,
      `TA ${String(rng.int(100, 118))}/${String(rng.int(60, 76))}, FC ${String(rng.int(76, 96))} lpm. Especuloscopia: sangrado escaso proveniente de cavidad. Eco TV: útero vacío, endometrio de ${String(rng.int(5, 9))} mm, sin restos.`,
      'Dx: aborto espontáneo completo.',
      planLine(
        rng,
        ['reposo relativo', 'signos de alarma explicados (fiebre, sangrado abundante)'],
        input.followUp,
      ),
    ]
      .filter((line) => line.length > 0)
      .join('\n'),
  );
}

export function postLossNote(input: Omit<LossNoteInput, 'weeks'>): string {
  const { rng } = input;
  return roughen(
    rng,
    [
      `Pcte de ${String(input.age)}a, ${input.obstetric}, control a las 2 semanas de aborto espontáneo completo. Asintomática, sin sangrado.`,
      'TV: útero de tamaño normal, anexos libres. Prueba de embarazo en orina negativa.',
      'Dx: control post aborto sin complicaciones.',
      planLine(
        rng,
        ['se brinda orientación', 'si desea nuevo embarazo, iniciar ácido fólico 3 meses antes'],
        input.followUp,
      ),
    ]
      .filter((line) => line.length > 0)
      .join('\n'),
  );
}

// --- Antidepressant follow-up (internal medicine, patients in psychotherapy) ---

export interface AntidepressantNoteInput {
  readonly rng: Prng;
  readonly sex: 'female' | 'male';
  readonly age: number;
  readonly kind: 'start' | 'control' | 'increase' | 'maintenance';
  readonly condition: ConditionDefinition;
  /** The drug prescribed today (the new dose when it increases). */
  readonly medication: MedicationDefinition;
  readonly previous?: MedicationDefinition;
  readonly weeksOnTreatment?: number;
  readonly followUp?: FollowUp;
}

const isDepression = (condition: ConditionDefinition) => condition.icd10.startsWith('F32');

function scale(rng: Prng, condition: ConditionDefinition, level: 'high' | 'mid' | 'low'): string {
  const [low, high] = level === 'high' ? [15, 19] : level === 'mid' ? [10, 13] : [3, 7];
  return isDepression(condition)
    ? `PHQ-9: ${String(rng.int(low, high))}.`
    : `GAD-7: ${String(rng.int(low - 1, high - 2))}.`;
}

/** "Sertralina 100 mg" → ["sertralina", "100 mg"]. */
function drugAndDose(medication: MedicationDefinition): readonly [string, string] {
  const [name = '', ...dose] = medication.text.split(' ');
  return [name.toLowerCase(), dose.join(' ')];
}

export function antidepressantNote(input: AntidepressantNoteInput): string {
  const { rng, condition, medication } = input;
  const intro = patientIntro(rng, input.sex, input.age);
  const [drug, dose] = drugAndDose(medication);
  const exam = `TA ${bp(rng, true)} mmHg, FC ${String(rng.int(64, 86))} lpm.`;
  const therapy = 'continuar psicoterapia';
  switch (input.kind) {
    case 'start':
      return roughen(
        rng,
        [
          `${intro}, ${gendered(input.sex, 'referido', 'referida')} por psicología, en psicoterapia cognitivo-conductual por ${condition.noteName}. Refiere ${isDepression(condition) ? 'ánimo bajo, anhedonia, insomnio de conciliación y fatiga' : 'preocupación excesiva, tensión muscular, irritabilidad e insomnio'} de ${String(rng.int(2, 6))} meses de evolución. ${scale(rng, condition, 'high')}`,
          `Sin antecedentes médicos de importancia. EF: ${exam} Sin hallazgos.`,
          `Dx: ${condition.noteName}.`,
          planLine(
            rng,
            [
              `se inicia ${drug} ${dose}, ${medication.dosage}`,
              'se explican efectos adversos esperables las primeras semanas',
              therapy,
            ],
            input.followUp,
          ),
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
      );
    case 'increase': {
      const previous = input.previous ?? medication;
      return roughen(
        rng,
        [
          `${intro}, control a las ${String(input.weeksOnTreatment ?? 4)} semanas de ${previous.text.toLowerCase()}. Respuesta parcial: ${isDepression(condition) ? 'persiste ánimo bajo en las tardes y sueño fragmentado' : 'persiste preocupación y tensión muscular en días laborales'}. Buena tolerancia. ${scale(rng, condition, 'mid')}`,
          `EF: ${exam}`,
          `Dx: ${condition.noteName}, respuesta parcial.`,
          planLine(
            rng,
            [`se aumenta ${drug} a ${dose}/día, ${medication.dosage}`, therapy],
            input.followUp,
          ),
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
      );
    }
    case 'control':
      return roughen(
        rng,
        [
          `${intro}, control. En tto con ${medication.text.toLowerCase()} desde hace ${String(input.weeksOnTreatment ?? 4)} semanas. ${rng.pick(['Refiere mejoría del ánimo y del sueño.', 'Refiere menos preocupación y mejor descanso.', 'Mejoría progresiva, retomó actividades.'])} ${rng.pick(['Tolera bien.', 'Náuseas leves los primeros días, ya resueltas.'])} ${scale(rng, condition, 'low')}`,
          `EF: ${exam}`,
          `Dx: ${condition.noteName} en mejoría.`,
          planLine(rng, [`continuar ${medLine(medication)}`, therapy], input.followUp),
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
      );
    case 'maintenance':
      return roughen(
        rng,
        [
          `${intro}, control de seguimiento. Estable con ${medication.text.toLowerCase()}, ${rng.pick(['ánimo eutímico', 'sin síntomas relevantes', 'buen funcionamiento laboral'])}. ${scale(rng, condition, 'low')}`,
          `EF: ${exam}`,
          `Dx: ${condition.noteName} en remisión parcial.`,
          planLine(rng, [`continuar ${medLine(medication)}`], input.followUp),
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
      );
  }
}

// --- Hypothyroidism ----------------------------------------------------------

export interface ThyroidNoteInput {
  readonly rng: Prng;
  readonly sex: 'female' | 'male';
  readonly age: number;
  readonly kind: 'workup' | 'start' | 'adjust' | 'control';
  /** Levothyroxine prescribed today (required except for the workup). */
  readonly medication?: MedicationDefinition;
  readonly previous?: MedicationDefinition;
  /** TSH the patient brings, mUI/L. */
  readonly tsh?: number;
  readonly yearsSinceDiagnosis?: number;
  readonly orders: readonly OrderDefinition[];
  /** When the control TSH is due, as written in the plan ("TSH control en 6 semanas"). */
  readonly tshIn?: string;
  readonly followUp?: FollowUp;
}

export function thyroidNote(input: ThyroidNoteInput): string {
  const { rng } = input;
  const intro = patientIntro(rng, input.sex, input.age);
  const tsh = input.tsh === undefined ? '' : `TSH ${input.tsh.toFixed(2)} mUI/L`;
  const exam = `EF: TA ${bp(rng, true)} mmHg, FC ${String(rng.int(58, 84))} lpm. Tiroides no palpable.`;
  const tshPlan = input.tshIn ? [input.tshIn] : [];
  const medication = input.medication;
  if (input.kind !== 'workup' && medication === undefined) {
    throw new Error(`thyroid ${input.kind} note needs the levothyroxine prescribed`);
  }
  switch (input.kind) {
    case 'workup':
      return roughen(
        rng,
        [
          `${intro}, consulta por astenia, intolerancia al frío y aumento de peso de ${String(rng.int(3, 6))} kg en 6 meses.`,
          exam,
          'Impresión dx: astenia, descartar hipotiroidismo.',
          planLine(rng, orderPhrase(input.orders), input.followUp),
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
      );
    case 'start':
      return roughen(
        rng,
        [
          `${intro}, acude con resultados: ${tsh}. Persiste astenia.`,
          exam,
          'Dx: hipotiroidismo primario.',
          planLine(
            rng,
            [
              `se inicia ${medication ? medLine(medication) : 'levotiroxina'}, 30 min antes del desayuno`,
              ...tshPlan,
            ],
            input.followUp,
          ),
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
      );
    case 'adjust': {
      const dose = medication ? drugAndDose(medication)[1] : '';
      return roughen(
        rng,
        [
          `${intro}, hipotiroidismo primario${input.yearsSinceDiagnosis ? ` de ${String(input.yearsSinceDiagnosis)} años` : ''} en tto con ${(input.previous?.text ?? 'levotiroxina').toLowerCase()}. Trae ${tsh}. ${rng.pick(['Refiere astenia y somnolencia.', 'Refiere estreñimiento y piel seca.', 'Asintomático salvo cansancio leve.'])}`,
          exam,
          'Dx: hipotiroidismo primario no controlado.',
          planLine(
            rng,
            [`se ajusta levotiroxina a ${dose}/día en ayunas`, ...tshPlan],
            input.followUp,
          ),
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
      );
    }
    case 'control':
      return roughen(
        rng,
        [
          `${intro}, hipotiroidismo primario${input.yearsSinceDiagnosis ? ` de ${String(input.yearsSinceDiagnosis)} años` : ''} en tto con ${(medication?.text ?? 'levotiroxina').toLowerCase()}. ${tsh ? `Trae ${tsh}, en rango.` : ''} ${gendered(input.sex, 'Asintomático', 'Asintomática')}.`,
          exam,
          'Dx: hipotiroidismo primario controlado.',
          planLine(
            rng,
            [
              ...(medication ? [`continuar ${medLine(medication)}`] : []),
              ...orderPhrase(input.orders),
              ...tshPlan,
            ],
            input.followUp,
          ),
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
      );
  }
}

// --- Dyslipidemia ------------------------------------------------------------

export interface LipidValues {
  readonly total: number;
  readonly triglycerides: number;
  readonly hdl: number;
  readonly ldl: number;
}

export interface LipidNoteInput {
  readonly rng: Prng;
  readonly sex: 'female' | 'male';
  readonly age: number;
  readonly kind: 'start' | 'increase' | 'control';
  readonly condition: ConditionDefinition;
  readonly medication: MedicationDefinition;
  readonly previous?: MedicationDefinition;
  readonly panel: LipidValues;
  readonly weeksOnTreatment?: number;
  /** When the control panel is due, as written in the plan. */
  readonly panelIn?: string;
  readonly followUp?: FollowUp;
}

export function lipidNote(input: LipidNoteInput): string {
  const { rng, panel } = input;
  const intro = patientIntro(rng, input.sex, input.age);
  const labs = `Trae perfil lipídico: CT ${String(panel.total)}, TG ${String(panel.triglycerides)}, HDL ${String(panel.hdl)}, LDL ${String(panel.ldl)} mg/dL.`;
  const exam = `EF: TA ${bp(rng, true)} mmHg, IMC ${String(rng.int(24, 31))}.`;
  const [drug, dose] = drugAndDose(input.medication);
  const panelPlan = input.panelIn ? [input.panelIn] : [];
  switch (input.kind) {
    case 'start':
      return roughen(
        rng,
        [
          `${intro}, consulta con laboratorio de chequeo. ${rng.pick(['Padre con IAM a los 58 años.', 'Niega antecedentes cardiovasculares familiares.', 'Exfumador desde hace 5 años.'])} Sedentarismo.`,
          labs,
          exam,
          `Dx: ${input.condition.noteName}. Riesgo cardiovascular ${rng.pick(['moderado', 'alto'])}.`,
          planLine(
            rng,
            [
              'dieta baja en grasas saturadas, actividad física 150 min/semana',
              `se inicia ${drug} ${dose}, ${input.medication.dosage}`,
              ...panelPlan,
            ],
            input.followUp,
          ),
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
      );
    case 'increase':
      return roughen(
        rng,
        [
          `${intro}, control. En tto con ${(input.previous?.text ?? drug).toLowerCase()} desde hace ${String(input.weeksOnTreatment ?? 8)} semanas, buena adherencia, niega mialgias.`,
          `${labs} LDL fuera de meta.`,
          exam,
          `Dx: ${input.condition.noteName} no controlada.`,
          planLine(
            rng,
            [`se aumenta ${drug} a ${dose}, ${input.medication.dosage}`, ...panelPlan],
            input.followUp,
          ),
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
      );
    case 'control':
      return roughen(
        rng,
        [
          `${intro}, control. En tto con ${input.medication.text.toLowerCase()}, niega mialgias.`,
          `${labs} LDL en meta.`,
          exam,
          `Dx: ${input.condition.noteName} controlada.`,
          planLine(rng, [`continuar ${medLine(input.medication)}`, ...panelPlan], input.followUp),
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
      );
  }
}

// --- Chronic kidney disease --------------------------------------------------

/** KDIGO GFR category of an eGFR (mL/min/1.73 m²). */
export function gfrCategory(egfr: number): string {
  if (egfr >= 90) return 'G1';
  if (egfr >= 60) return 'G2';
  if (egfr >= 45) return 'G3a';
  if (egfr >= 30) return 'G3b';
  if (egfr >= 15) return 'G4';
  return 'G5';
}

/** KDIGO albuminuria category of a urine albumin/creatinine ratio (mg/g). */
export function albuminuriaCategory(uacr: number): string {
  if (uacr < 30) return 'A1';
  if (uacr <= 300) return 'A2';
  return 'A3';
}

export interface KidneyNoteInput {
  readonly rng: Prng;
  readonly sex: 'female' | 'male';
  readonly age: number;
  readonly firstVisit: boolean;
  readonly yearsOfHypertension: number;
  /** The CKD diagnosis the clinician writes; absent when the record never names it. */
  readonly ckd?: ConditionDefinition;
  readonly creatinine: number;
  readonly egfr: number;
  readonly uacr?: number;
  readonly medications: readonly MedicationDefinition[];
  readonly followUp?: FollowUp;
}

export function kidneyNote(input: KidneyNoteInput): string {
  const { rng } = input;
  const intro = patientIntro(rng, input.sex, input.age);
  const meds = input.medications.map(medLine);
  const labs = `Trae labs: creatinina ${input.creatinine.toFixed(2)} mg/dL, TFG ${String(input.egfr)} mL/min/1.73m2${input.uacr === undefined ? '' : `, RAC ${String(input.uacr)} mg/g`}.`;
  const stage =
    input.uacr === undefined
      ? gfrCategory(input.egfr)
      : `${gfrCategory(input.egfr)}${albuminuriaCategory(input.uacr)}`;
  const controlled = rng.chance(0.65);
  const exam = `EF: TA ${bp(rng, controlled)} mmHg, FC ${String(rng.int(62, 88))} lpm, peso estable. MsIs ${rng.pick(['sin edema', 'edema grado I maleolar'])}.`;
  const history = input.ckd
    ? `${intro}, HTA de ${String(input.yearsOfHypertension)} años y ${input.ckd.noteName} (${stage}), ${input.firstVisit ? `${gendered(input.sex, 'referido', 'referida')} por médico general` : 'acude a control'}. En tto con ${list(meds)}.`
    : `${intro}, HTA de ${String(input.yearsOfHypertension)} años en tto con ${list(meds)}, ${input.firstVisit ? 'primera consulta en el servicio' : 'acude a control'}.`;
  const albuminuria =
    input.uacr !== undefined && input.uacr >= 30 && !input.ckd
      ? ' Albuminuria moderadamente aumentada.'
      : '';
  const dx = input.ckd
    ? `Dx: ${input.ckd.noteName} KDIGO ${stage}. HTA ${controlled ? 'controlada' : 'no controlada'}.`
    : `Dx: HTA ${controlled ? 'controlada' : 'no controlada'}.${albuminuria}`;
  const nextLabs = input.ckd
    ? 'con creatinina, TFG y RAC'
    : input.uacr === undefined
      ? 'con creatinina'
      : 'con creatinina y RAC';
  const plan = input.followUp
    ? `Plan: continuar ${list(meds)}. ${input.ckd ? 'Evitar AINEs, ajustar fármacos a la TFG, dieta hiposódica' : 'Dieta hiposódica'}. ${capitalized(visitPhrase(rng, input.followUp))} ${nextLabs}.`
    : rng.pick(['Misma conducta.', 'Se dan recomendaciones generales.']);
  return roughen(rng, [history, labs, exam, dx, plan].join('\n'));
}
