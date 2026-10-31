// Execution counts of the order agent in a committed simulation report.
//
// The report (`pnpm simulate`, docs/evals/simulation/<date>.json) keeps
// per-run means and per-100 rates. Every run has the same number of patients
// per arm, so a mean per run times the number of runs is the exact total over
// all runs. This script turns those means into totals over every seeded run
// of the agent arm and writes them next to the report as Markdown.
//
// Usage: node scripts/simulation-execution-counts.mjs docs/evals/simulation/2026-10-30.json

import { readFileSync, writeFileSync } from 'node:fs';

const source = process.argv[2];
if (source === undefined) {
  process.stderr.write(
    'usage: node scripts/simulation-execution-counts.mjs <simulation report .json>\n',
  );
  process.exit(2);
}

const report = JSON.parse(readFileSync(source, 'utf8'));
const runs = report.perSeed.length;
const patientsPerArm = report.cohort.patientsPerArm;

/** Totals over every run of one arm. */
function totals(armName) {
  const arm = report.arms[armName];
  const patients = patientsPerArm * runs;
  const perPatient = (metric) => Math.round(metric.mean * patients);
  const per100 = (metric) => Math.round((metric.mean / 100) * patients);
  const outbound = perPatient(arm.messagesPerPatient);
  const proactive = perPatient(arm.proactivePerPatient);
  const staffTasks =
    per100(arm.tasksPer100.call_patient) +
    per100(arm.tasksPer100.update_phone) +
    per100(arm.tasksPer100.call_other_contact);
  return {
    patients,
    ordersDetected: report.perSeed.reduce((sum, seed) => sum + seed[armName].orders, 0),
    ordersClosedByEngine: report.perSeed.reduce((sum, seed) => sum + seed[armName].fulfilled, 0),
    proactive,
    replies: outbound - proactive,
    consultationsBooked: per100(arm.consultationsBookedPer100),
    staffTasks,
    doctorNotices: per100(arm.tasksPer100.doctor_notice),
    callsAnswered: per100(arm.callsAnsweredPer100),
    optedOut: perPatient(arm.optedOutShare),
  };
}

const control = totals('control');
const agent = totals('agent');
const format = (value) => value.toLocaleString('en-US');

const rows = [
  ['Synthetic patients', 'patients', 'cohort'],
  [
    'Orders the engine detected (doctor’s orders and their direct consequences)',
    'ordersDetected',
    '`perSeed[].orders`',
  ],
  [
    'Proactive messages sent (first contacts, ladder rungs, fixed reminders)',
    'proactive',
    '`proactivePerPatient`',
  ],
  ['Replies sent to a patient’s message', 'replies', '`messagesPerPatient − proactivePerPatient`'],
  ['Consultations booked', 'consultationsBooked', '`consultationsBookedPer100`'],
  [
    'Tasks for reception (calls, phone updates, other contact)',
    'staffTasks',
    '`tasksPer100` without `doctor_notice`',
  ],
  ['Notices to the doctor', 'doctorNotices', '`tasksPer100.doctor_notice`'],
  ['Reception calls the patient answered', 'callsAnswered', '`callsAnsweredPer100`'],
  ['Patients who opted out', 'optedOut', '`optedOutShare`'],
  ['Orders the engine closed as fulfilled', 'ordersClosedByEngine', '`perSeed[].fulfilled`'],
];

const lines = [
  '# Execution counts of the 90-day simulation',
  '',
  `> ${report.notice} Synthetic test, not real patients.`,
  '',
  `Totals over all ${String(runs)} seeded runs of \`${report.configVersion}\` (${format(patientsPerArm)} synthetic patients per arm per run), read from [\`${source.split('/').pop()}\`](${source.split('/').pop()}) by \`scripts/simulation-execution-counts.mjs\`. A mean per run times ${String(runs)} is the exact total, since every run has the same number of patients. Every message, booking, task and closed order went through the engine's real code (docs/simulation.md); "closed" is the engine's own status of the order at day 90.`,
  '',
  '| Count | Order agent | Fixed reminders | Report field |',
  '| --- | --: | --: | --- |',
  ...rows.map(
    ([label, key, field]) =>
      `| ${label} | ${format(agent[key])} | ${format(control[key])} | ${field} |`,
  ),
  '',
  `Reproduce: \`node scripts/simulation-execution-counts.mjs ${source}\`, then \`pnpm format\`.`,
  '',
];

const target = source.replace(/\.json$/, '-execution-counts.md');
writeFileSync(target, lines.join('\n'));
process.stdout.write(`${target}\n${lines.join('\n')}`);
