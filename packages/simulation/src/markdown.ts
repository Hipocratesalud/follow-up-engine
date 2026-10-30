import { PERSONA_IDS } from './config.ts';
import type { Interval, SimulationReport } from './report.ts';

/** The report as markdown (docs/evals/simulation/<date>.md). English, numbers rounded for reading. */

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function pctInterval(interval: Interval): string {
  return `${pct(interval.mean)} (${pct(interval.low)}–${pct(interval.high)})`;
}

function points(interval: Interval): string {
  const sign = (value: number): string =>
    `${value >= 0 ? '+' : '−'}${Math.abs(value * 100).toFixed(1)}`;
  return `${sign(interval.mean)} points (${sign(interval.low)} to ${sign(interval.high)})`;
}

function num(interval: Interval, digits = 1): string {
  return `${interval.mean.toFixed(digits)} (${interval.low.toFixed(digits)}–${interval.high.toFixed(digits)})`;
}

function signedNum(interval: Interval, digits = 1): string {
  const sign = (value: number): string =>
    `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}`;
  return `${sign(interval.mean)} (${sign(interval.low)} to ${sign(interval.high)})`;
}

function money(interval: Interval, currency: string): string {
  const format = (value: number): string =>
    `${currency} ${Math.round(value).toLocaleString('en-US')}`;
  return `${format(interval.mean)} (${format(interval.low)}–${format(interval.high)})`;
}

/** The headline sentence of the report. */
export function headline(report: SimulationReport): string {
  const { control, agent } = report.arms;
  return (
    `Orders fulfilled within ${String(report.cohort.horizonDays)} days: ` +
    `${pct(control.fulfilledShare.mean)} with fixed reminders → ${pct(agent.fulfilledShare.mean)} with the order agent ` +
    `(${points(report.difference.fulfilledShare)}, 95% interval over ${String(report.seeds.length)} seeded runs).`
  );
}

