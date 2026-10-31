# Execution counts of the 90-day simulation

> Simulation with synthetic patients and stated assumptions; not a clinical trial. Synthetic test, not real patients.

Totals over all 20 seeded runs of `simulation.v1` (400 synthetic patients per arm per run), read from [`2026-10-30.json`](2026-10-30.json) by `scripts/simulation-execution-counts.mjs`. A mean per run times 20 is the exact total, since every run has the same number of patients. Every message, booking, task and closed order went through the engine's real code (docs/simulation.md); "closed" is the engine's own status of the order at day 90.

| Count                                                                      | Order agent | Fixed reminders | Report field                               |
| -------------------------------------------------------------------------- | ----------: | --------------: | ------------------------------------------ |
| Synthetic patients                                                         |       8,000 |           8,000 | cohort                                     |
| Orders the engine detected (doctor’s orders and their direct consequences) |       9,038 |           9,058 | `perSeed[].orders`                         |
| Proactive messages sent (first contacts, ladder rungs, fixed reminders)    |      19,193 |          14,330 | `proactivePerPatient`                      |
| Replies sent to a patient’s message                                        |       8,267 |               0 | `messagesPerPatient − proactivePerPatient` |
| Consultations booked                                                       |       3,353 |           1,355 | `consultationsBookedPer100`                |
| Tasks for reception (calls, phone updates, other contact)                  |       3,916 |               0 | `tasksPer100` without `doctor_notice`      |
| Notices to the doctor                                                      |       2,457 |               0 | `tasksPer100.doctor_notice`                |
| Reception calls the patient answered                                       |         964 |               0 | `callsAnsweredPer100`                      |
| Patients who opted out                                                     |         211 |             193 | `optedOutShare`                            |
| Orders the engine closed as fulfilled                                      |       6,740 |           4,586 | `perSeed[].fulfilled`                      |

Reproduce: `node scripts/simulation-execution-counts.mjs docs/evals/simulation/2026-10-30.json`, then `pnpm format`.
