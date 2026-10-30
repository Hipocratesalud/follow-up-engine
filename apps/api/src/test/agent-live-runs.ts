import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

/*
 * Records the order-to-completion agent's evidence runs
 * (docs/agent/order-to-completion.md#recording-a-live-run) against a running
 * demo server (`pnpm demo`, fake clock, `/api/demo/agent/*`), in live mode
 * (Muse Spark on the Meta Model API when the server has `META_API_KEY`), and
 * saves each run as `<path>.json` (the server's export: trace, `llm_gateway`
 * usage rows, engine expectations, clinical events, case audit, plus what
 * this driver did and when) and `<path>.md` (the same, readable).
 *
 * Each path runs in its own lab clinic (its own evaluator email, so its own
 * clock): a clock jump of one path never moves another. Synthetic data only.
 *
 *   node --experimental-strip-types --no-warnings=ExperimentalWarning \
 *     apps/api/src/test/agent-live-runs.ts --base http://localhost:4391 \
 *     --code <DEMO_ACCESS_CODE> --out docs/evidence/agent-runs/2026-10-30 \
 *     [--paths booking,voice,ladder,undelivered] [--mode live|scripted]
 *
 * Paths: `booking` = (2) reschedule "not Tuesday", (1) confirmation, (3) a
 * photo the engine closes, (4) the abnormal result handed to the doctor;
 * `voice` = (5) a voice note; `ladder` = (6) the no-response ladder to a
 * staff call; `undelivered` = (7) an undelivered message to a phone-fix task.
 */

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:4391' },
    code: { type: 'string' },
    out: { type: 'string' },
    paths: { type: 'string', default: 'booking,voice,ladder,undelivered' },
    mode: { type: 'string', default: 'live' },
    'api-key': { type: 'string', default: 'demo-inbox-key' },
    'email-prefix': { type: 'string', default: 'agent-evidence' },
  },
});

const base = values.base.replace(/\/+$/, '');
const accessCode = values.code ?? process.env['DEMO_ACCESS_CODE'];
if (accessCode === undefined || accessCode === '')
  throw new Error('--code (DEMO_ACCESS_CODE) is required');
if (values.out === undefined) throw new Error('--out <dir> is required');
const outDir = values.out;
const mode = values.mode === 'scripted' ? 'scripted' : 'live';
const apiKey = values['api-key'];

interface DriverAction {
  readonly at: string;
  readonly action: string;
  readonly detail?: unknown;
}

interface Session {
  readonly email: string;
  readonly cookie: string;
  readonly actions: DriverAction[];
}

async function login(email: string): Promise<Session> {
  const response = await fetch(`${base}/_access`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, code: accessCode ?? '', next: '/agent' }).toString(),
    redirect: 'manual',
  });
  const cookies = response.headers.getSetCookie().map((item) => item.split(';')[0] ?? '');
  if (cookies.length < 2)
    throw new Error(`login failed for ${email}: HTTP ${String(response.status)}`);
  return { email, cookie: cookies.join('; '), actions: [] };
}

async function api<T>(
  session: Session,
  path: string,
  init: { readonly method?: string; readonly json?: unknown; readonly form?: FormData } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    cookie: session.cookie,
    accept: 'application/json',
    'accept-language': 'en',
  };
  let body: string | FormData | undefined;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.form !== undefined) {
    body = init.form;
  }
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${path}: HTTP ${String(response.status)} ${text.slice(0, 300)}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

function act(session: Session, action: string, detail?: unknown): void {
  session.actions.push({
    at: new Date().toISOString(),
    action,
    ...(detail === undefined ? {} : { detail }),
  });
  process.stdout.write(`[${session.email}] ${action}\n`);
}

