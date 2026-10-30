/**
 * "Why this?" (HIP-142): the evidence the API attaches to every reason of a
 * case (`CaseReasonView.why`, case detail only) and every expectation of a
 * patient, and the patient's documents for the "View documents" drawer.
 * Mirrors `apps/api/src/http/why-schemas.ts`. Every `text` comes localized
 * from the API; clinical content (note text, quotes) is as written.
 */

export type WhyDocumentKind =
  | 'note'
  | 'order'
  | 'result'
  | 'prescription'
  | 'visit'
  | 'appointment'
  | 'diagnosis'
  | 'allergy'
  | 'other';

export interface DocumentRefView {
  resourceType: string;
  id: string;
  kind: WhyDocumentKind;
  kindLabel: string;
  /** When it happened clinically (a note: when it was written; a booking: its date). */
  at: string;
  title: string;
  code?: string;
  detail?: string;
  value?: string;
  interpretation?: 'normal' | 'abnormal' | 'unknown' | 'critical';
  status?: string;
  specialty?: string;
  author?: string;
  documentId?: string;
  encounterId?: string;
}

export interface PatientDocumentView extends DocumentRefView {
  /** Notes: the full text, as written. */
  text?: string;
  /** The host withdrew it later. */
  withdrawn?: boolean;
}

export interface Coding {
  system: string;
  code: string;
  display?: string;
}

export interface ReasonWhyView {
  layer: 'universal' | 'doctor_plan' | 'cadence' | 'protocol';
  due: {
    basis: string;
    anchorRole: string;
    anchor?: DocumentRefView;
    anchorAt?: string;
    days?: number;
    configuredDays?: number;
    treatmentDays?: number;
    bookingToleranceDays?: number;
    dueAt: string;
    /** "Due Jan 21, 2026 = last time done: HbA1c (Jun 10, 2025) + 90 days". */
    text: string;
    basisText: string;
    toleranceText?: string;
    tooEarly?: DocumentRefView;
    tooEarlyText?: string;
  };
  fulfilledBy: {
    expects: string;
    code?: Coding;
    equivalentCodes: string[];
    orderId?: string;
    events: string[];
    specialties: string[];
    text: string;
  };
  closedBy?: DocumentRefView;
  plan?: {
    documentId: string;
    quote: string;
    authoredAt?: string;
    author?: string;
    specialty?: string;
    noteExcerpt?: string;
    itemDescription?: string;
    note?: DocumentRefView;
  };
  protocol?: {
    id: string;
    name?: string;
    version: string;
    currentVersion?: string;
    status?: 'draft' | 'ready_for_signoff' | 'validated';
    statusText?: string;
    title: string;
    itemKey?: string;
    scheduleText?: string;
    enrollment: {
      episode: 'active' | 'ended' | 'not_enrolled';
      basis?: 'diagnosis' | 'note' | 'medication' | 'results' | 'record';
      condition?: {
        code: string;
        display: string;
        status: string;
        sourceType: string;
        quote?: string;
      };
      evidence: DocumentRefView[];
      threshold?: {
        code: Coding;
        gte?: number;
        lt?: number;
        confirm?: { count: number; minDaysApart: number };
      };
      activeTreatment?: DocumentRefView;
      endedBy?: DocumentRefView;
      text: string;
      activeTreatmentText?: string;
    };
    ckdStage?: { gfr?: string; albuminuria?: string };
    gestationalWeeks?: number;
  };
  cadence?: {
    specialty?: string;
    visits: { at: string; encounterId: string; inPattern: boolean }[];
    usualIntervalDays?: number;
    multiplier?: number;
    expectedBy: string;
    text: string;
  };
}