export function renderMarkdown(report: SimulationReport): string {
  const { control, agent } = report.arms;
  const { economics } = report;
  const lines: string[] = [
    '# 90-day outcome simulation: order agent vs fixed reminders',
    '',
    `> ${report.notice}`,
    '',
    `**${headline(report)}**`,
    '',
    `Config \`${report.configVersion}\`, report \`${report.reportVersion}\`. ` +
      `${String(report.cohort.patientsPerArm)} synthetic patients per arm, orders placed over the first ` +
      `${String(report.cohort.enrolmentDays)} days, observed until day ${String(report.cohort.horizonDays)}; ` +
      `seeds ${String(report.seeds[0] ?? 0)}–${String(report.seeds.at(-1) ?? 0)}. ` +
      'Every value is the mean over seeds with the 95% interval across seeds in parentheses. ' +
      '"Fulfilled" is the engine\'s own status of the order at the end: the simulation never marks an order done. ' +
      'Method and assumptions: docs/simulation.md. Reproduce with `pnpm simulate`.',
    '',
    '## Arms',
    '',
    '| Metric | Control (fixed reminders) | Order agent | Difference (paired by seed) |',
    '| --- | --- | --- | --- |',
    `| Orders fulfilled | ${pctInterval(control.fulfilledShare)} | ${pctInterval(agent.fulfilledShare)} | ${points(report.difference.fulfilledShare)} |`,
    `| Median days to fulfilment | ${num(control.medianDaysToFulfilment)} | ${num(agent.medianDaysToFulfilment)} | ${signedNum(report.difference.medianDaysToFulfilment)} |`,
    `| Urgent orders fulfilled within 7 days | ${pctInterval(control.urgentWithin7Share)} | ${pctInterval(agent.urgentWithin7Share)} | ${points(report.difference.urgentWithin7Share)} |`,
    `| Urgent orders fulfilled within 14 days | ${pctInterval(control.urgentWithin14Share)} | ${pctInterval(agent.urgentWithin14Share)} | ${points(report.difference.urgentWithin14Share)} |`,
    `| Patients unreachable (open order, never replied or answered) | ${pctInterval(control.unreachableShare)} | ${pctInterval(agent.unreachableShare)} | ${points(report.difference.unreachableShare)} |`,
    `| Patients the ladder marked unreachable | ${pctInterval(control.markedUnreachableShare)} | ${pctInterval(agent.markedUnreachableShare)} | |`,
    `| Patients who opted out | ${pctInterval(control.optedOutShare)} | ${pctInterval(agent.optedOutShare)} | |`,
    `| Messages sent per patient | ${num(control.messagesPerPatient, 2)} | ${num(agent.messagesPerPatient, 2)} | |`,
    `| Proactive messages per patient | ${num(control.proactivePerPatient, 2)} | ${num(agent.proactivePerPatient, 2)} | |`,
    `| Most proactive messages to one patient in 7 days (cap 2) | ${String(control.maxProactiveIn7Days)} | ${String(agent.maxProactiveIn7Days)} | |`,
    `| Staff tasks per 100 patients | ${num(control.tasksPer100.total)} | ${num(agent.tasksPer100.total)} | |`,
    `| · reception calls | ${num(control.tasksPer100.call_patient)} | ${num(agent.tasksPer100.call_patient)} | |`,
    `| · notices to the doctor | ${num(control.tasksPer100.doctor_notice)} | ${num(agent.tasksPer100.doctor_notice)} | |`,
    `| · phone updates | ${num(control.tasksPer100.update_phone)} | ${num(agent.tasksPer100.update_phone)} | |`,
    `| · other-contact calls | ${num(control.tasksPer100.call_other_contact)} | ${num(agent.tasksPer100.call_other_contact)} | |`,
    `| Consultations booked per 100 patients | ${num(control.consultationsBookedPer100)} | ${num(agent.consultationsBookedPer100)} | |`,
    `| Consultations attended per 100 patients | ${num(control.consultationsAttendedPer100)} | ${num(agent.consultationsAttendedPer100)} | ${signedNum(report.difference.consultationsAttendedPer100)} |`,
    `| Lab visits attended per 100 patients | ${num(control.labVisitsAttendedPer100)} | ${num(agent.labVisitsAttendedPer100)} | |`,
    '',
    '## Orders by kind',
    '',
    '| Kind | Orders per run (control / agent) | Control fulfilled | Agent fulfilled |',
    '| --- | --- | --- | --- |',
    ...(['lab', 'imaging', 'visit', 'urgent'] as const).map(
      (kind) =>
        `| ${kind} | ${control.byKind[kind].orders.mean.toFixed(0)} / ${agent.byKind[kind].orders.mean.toFixed(0)} | ${pctInterval(control.byKind[kind].fulfilledShare)} | ${pctInterval(agent.byKind[kind].fulfilledShare)} |`,
    ),
    '',
    '## How orders were fulfilled (share of all orders, from the resource that closed them)',
    '',
    '| Path | Control | Agent |',
    '| --- | --- | --- |',
    ...(['self', 'reminder', 'agent', 'staff', 'photo'] as const).map(
      (path) =>
        `| ${path} | ${pctInterval(control.paths[path])} | ${pctInterval(agent.paths[path])} |`,
    ),
    '',
    '## By persona (orders fulfilled)',
    '',
    '| Persona | Share of patients | Control | Agent | Difference |',
    '| --- | --- | --- | --- | --- |',
    ...PERSONA_IDS.map((id) => {
      const row = report.personas.find((persona) => persona.persona === id);
      return row === undefined
        ? `| ${id} | | | | |`
        : `| ${id} | ${pct(row.weight)} | ${pctInterval(row.control)} | ${pctInterval(row.agent)} | ${points(row.difference)} |`;
    }),
    '',
    '## Economics (assumption: price per consultation)',
    '',
    `At ${String(economics.patientsPerMonth)} patients with new orders per month and ${economics.currency} ${String(economics.consultationPrice)} per consultation: ` +
      `${num(economics.recoveredConsultationsPerMonth)} more attended consultations per month, about ` +
      `${money(economics.recoveredRevenuePerMonth, economics.currency)} per month. Only attended consultations count; lab and imaging revenue is not included.`,
    '',
    '## Invariants checked on this run',
    '',
    `- Most proactive messages to any patient in any 7 days: ${String(report.invariants.maxProactiveIn7Days)} (cap 2).`,
    `- Agent actions in the control arm: ${String(report.invariants.controlAgentActions)}.`,
    `- Orders with no engine expectation: ${String(report.invariants.unmappedOrders)}.`,
    '',
    '## Personas',
    '',
    ...report.personaConfig.map(
      (persona) =>
        `- **${persona.id}** (${pct(persona.weight)}): ${persona.summary} ${persona.rationale}`,
    ),
    '',
    '## Assumptions',
    '',
    ...report.assumptions.map((assumption) => `- ${assumption}`),
    '',
  ];
  return lines.join('\n');
}