interface Page {
  readonly conversation: { readonly busy: boolean; readonly status: string } | null;
  readonly messages: readonly {
    readonly id: string;
    readonly direction: string;
    readonly text: string;
  }[];
  readonly steps: readonly unknown[];
  readonly runs: readonly { readonly status: string }[];
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Waits until the agent is idle: nothing running or queued for the patient, and the trace still. */
async function settle(session: Session, patientId: string, timeoutMs = 300_000): Promise<Page> {
  const started = Date.now();
  let lastSteps = -1;
  let still = 0;
  for (;;) {
    const page = await api<Page>(session, `/api/demo/agent?patientId=${patientId}`);
    const running = page.runs.some((run) => run.status === 'running');
    if (!running && page.conversation?.busy !== true && page.steps.length === lastSteps) {
      still += 1;
      if (still >= 4) return page;
    } else {
      still = 0;
    }
    lastSteps = page.steps.length;
    if (Date.now() - started > timeoutMs)
      throw new Error(`agent still busy after ${String(timeoutMs)} ms`);
    await sleep(1_500);
  }
}

async function startStory(session: Session, language: 'en' | 'es'): Promise<string> {
  act(session, `start story maria (${mode}, ${language})`);
  const { patientId } = await api<{ patientId: string }>(session, '/api/demo/agent/story', {
    json: { story: 'maria', mode, language },
  });
  await settle(session, patientId);
  return patientId;
}

async function say(session: Session, patientId: string, text: string): Promise<void> {
  act(session, 'patient writes', { text });
  await api(session, `/api/demo/agent/patients/${patientId}/messages`, { json: { text } });
  await settle(session, patientId);
}

async function sample(
  session: Session,
  patientId: string,
  name: 'lab_report' | 'voice_note',
): Promise<void> {
  act(
    session,
    `patient sends the sample ${name === 'lab_report' ? 'lab report photo' : 'voice note'}`,
  );
  await api(session, `/api/demo/agent/patients/${patientId}/samples`, { json: { sample: name } });
  await settle(session, patientId);
}

async function jump(session: Session, patientId: string, days: number): Promise<void> {
  act(session, `clock jumps ${String(days)} days`);
  await api(session, '/api/demo/agent/clock', { json: { days } });
  await sleep(2_000);
  await settle(session, patientId);
}

// --- Rendering --------------------------------------------------------------------------

interface Exported {
  readonly exportedAt: string;
  readonly patientId: string;
  readonly timeZone: string;
  readonly conversation: Record<string, unknown>;
  readonly messages: readonly {
    readonly id: string;
    readonly direction: string;
    readonly kind: string;
    readonly text: string;
    readonly at: string;
    readonly deliveryStatus?: string;
    readonly transcript?: string;
  }[];
  readonly steps: readonly {
    readonly seq: number;
    readonly at: string;
    readonly kind: string;
    readonly outcome: string;
    readonly event: string;
    readonly runId?: string;
    readonly tool?: string;
    readonly arguments?: Record<string, unknown>;
    readonly read?: readonly string[];
    readonly reason?: string;
    readonly params?: Record<string, unknown>;
    readonly model?: string;
    readonly costUsd?: number;
    readonly latencyMs?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  }[];
  readonly runs: readonly {
    readonly id: string;
    readonly trigger: string;
    readonly costUsd: number;
    readonly modelCalls: number;
    readonly model?: string;
    readonly rung?: string;
    readonly status: string;
    readonly stopReason?: string;
  }[];
  readonly tasks: readonly {
    readonly kind: string;
    readonly priority: string;
    readonly status: string;
    readonly rung?: string;
    readonly summary: { readonly ask: string; readonly orders: readonly string[] };
    readonly createdAt: string;
  }[];
  readonly appointments: readonly Record<string, unknown>[];
  readonly findings: readonly {
    readonly category: string;
    readonly summary: string;
    readonly suggestion: string;
    readonly mode: string;
    readonly modelId: string;
    readonly citations: readonly {
      readonly quote: string;
      readonly title: string;
      readonly date: string;
      readonly docId: string;
    }[];
  }[];
  readonly llmUsage: readonly {
    readonly callId: string;
    readonly task: string;
    readonly provider: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
    readonly latencyMs: number;
    readonly ok: boolean;
    readonly error?: string;
    readonly at: string;
  }[];
  readonly engine: {
    readonly expectations: readonly {
      readonly id: string;
      readonly ruleId: string;
      readonly layer: string;
      readonly status: string;
      readonly matchKey: string;
      readonly closedAt?: string;
      readonly closedBy?: string;
      readonly closedReason?: string;
      readonly agentOwned: boolean;
    }[];
    readonly clinicalEvents: readonly {
      readonly type: string;
      readonly source: string;
      readonly occurredAt: string;
      readonly recordedAt?: string;
    }[];
    readonly cases: readonly {
      readonly id?: string;
      readonly status?: string;
      readonly resolution?: string;
      readonly audit: readonly {
        readonly type: string;
        readonly actor: { readonly type: string; readonly id?: string };
        readonly payload: Record<string, unknown>;
        readonly at: string;
      }[];
    }[];
  };
}

function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}

