import type { AppointmentOriginType, CaseEvent } from '@follow-up-engine/core';

/*
 * User-facing copy of the HIP-141 features (attribution and metrics), in
 * English (default) and Spanish, keyed the same way so the i18n catalog
 * loader can plug both in. Nothing here is clinical text.
 */

export const METRICS_LOCALES = ['en', 'es'] as const;
export type MetricsLocale = (typeof METRICS_LOCALES)[number];
export const DEFAULT_METRICS_LOCALE: MetricsLocale = 'en';

export interface AttributionCopy {
  readonly origin: Readonly<Record<AppointmentOriginType, string>>;
  readonly booked: (date: string, origin: string) => string;
  readonly bookedNoDate: (origin: string) => string;
  readonly attended: string;
}

export const ATTRIBUTION_COPY: Readonly<Record<MetricsLocale, AttributionCopy>> = {
  en: {
    origin: {
      follow_up_case: 'booked from this case',
      patient_contact: 'booked after the contact request',
      organic: 'booked on its own',
    },
    booked: (date, origin) => `Appointment for ${date} (${origin})`,
    bookedNoDate: (origin) => `Appointment booked (${origin})`,
    attended: 'The patient attended the appointment',
  },
  es: {
    origin: {
      follow_up_case: 'agendada desde este caso',
      patient_contact: 'agendada tras el pedido de contacto',
      organic: 'agendada por su cuenta',
    },
    booked: (date, origin) => `Cita para el ${date} (${origin})`,
    bookedNoDate: (origin) => `Cita agendada (${origin})`,
    attended: 'El paciente asistió a la cita',
  },
};

const DATE_LOCALES: Readonly<Record<MetricsLocale, string>> = { en: 'en', es: 'es' };

function originType(value: unknown): AppointmentOriginType {
  return value === 'follow_up_case' || value === 'patient_contact' ? value : 'organic';
}

/**
 * Timeline label of an attribution event (`appointment_booked`,
 * `appointment_attended`); `undefined` for any other event.
 */
export function attributionTimelineLabel(
  event: CaseEvent,
  locale: MetricsLocale = DEFAULT_METRICS_LOCALE,
): string | undefined {
  const copy = ATTRIBUTION_COPY[locale];
  if (event.type === 'appointment_attended') {
    return copy.attended;
  }
  if (event.type !== 'appointment_booked') {
    return undefined;
  }
  const origin = copy.origin[originType(event.payload['originType'])];
  const raw = event.payload['scheduledFor'];
  const date = typeof raw === 'string' ? new Date(raw) : undefined;
  return date === undefined || Number.isNaN(date.getTime())
    ? copy.bookedNoDate(origin)
    : copy.booked(
        date.toLocaleDateString(DATE_LOCALES[locale], {
          day: 'numeric',
          month: 'long',
          timeZone: 'UTC',
        }),
        origin,
      );
}
