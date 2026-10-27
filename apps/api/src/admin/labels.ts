/**
 * Copy of the rule configuration API (`/api/admin/rules`) and the
 * `clinic:rules` CLI, keyed the same way in every locale so the i18n catalog
 * loader can plug it in. English is the default; Spanish (neutral, "tú") the
 * second locale.
 */

export const ADMIN_LOCALES = ['en', 'es'] as const;
export type AdminLocale = (typeof ADMIN_LOCALES)[number];

export interface AdminRulesLabels {
  /** By `ValidationError.field` of the rule override commands. */
  readonly fields: {
    readonly ruleId: string;
    readonly dueInDays: string;
    readonly enabled: string;
    readonly override: string;
    readonly reason: string;
    readonly actor: string;
    /** Any field the override does not have. */
    readonly unknownField: string;
  };
  /** Summary of a 422. */
  readonly invalid: string;
  /** 409: another change landed since the version the request was based on. */
  readonly staleVersion: string;
  /** The rule runs as configured: no change was made. */
  readonly unchanged: string;
  readonly layers: Readonly<Record<'universal' | 'doctor_plan' | 'cadence' | 'protocol', string>>;
}

export const ADMIN_RULES_LABELS: Readonly<Record<AdminLocale, AdminRulesLabels>> = {
  en: {
    fields: {
      ruleId: 'This rule does not exist for the clinic. List the rules with GET /api/admin/rules.',
      dueInDays: 'The deadline must be a whole number of days, from 1 to 3650.',
      enabled: 'enabled must be true or false.',
      override: 'Give dueInDays, enabled, or both (or override: null to reset the rule).',
      reason: 'Say why the rule changes (1 to 500 characters): it is kept in the audit trail.',
      actor: 'Say who makes the change (X-FollowUp-User): it is kept in the audit trail.',
      unknownField: 'Only dueInDays and enabled can be overridden.',
    },
    invalid: 'The rule change is not valid.',
    staleVersion:
      'Someone changed this rule since you read it. Read it again and repeat the change.',
    unchanged: 'The rule already runs like this: nothing changed.',
    layers: {
      universal: 'Universal',
      doctor_plan: "Doctor's plan",
      cadence: 'Visit pattern',
      protocol: 'Protocol',
    },
  },
  es: {
    fields: {
      ruleId:
        'Esa regla no existe para el consultorio. Consulta las reglas con GET /api/admin/rules.',
      dueInDays: 'El plazo debe ser un número entero de días, de 1 a 3650.',
      enabled: 'enabled debe ser true o false.',
      override: 'Indica dueInDays, enabled o ambos (u override: null para restablecer la regla).',
      reason:
        'Indica por qué cambia la regla (de 1 a 500 caracteres): queda en el registro de auditoría.',
      actor: 'Indica quién hace el cambio (X-FollowUp-User): queda en el registro de auditoría.',
      unknownField: 'Solo se pueden ajustar dueInDays y enabled.',
    },
    invalid: 'El cambio de la regla no es válido.',
    staleVersion:
      'Alguien cambió esta regla desde que la leíste. Vuelve a leerla y repite el cambio.',
    unchanged: 'La regla ya funciona así: no hubo cambios.',
    layers: {
      universal: 'Universal',
      doctor_plan: 'Plan del médico',
      cadence: 'Patrón de visitas',
      protocol: 'Protocolo',
    },
  },
};

/** The labels of a locale; English when absent. */
export function adminRulesLabels(locale: AdminLocale = 'en'): AdminRulesLabels {
  return ADMIN_RULES_LABELS[locale];
}
