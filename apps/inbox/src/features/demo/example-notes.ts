import type { LabOrderInput } from '../../api/contract.ts';

/** Synthetic consultations for the demo. Fictional patients, written like real clinic shorthand. */
export interface ExampleNote {
  readonly id: string;
  readonly title: string;
  readonly patientName: string;
  readonly specialty: string;
  readonly noteText: string;
  readonly orders: readonly LabOrderInput[];
}

export const LAB_OPTIONS: readonly LabOrderInput[] = [
  { loinc: '4548-4', display: 'HbA1c' },
  { loinc: '57698-3', display: 'Perfil lipídico' },
  { loinc: '14957-5', display: 'Microalbuminuria' },
  { loinc: '2160-0', display: 'Creatinina sérica' },
  { loinc: '3016-3', display: 'TSH' },
  { loinc: '58410-2', display: 'Hemograma completo' },
];

export const EXAMPLE_NOTES: readonly ExampleNote[] = [
  {
    id: 'diabetes-plan',
    title: 'Diabetes con plan',
    patientName: 'Carmen Rosa Liendo',
    specialty: 'diabetology',
    noteText:
      'Paciente femenina de 61 años con DM2 diagnosticada hace 6 años e HTA. Refiere poliuria y cansancio. Glicemia en ayunas 186 mg/dL, HbA1c 8,9 %. PA 138/86. Se ajusta metformina a 1000 mg c/12h y se inicia sitagliptina 100 mg/día por 90 días. Plan: control en 3 meses con HbA1c; perfil lipídico y microalbuminuria antes de la próxima consulta.',
    orders: [{ loinc: '2160-0', display: 'Creatinina sérica' }],
  },
  {
    id: 'psychology-plan',
    title: 'Psicología con sesiones',
    patientName: 'Diego Hernández',
    specialty: 'psychology',
    noteText:
      'Consultante de 27 años que acude por crisis de angustia recurrentes desde hace 3 meses, con evitación de lugares concurridos. Sin ideación suicida. Se trabaja psicoeducación sobre el ciclo del pánico y respiración diafragmática. Plan: sesiones semanales durante 10 semanas; aplicar escala GAD-7 en 4 semanas.',
    orders: [],
  },
  {
    id: 'gynecology-no-plan',
    title: 'Ginecología sin plan',
    patientName: 'Mariela Sánchez',
    specialty: 'gynecology',
    noteText:
      'Paciente de 44 años, G2P2, consulta por sangrado menstrual abundante en los últimos 4 meses. Al examen, útero aumentado de tamaño, irregular. Ecografía con mioma intramural de 4 cm. Hemoglobina 10,8 g/dL.',
    orders: [{ loinc: '58410-2', display: 'Hemograma completo' }],
  },
];
