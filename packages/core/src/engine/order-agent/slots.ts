import type { OrderAgentLanguage, Slot, SlotResourceKind } from '../../domain/order-agent.ts';
import { addLocalDays, zonedInstant, zonedParts } from './zoned-time.ts';

/**
 * The clinic's synthetic schedule: the treating professional and two labs,
 * the same for every clinic (a sandbox has no real calendar). Code computes
 * every slot the agent may offer; the model only picks among them.
 */
export interface ScheduleResource {
  readonly key: string;
  readonly kind: SlotResourceKind;
  readonly name: Readonly<Record<OrderAgentLanguage, string>>;
  readonly location: Readonly<Record<OrderAgentLanguage, string>>;
  /** Local weekdays it works (0 = Sunday). */
  readonly weekdays: readonly number[];
  /** Local `HH:MM` of the first slot and the end of the last one. */
  readonly from: string;
  readonly to: string;
  readonly slotMinutes: number;
  /** Closer to most patients' homes: the "remove friction" rung prefers it. */
  readonly nearer?: boolean;
}

export const SYNTHETIC_SCHEDULE: readonly ScheduleResource[] = [
  {
    key: 'professional',
    kind: 'professional',
    name: { en: 'Dr. Elena Ruiz', es: 'Dra. Elena Ruiz' },
    location: { en: 'Office 2, main clinic', es: 'Consultorio 2, sede principal' },
    weekdays: [1, 2, 3, 4, 5],
    from: '08:00',
    to: '12:00',
    slotMinutes: 30,
  },
  {
    key: 'professional_saturday',
    kind: 'professional',
    name: { en: 'Dr. Elena Ruiz', es: 'Dra. Elena Ruiz' },
    location: { en: 'Saturday clinic, main clinic', es: 'Consulta de sábado, sede principal' },
    weekdays: [6],
    from: '09:00',
    to: '11:00',
    slotMinutes: 30,
  },
  {
    key: 'lab_central',
    kind: 'lab',
    name: { en: 'Central lab', es: 'Laboratorio central' },
    location: { en: 'Ground floor, main clinic', es: 'Planta baja, sede principal' },
    weekdays: [1, 2, 3, 4, 5],
    from: '07:00',
    to: '10:00',
    slotMinutes: 20,
  },
  {
    key: 'lab_north',
    kind: 'lab',
    name: { en: 'North lab', es: 'Laboratorio norte' },
    location: { en: 'North branch (closer to home)', es: 'Sede norte (más cerca de casa)' },
    weekdays: [1, 2, 3, 4, 5, 6],
    from: '07:00',
    to: '11:00',
    slotMinutes: 20,
    nearer: true,
  },
];

/**
 * How the agent wants slots chosen. `earliest`: the soonest free ones;
 * `other_time`: a different time of day than what was offered before;
 * `saturday`: Saturdays only; `nearer_lab`: the lab nearer to home (tests).
 * Urgent orders always stay within the next 7 days.
 */
export const SLOT_PREFERENCES = ['earliest', 'other_time', 'saturday', 'nearer_lab'] as const;
export type SlotPreference = (typeof SLOT_PREFERENCES)[number];

export const WEEKDAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;
export type WeekdayName = (typeof WEEKDAY_NAMES)[number];

export interface SlotQuery {
  readonly now: Date;
  readonly timeZone: string;
  readonly kind: SlotResourceKind;
  readonly preference: SlotPreference;
  /** Within the next 7 days only (urgent orders). Default: 21 days. */
  readonly urgent?: boolean;
  readonly excludeWeekdays?: readonly WeekdayName[];
  /** Slots already offered (not offered again) and their local hours (avoided by `other_time`). */
  readonly previouslyOffered?: readonly Slot[];
  /** Ids of slots already booked by anyone in the clinic. */
  readonly booked?: ReadonlySet<string>;
  /** How many to return (2–3). Default 3. */
  readonly count?: number;
}

/** Earliest start: a slot is never offered for less than this many hours ahead. */
export const MIN_LEAD_HOURS = 18;
const ROUTINE_HORIZON_DAYS = 21;
const URGENT_HORIZON_DAYS = 7;