function cell(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderMarkdown(
  title: string,
  purpose: string,
  run: Exported,
  actions: readonly DriverAction[],
): string {
  const lines: string[] = [];
  const total = run.llmUsage.reduce((sum, call) => sum + call.costUsd, 0);
  const models = [...new Set(run.llmUsage.map((call) => `${call.provider}:${call.model}`))];
  lines.push(`# ${title}`, '', purpose, '');
  lines.push(
    `- Patient (synthetic): \`${run.patientId}\`, conversation ${cell(run.conversation['language'])}, mode ${cell(run.conversation['mode'])}, final status ${cell(run.conversation['status'])}`,
    `- Models called (llm_gateway usage log): ${models.map((model) => `\`${model}\``).join(', ')}`,
    `- LLM cost of this run (sum of the usage rows below): **${usd(total)}** over ${String(run.llmUsage.length)} provider calls`,
    `- Exported at (clinic clock): ${run.exportedAt}; clinic time zone ${run.timeZone}`,
    '',
    '## What the driver did (wall clock)',
    '',
    '| Wall clock (UTC) | Action |',
    '| --- | --- |',
    ...actions.map(
      (item) =>
        `| ${item.at} | ${cell(item.action)}${item.detail === undefined ? '' : ` ${cell(item.detail)}`} |`,
    ),
    '',
    '## Conversation (as the patient’s phone shows it)',
    '',
  );
  for (const message of run.messages) {
    const who = message.direction === 'outbound' ? 'Agent →' : '← Patient';
    const kind = message.kind === 'text' ? '' : ` [${message.kind}]`;
    const status = message.deliveryStatus === undefined ? '' : ` _(${message.deliveryStatus})_`;
    lines.push(
      `**${who}**${kind} · ${message.at}${status}`,
      '',
      `> ${message.text.replace(/\n/g, '\n> ') || '(media)'}`,
      '',
    );
  }
  lines.push('## Console trace (every model call and tool call)', '');
  lines.push(
    'Each model call shows the model, tokens and cost the gateway reported, and its gateway call id (the matching usage row is below). Each tool call shows its arguments, what it read, its outcome and result parameters.',
    '',
  );
  let currentRun: string | undefined;
  for (const step of run.steps) {
    if (step.runId !== currentRun && step.runId !== undefined) {
      currentRun = step.runId;
      const meta = run.runs.find((item) => item.id === step.runId);
      lines.push(
        '',
        `### Turn \`${step.runId}\`${meta === undefined ? '' : ` · trigger ${meta.trigger}${meta.rung === undefined ? '' : ` (${meta.rung})`} · ${String(meta.modelCalls)} model calls · ${usd(meta.costUsd)} · ${meta.status}${meta.stopReason === undefined ? '' : `/${meta.stopReason}`}`}`,
        '',
      );
    }
    const head = `- \`#${String(step.seq)}\` ${step.at} · **${step.kind}** · \`${step.event}\` · ${step.outcome}${step.tool === undefined ? '' : ` · tool \`${step.tool}\``}`;
    lines.push(head);
    if (step.model !== undefined) {
      lines.push(
        `  - model \`${step.model}\` · in ${String(step.inputTokens ?? 0)} / out ${String(step.outputTokens ?? 0)} tokens · ${usd(step.costUsd ?? 0)} · ${String(step.latencyMs ?? 0)} ms`,
      );
    }
    if (step.reason !== undefined && step.reason !== '')
      lines.push(`  - reason: ${cell(step.reason)}`);
    if (step.arguments !== undefined && Object.keys(step.arguments).length > 0) {
      lines.push(`  - input: \`${cell(step.arguments)}\``);
    }
    if (step.read !== undefined && step.read.length > 0)
      lines.push(`  - read: ${step.read.join(', ')}`);
    if (step.params !== undefined && Object.keys(step.params).length > 0) {
      lines.push(`  - output: \`${cell(step.params)}\``);
    }
  }
  lines.push('', '## LLM usage log rows (llm_gateway, this lab clinic)', '');
  lines.push(
    '| Call id | Task | Provider:model | In | Out | Cost (USD) | Latency ms | OK | At (engine clock) |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const call of run.llmUsage) {
    lines.push(
      `| \`${call.callId}\` | ${call.task} | ${call.provider}:${call.model} | ${String(call.inputTokens)} | ${String(call.outputTokens)} | ${usd(call.costUsd)} | ${String(call.latencyMs)} | ${call.ok ? 'yes' : `no: ${cell(call.error ?? '')}`} | ${call.at} |`,
    );
  }
  lines.push('', `**Total: ${usd(total)}**`, '');
  lines.push('## Staff tasks', '');
  if (run.tasks.length === 0) lines.push('None.');
  for (const task of run.tasks) {
    lines.push(
      `- ${task.kind} (${task.priority}, ${task.status})${task.rung === undefined ? '' : `, rung ${task.rung}`}: ask \`${task.summary.ask}\`, orders ${task.summary.orders.join(', ') || 'none'} · created ${task.createdAt}`,
    );
  }
  lines.push('', '## For the doctor (clinical reviewer findings with citations)', '');
  if (run.findings.length === 0) lines.push('None.');
  for (const finding of run.findings) {
    lines.push(
      `- **${finding.category}** (${finding.mode}, ${finding.modelId}): ${finding.summary} — ${finding.suggestion}`,
    );
    for (const citation of finding.citations) {
      lines.push(
        `  - “${citation.quote}” — ${citation.title}, ${citation.date.slice(0, 10)} (\`${citation.docId}\`)`,
      );
    }
  }
  lines.push('', '## Engine side', '', '### Expectations of the patient', '');
  lines.push(
    '| Expectation | Rule | Layer | Agent owns | Status | Closed by | Closed at | Reason |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const item of run.engine.expectations) {
    lines.push(
      `| \`${item.id}\` | ${item.ruleId} | ${item.layer} | ${item.agentOwned ? 'yes' : 'no'} | ${item.status} | ${item.closedBy ?? ''} | ${item.closedAt ?? ''} | ${cell(item.closedReason ?? '')} |`,
    );
  }
  lines.push('', '### Clinical events ingested (FHIR → engine)', '');
  for (const event of run.engine.clinicalEvents) {
    lines.push(
      `- \`${event.type}\` from \`${event.source}\` (occurred ${event.occurredAt}${event.recordedAt === undefined ? '' : `, recorded ${event.recordedAt}`})`,
    );
  }
  lines.push('', '### Case audit trail', '');
  for (const item of run.engine.cases) {
    lines.push(
      `- Case \`${item.id ?? '?'}\`: ${item.status ?? '?'}${item.resolution === undefined ? '' : ` (${item.resolution})`}`,
    );
    for (const event of item.audit) {
      lines.push(
        `  - ${event.at} · \`${event.type}\` · actor ${event.actor.type}${event.actor.id === undefined ? '' : `:${event.actor.id}`} · ${cell(event.payload)}`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function save(
  session: Session,
  patientId: string,
  name: string,
  title: string,
  purpose: string,
): Promise<number> {
  const run = await api<Exported>(session, `/api/demo/agent/patients/${patientId}/export`);
  await mkdir(outDir, { recursive: true });
  const document = {
    path: name,
    title,
    purpose,
    driver: { email: session.email, actions: session.actions },
    run,
  };
  await writeFile(join(outDir, `${name}.json`), `${JSON.stringify(document, null, 2)}\n`);
  await writeFile(join(outDir, `${name}.md`), renderMarkdown(title, purpose, run, session.actions));
  const total = run.llmUsage.reduce((sum, call) => sum + call.costUsd, 0);
  process.stdout.write(`saved ${name}: ${String(run.llmUsage.length)} calls, ${usd(total)}\n`);
  return total;
}

// --- The paths --------------------------------------------------------------------------

const prefix = values['email-prefix'];
const paths = new Set(values.paths.split(',').map((item) => item.trim()));
let spent = 0;

if (paths.has('booking')) {
  const session = await login(`${prefix}-booking@example.com`);
  const patientId = await startStory(session, 'es');
  await say(
    session,
    patientId,
    'Hola. Ya me hice el examen la semana pasada, pero el martes no puedo.',
  );
  const page = await api<Page>(session, `/api/demo/agent?patientId=${patientId}`);
  act(session, 'checkpoint: new options offered', { lastAgentMessage: page.messages.at(-1)?.text });
  await say(session, patientId, 'La 2 me sirve');
  await sample(session, patientId, 'lab_report');
  spent += await save(
    session,
    patientId,
    'booking-photo-doctor',
    'Paths 1–4: reschedule, confirmation, a photo the engine closes, the result handed to the doctor',
    'María (synthetic) is offered a Tuesday, says she cannot on Tuesday and already had the test (path 2: new slots without Tuesday and an invitation to send the report), confirms option 2 (path 1: booked only on that explicit yes; the engine closes the visit order from the FHIR Appointment), sends a photo of her HbA1c report (path 3: Muse Spark vision reads it, the agent submits a FHIR Observation and the engine, not the agent, closes the HbA1c order), and the abnormal value goes to the doctor (path 4: clinical reviewer findings and a pre-visit question with citations), while María only hears that her doctor will review it.',
  );
}

if (paths.has('voice')) {
  const session = await login(`${prefix}-voice@example.com`);
  const patientId = await startStory(session, 'en');
  await sample(session, patientId, 'voice_note');
  spent += await save(
    session,
    patientId,
    'voice-note',
    'Path 5: a voice note transcribed by Muse Voice',
    'María (synthetic, English) answers the first contact with a voice note (16 kHz WAV). The gateway sends it to muse-voice-transcribe-1.0 (POST /v1/asr/transcribe), the transcript becomes her message, and the agent answers it like a text.',
  );
}

if (paths.has('ladder')) {
  const session = await login(`${prefix}-ladder@example.com`);
  const patientId = await startStory(session, 'es');
  for (const days of [4, 5, 5]) await jump(session, patientId, days);
  spent += await save(
    session,
    patientId,
    'no-response-ladder',
    'Path 6: no response, the ladder up to a staff call task',
    'María (synthetic) never answers. The clinic clock jumps 4, 5 and 5 days: the day-4 and day-9 rungs each run a live turn (Muse Spark words the message within the rung’s brief; code chooses the timing and the slots), and day 14 creates a call task for reception with a three-line summary.',
  );
}

if (paths.has('undelivered')) {
  const session = await login(`${prefix}-undelivered@example.com`);
  const patientId = await startStory(session, 'en');
  const page = await api<Page>(session, `/api/demo/agent?patientId=${patientId}`);
  const sent = page.messages.findLast((message) => message.direction === 'outbound');
  if (sent === undefined) throw new Error('no outbound message to mark undelivered');
  act(session, 'the channel reports the first message undelivered', { messageId: sent.id });
  await api(session, `/api/demo/agent/messages/${sent.id}/status`, {
    json: { status: 'undelivered' },
  });
  await sleep(1_500);
  await settle(session, patientId);
  spent += await save(
    session,
    patientId,
    'undelivered-phone-fix',
    'Path 7: an undelivered message, a same-day task to fix the phone',
    'The first contact (a live Muse Spark turn) comes back undelivered from the channel. Code stops messaging at once and creates a same-day task for reception to update the phone number; no model call decides it.',
  );
}

process.stdout.write(`total LLM spend of the recorded runs: ${usd(spent)}\n`);
