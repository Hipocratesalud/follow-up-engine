import type { LabOrderInput } from '../../api/contract.ts';

/**
 * Synthetic consultations for the demo. Fictional patients, written like
 * real clinic shorthand. The note text is clinical content: it stays in the
 * language it was written in, whatever the UI language (the button's title
 * comes from the catalogs, `consultation.examples`).
 */
export interface ExampleNote {
  readonly id: string;
  readonly patientName: string;
  readonly specialty: string;
  readonly noteText: string;
  readonly orders: readonly LabOrderInput[];
}

/** Lab orders, with their LOINC display (sent to the API); the UI names them from the catalogs. */
export const LAB_OPTIONS: readonly LabOrderInput[] = [
  { loinc: '4548-4', display: 'Hemoglobin A1c' },
  { loinc: '57698-3', display: 'Lipid panel' },
  { loinc: '14957-5', display: 'Microalbumin in urine' },
  { loinc: '2160-0', display: 'Creatinine in serum' },
  { loinc: '3016-3', display: 'Thyrotropin' },
  { loinc: '58410-2', display: 'Complete blood count' },
];

export const EXAMPLE_NOTES: readonly ExampleNote[] = [
  {
    id: 'diabetes-plan',
    patientName: 'Carmen Rosa Liendo',
    specialty: 'diabetology',
    noteText:
      'Paciente femenina de 61 años con DM2 diagnosticada hace 6 años e HTA. Refiere poliuria y cansancio. Glicemia en ayunas 186 mg/dL, HbA1c 8,9 %. PA 138/86. Se ajusta metformina a 1000 mg c/12h y se inicia sitagliptina 100 mg/día por 90 días. Plan: control en 3 meses con HbA1c; perfil lipídico y microalbuminuria antes de la próxima consulta.',
    orders: [{ loinc: '2160-0', display: 'Creatinine in serum' }],
  },
  {
    id: 'psychology-plan',
    patientName: 'Diego Hernández',
    specialty: 'psychology',
    noteText:
      'Consultante de 27 años que acude por crisis de angustia recurrentes desde hace 3 meses, con evitación de lugares concurridos. Sin ideación suicida. Se trabaja psicoeducación sobre el ciclo del pánico y respiración diafragmática. Plan: sesiones semanales durante 10 semanas; aplicar escala GAD-7 en 4 semanas.',
    orders: [],
  },
  {
    id: 'gynecology-no-plan',
    patientName: 'Mariela Sánchez',
    specialty: 'gynecology',
    noteText:
      'Paciente de 44 años, G2P2, consulta por sangrado menstrual abundante en los últimos 4 meses. Al examen, útero aumentado de tamaño, irregular. Ecografía con mioma intramural de 4 cm. Hemoglobina 10,8 g/dL.',
    orders: [{ loinc: '58410-2', display: 'Complete blood count' }],
  },
  {
    // An English note: the engine reads each note in its own language (docs/adr/0007).
    id: 'english-hypertension',
    patientName: 'Daniel Whitaker',
    specialty: 'internal_medicine',
    noteText:
      '54 y/o M with HTN x 5 yrs, on lisinopril 20 mg daily. Denies DM, chest pain or SOB. BP 152/94, HR 76. Plan: add amlodipine 5 mg daily. Order BMP and lipid panel. RTC in 6 wks to recheck BP.',
    orders: [{ loinc: '57698-3', display: 'Lipid panel' }],
  },
];