function minutesOf(hhmm: string): number {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function compactUtc(date: Date): string {
  return date.toISOString().slice(0, 16).replace(/[-:]/g, '');
}

export function slotId(resource: string, start: Date): string {
  return `${resource}@${compactUtc(start)}Z`;
}

/**
 * A deterministic "already taken by other patients" mark (about a third of
 * the slots), so the synthetic calendar does not look empty.
 */
function takenByOthers(id: string): boolean {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 3 === 0;
}

function resourceSlots(
  resource: ScheduleResource,
  local: { readonly year: number; readonly month: number; readonly day: number },
  timeZone: string,
): Slot[] {
  const out: Slot[] = [];
  for (
    let minute = minutesOf(resource.from);
    minute + resource.slotMinutes <= minutesOf(resource.to);
    minute += resource.slotMinutes
  ) {
    const start = zonedInstant(local, Math.floor(minute / 60), minute % 60, timeZone);
    const id = slotId(resource.key, start);
    out.push({
      id,
      start,
      end: new Date(start.getTime() + resource.slotMinutes * 60_000),
      resourceKind: resource.kind,
      resource: resource.key,
      resourceName: resource.name.en,
      location: resource.location.en,
    });
  }
  return out;
}

function eligibleResources(kind: SlotResourceKind, preference: SlotPreference): ScheduleResource[] {
  return SYNTHETIC_SCHEDULE.filter((resource) => {
    if (resource.kind !== kind) return false;
    if (preference === 'nearer_lab' && kind === 'lab') return resource.nearer === true;
    return true;
  });
}

/**
 * Two or three free slots for an order, one per day, chosen by code from
 * the synthetic schedule: never in the past or within {@link MIN_LEAD_HOURS},
 * never booked or offered before, never on an excluded weekday; urgent
 * orders within the next 7 days.
 */
export function availableSlots(query: SlotQuery): Slot[] {
  const count = Math.min(3, Math.max(1, query.count ?? 3));
  const horizon = query.urgent === true ? URGENT_HORIZON_DAYS : ROUTINE_HORIZON_DAYS;
  const excluded = new Set(
    (query.excludeWeekdays ?? []).map((name) => WEEKDAY_NAMES.indexOf(name)),
  );
  const offered = new Set((query.previouslyOffered ?? []).map((slot) => slot.id));
  const offeredHours = new Set(
    (query.previouslyOffered ?? []).map((slot) => zonedParts(slot.start, query.timeZone).hour),
  );
  const earliest = query.now.getTime() + MIN_LEAD_HOURS * 3_600_000;
  const picked: Slot[] = [];
  for (let offset = 0; offset <= horizon && picked.length < count; offset += 1) {
    const local = addLocalDays(query.now, offset, query.timeZone);
    if (excluded.has(local.weekday)) continue;
    if (query.preference === 'saturday' && local.weekday !== 6) continue;
    const free = eligibleResources(query.kind, query.preference)
      .filter((resource) => resource.weekdays.includes(local.weekday))
      .flatMap((resource) => resourceSlots(resource, local, query.timeZone))
      .filter(
        (slot) =>
          slot.start.getTime() >= earliest &&
          !offered.has(slot.id) &&
          query.booked?.has(slot.id) !== true &&
          !takenByOthers(slot.id),
      )
      .sort((left, right) => left.start.getTime() - right.start.getTime());
    let choice: Slot | undefined;
    if (query.preference === 'other_time') {
      const different = free.filter(
        (slot) => !offeredHours.has(zonedParts(slot.start, query.timeZone).hour),
      );
      choice = different.at(-1) ?? free.at(-1);
    } else {
      choice = free[0];
    }
    if (choice !== undefined) picked.push(choice);
  }
  return picked;
}

/**
 * The slot an id names, when the schedule really has it (resource, day,
 * time) and nobody else holds it; `undefined` for a made-up id. Booking is
 * checked against this, never against what the model says a slot is.
 */
export function slotFromId(
  id: string,
  timeZone: string,
  booked?: ReadonlySet<string>,
): Slot | undefined {
  const match = /^([a-z_]+)@(\d{8})T(\d{4})Z$/.exec(id);
  if (match === null) return undefined;
  const [, key, day, time] = match;
  const resource = SYNTHETIC_SCHEDULE.find((item) => item.key === key);
  if (resource === undefined || day === undefined || time === undefined) return undefined;
  const start = new Date(
    `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2)}:00Z`,
  );
  if (Number.isNaN(start.getTime())) return undefined;
  const local = zonedParts(start, timeZone);
  if (!resource.weekdays.includes(local.weekday)) return undefined;
  const slot = resourceSlots(resource, local, timeZone).find((item) => item.id === id);
  if (slot === undefined || takenByOthers(id) || booked?.has(id) === true) return undefined;
  return slot;
}

const INTL_LOCALE: Readonly<Record<OrderAgentLanguage, string>> = { en: 'en-US', es: 'es-VE' };

/** "Tue, Jan 6, 9:00 AM" / "mar., 6 de ene., 09:00" in the clinic's time zone. */
export function formatSlotTime(
  slot: Pick<Slot, 'start'>,
  language: OrderAgentLanguage,
  timeZone: string,
): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[language], {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
  }).format(slot.start);
}

/** One line of the slot list code appends to an offer: time, who, where. */
export function formatSlotLine(slot: Slot, language: OrderAgentLanguage, timeZone: string): string {
  const resource = SYNTHETIC_SCHEDULE.find((item) => item.key === slot.resource);
  const name = resource?.name[language] ?? slot.resourceName;
  const location = resource?.location[language] ?? slot.location;
  return `${formatSlotTime(slot, language, timeZone)} · ${name} · ${location}`;
}
