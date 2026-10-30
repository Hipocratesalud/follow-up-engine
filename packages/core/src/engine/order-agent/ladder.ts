import type { LadderState, LadderTrack, StaffTaskPriority } from '../../domain/order-agent.ts';
import type { SlotPreference } from './slots.ts';

/**
 * The no-response ladder (docs/agent/order-to-completion.md#ladder). Timing
 * is code: each rung fires at a fixed offset from the track's anchor (its
 * first message, or the fix of a phone) on the clinic's clock. The model
 * only words a `message` rung, within its `brief`.
 */
export const LADDER_ACTIONS = [
  'message',
  'call_task',
  'doctor_notice',
  'update_phone_task',
  'other_contact_task',
  'unreachable',
] as const;
export type LadderAction = (typeof LADDER_ACTIONS)[number];

/** What a message rung asks of the wording (sent to the model as the rung's brief). */
export const LADDER_BRIEFS = [
  'first_contact',
  'other_times',
  'remove_friction',
  'urgent_this_week',
  'urgent_other_hour',
] as const;
export type LadderBrief = (typeof LADDER_BRIEFS)[number];

export interface LadderRung {
  /** `<track>:<offset>`, for example `routine:4d`. */
  readonly id: string;
  readonly track: LadderTrack;
  readonly offsetHours: number;
  readonly action: LadderAction;
  readonly brief?: LadderBrief;
  readonly slotPreference?: SlotPreference;
  readonly priority?: StaffTaskPriority;
}

const DAY = 24;

export const LADDER: Readonly<Record<LadderTrack, readonly LadderRung[]>> = {
  routine: [
    {
      id: 'routine:0d',
      track: 'routine',
      offsetHours: 0,
      action: 'message',
      brief: 'first_contact',
      slotPreference: 'earliest',
    },
    {
      id: 'routine:4d',
      track: 'routine',
      offsetHours: 4 * DAY,
      action: 'message',
      brief: 'other_times',
      slotPreference: 'other_time',
    },
    {
      id: 'routine:9d',
      track: 'routine',
      offsetHours: 9 * DAY,
      action: 'message',
      brief: 'remove_friction',
      slotPreference: 'saturday',
    },
    {
      id: 'routine:14d',
      track: 'routine',
      offsetHours: 14 * DAY,
      action: 'call_task',
      priority: 'normal',
    },
    { id: 'routine:21d', track: 'routine', offsetHours: 21 * DAY, action: 'unreachable' },
  ],
  urgent: [
    {
      id: 'urgent:0h',
      track: 'urgent',
      offsetHours: 0,
      action: 'message',
      brief: 'urgent_this_week',
      slotPreference: 'earliest',
    },
    {
      id: 'urgent:1d',
      track: 'urgent',
      offsetHours: DAY,
      action: 'message',
      brief: 'urgent_other_hour',
      slotPreference: 'other_time',
    },
    {
      id: 'urgent:2d',
      track: 'urgent',
      offsetHours: 2 * DAY,
      action: 'call_task',
      priority: 'high',
    },
    {
      id: 'urgent:3d',
      track: 'urgent',
      offsetHours: 3 * DAY,
      action: 'doctor_notice',
      priority: 'high',
    },
    { id: 'urgent:7d', track: 'urgent', offsetHours: 7 * DAY, action: 'unreachable' },
  ],
  undelivered: [
    { id: 'undelivered:0d', track: 'undelivered', offsetHours: 0, action: 'update_phone_task' },
    {
      id: 'undelivered:7d',
      track: 'undelivered',
      offsetHours: 7 * DAY,
      action: 'other_contact_task',
    },
    { id: 'undelivered:14d', track: 'undelivered', offsetHours: 14 * DAY, action: 'unreachable' },
  ],
};

/** An unreachable routine order is tried again after this many days. */
export const UNREACHABLE_RETRY_DAYS = 30;

export function rungById(id: string): LadderRung | undefined {
  for (const rungs of Object.values(LADDER)) {
    const rung = rungs.find((item) => item.id === id);
    if (rung !== undefined) return rung;
  }
  return undefined;
}

export function rungDueAt(state: Pick<LadderState, 'anchorAt'>, rung: LadderRung): Date {
  return new Date(state.anchorAt.getTime() + rung.offsetHours * 3_600_000);
}

/**
 * The rungs of the track due by `now` and not applied yet, in order. While
 * the patient has written since the anchor the ladder waits (the
 * conversation is live): it starts again from the agent's next message.
 * The undelivered track never waits on replies (the phone is broken).
 */
export function dueRungs(
  state: LadderState,
  now: Date,
  lastInboundAt: Date | undefined,
): LadderRung[] {
  if (
    state.track !== 'undelivered' &&
    lastInboundAt !== undefined &&
    lastInboundAt.getTime() >= state.anchorAt.getTime()
  ) {
    return [];
  }
  return LADDER[state.track].filter(
    (rung) => !state.done.includes(rung.id) && rungDueAt(state, rung).getTime() <= now.getTime(),
  );
}

/** Every rung of the current track with its due date and whether it was applied (the console's ladder). */
export function ladderTimeline(
  state: LadderState,
): readonly { readonly rung: LadderRung; readonly dueAt: Date; readonly done: boolean }[] {
  return LADDER[state.track].map((rung) => ({
    rung,
    dueAt: rungDueAt(state, rung),
    done: state.done.includes(rung.id),
  }));
}

/** A fresh track anchored at `at`; its first rung counts as done when the caller already applied it. */
export function startTrack(
  track: LadderTrack,
  at: Date,
  options: { readonly firstDone?: boolean; readonly resumeTrack?: LadderState['resumeTrack'] } = {},
): LadderState {
  const first = LADDER[track][0];
  return {
    track,
    anchorAt: at,
    done: options.firstDone === true && first !== undefined ? [first.id] : [],
    ...(options.resumeTrack === undefined ? {} : { resumeTrack: options.resumeTrack }),
  };
}
