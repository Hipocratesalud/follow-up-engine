import {
  type AgentConversationView,
  type AgentMessage,
  type AgentStep,
  ladderTimeline,
  patientId as toPatientId,
} from '@follow-up-engine/core';
import {
  type EngineRuntime,
  ensureLabClinicAndClock,
  InvalidLabDateError,
  readSample,
  SAMPLE_FILES,
  setLabClinicDate,
  startOrderAgentStory,
} from '@follow-up-engine/runtime';
import type { Context } from 'hono';
import { z } from 'zod';
import type { App, AppEnv } from './context.ts';
import { trackEvaluatorEvent } from './evaluator-tracking.ts';
import { HttpError, readJson } from './errors.ts';
import { requireEvaluator } from './lab-records-routes.ts';

/** Largest voice note or photo accepted from the simulated phone. */
export const MAX_AGENT_MEDIA_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const AUDIO_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave']);

export const AgentStoryStartSchema = z
  .object({
    story: z.enum(['maria']).default('maria'),
    mode: z.enum(['scripted', 'live']),
    language: z.enum(['en', 'es']),
  })
  .strict();

export const AgentTextMessageSchema = z
  .object({ text: z.string().trim().min(1).max(1_000) })
  .strict();
export const AgentSampleSchema = z
  .object({ sample: z.enum(['lab_report', 'voice_note']) })
  .strict();
export const AgentDeliverySchema = z
  .object({ status: z.enum(['delivered', 'read', 'undelivered']) })
  .strict();
export const AgentClockSchema = z.object({ days: z.number().int().min(1).max(60) }).strict();

function iso(date: Date | undefined): string | undefined {
  return date?.toISOString();
}

function messageView(message: AgentMessage): Record<string, unknown> {
  return {
    id: message.id,
    direction: message.direction,
    kind: message.kind,
    text: message.text,
    at: message.at.toISOString(),
    ...(message.deliveryStatus === undefined ? {} : { deliveryStatus: message.deliveryStatus }),
    ...(message.offeredSlots === undefined
      ? {}
      : {
          offeredSlots: message.offeredSlots.map((slot) => ({
            id: slot.id,
            start: slot.start.toISOString(),
          })),
        }),
    ...(message.media === undefined
      ? {}
      : { media: { id: message.media.id, contentType: message.media.contentType } }),
    ...(message.transcript === undefined ? {} : { transcript: message.transcript }),
    ...(message.reading === undefined
      ? {}
      : {
          reading: {
            isLabReport: message.reading.isLabReport,
            tests: message.reading.tests.map((test) => ({ ...test })),
          },
        }),
    ...(message.rung === undefined ? {} : { rung: message.rung }),
    ...(message.proactive === undefined ? {} : { proactive: message.proactive }),
  };
}

function stepView(step: AgentStep): Record<string, unknown> {
  return {
    seq: step.seq,
    at: step.at.toISOString(),
    kind: step.kind,
    outcome: step.outcome,
    event: step.event,
    ...(step.runId === undefined ? {} : { runId: step.runId }),
    ...(step.tool === undefined ? {} : { tool: step.tool }),
    ...(step.arguments === undefined ? {} : { arguments: step.arguments }),
    ...(step.read === undefined ? {} : { read: step.read }),
    ...(step.reason === undefined ? {} : { reason: step.reason }),
    ...(step.params === undefined ? {} : { params: step.params }),
    ...(step.model === undefined ? {} : { model: step.model }),
    ...(step.costUsd === undefined ? {} : { costUsd: step.costUsd }),
    ...(step.latencyMs === undefined ? {} : { latencyMs: step.latencyMs }),
    ...(step.inputTokens === undefined ? {} : { inputTokens: step.inputTokens }),
    ...(step.outputTokens === undefined ? {} : { outputTokens: step.outputTokens }),
  };
}

/** Whether the agent still has work queued or running for the patient (the console's "working" state). */
function isBusy(view: AgentConversationView): boolean {
  if (view.runs.some((run) => run.status === 'running')) return true;
  if (view.runs.length === 0 && view.conversation.status === 'active') return true;
  const lastInbound = view.messages.findLast((message) => message.direction === 'inbound');
  if (lastInbound === undefined) return false;
  if (view.conversation.status === 'opted_out') return false;
  return !view.runs.some((run) => run.inboundMessageId === lastInbound.id);
}

/**
 * The order-to-completion agent's demo routes (docs/agent/order-to-completion.md),
 * inside each evaluator's lab clinic and on its own clock: start María's
 * story, write as the patient on the simulated phone (text, a voice note,
 * a photo), mark delivery statuses, fix a phone, jump the clock, and read
 * the conversation, the trace, the orders, staff tasks and what reached
 * the doctor. Registered only on a fake clock, like the rest of `/api/demo/*`.
 */
export function registerAgentRoutes(app: App, runtime: EngineRuntime): void {
  async function lab(c: Context<AppEnv>) {
    const evaluatorEmail = requireEvaluator(c);
    const { clinic, clock } = await ensureLabClinicAndClock(
      runtime,
      runtime.labClocks,
      evaluatorEmail,
    );
    return { evaluatorEmail, clinic, clock };
  }

  async function requireConversation(
    c: Context<AppEnv>,
    clinicId: Parameters<typeof runtime.orderAgent.view>[0],
    patientId: string,
  ) {
    const view = await runtime.orderAgent.view(clinicId, toPatientId(patientId));
    if (view === undefined) {
      throw new HttpError(404, 'agent_not_started', c.var.t.errors.agentNotStarted);
    }
    return view;
  }

  /** The whole page: the latest (or the given) patient's conversation, trace, orders, tasks and findings. */
  app.get('/api/demo/agent', async (c) => {
    const { clinic, clock } = await lab(c);
    const conversations = await runtime.orderAgent.listConversations(clinic.id);
    const requested = c.req.query('patientId');
    const target =
      requested === undefined
        ? conversations.at(-1)
        : conversations.find((item) => item.patientId === requested);
    const base = {
      now: clock.now().toISOString(),
      liveAvailable: runtime.liveAgent,
      model: `${runtime.extractor.provider}:${runtime.extractor.model}`,
      patients: conversations.map((item) => ({
        patientId: item.patientId,
        createdAt: item.createdAt.toISOString(),
        status: item.status,
      })),
    };
    if (target === undefined) return c.json({ ...base, conversation: null });
    const view = await requireConversation(c, clinic.id, target.patientId);
    const findings = await runtime.reviewer.listFindings(clinic.id, {
      patientId: target.patientId,
      limit: 20,
    });
    const { conversation } = view;
    return c.json({
      ...base,
      conversation: {
        patientId: conversation.patientId,
        mode: conversation.mode,
        language: conversation.language,
        status: conversation.status,
        phoneStatus: conversation.phoneStatus,
        ...(conversation.retryAt === undefined ? {} : { retryAt: iso(conversation.retryAt) }),
        flagAtNextContact: conversation.flagAtNextContact === true,
        createdAt: conversation.createdAt.toISOString(),
        busy: isBusy(view),
        ladder: {
          track: conversation.ladder.track,
          anchorAt: conversation.ladder.anchorAt.toISOString(),
          rungs: ladderTimeline(conversation.ladder).map((item) => ({
            id: item.rung.id,
            action: item.rung.action,
            dueAt: item.dueAt.toISOString(),
            done: item.done,
          })),
        },
      },
      timeZone: view.timeZone,
      messages: view.messages.map(messageView),
      orders: view.orders.map((order) => ({
        orderId: order.orderId,
        kind: order.descriptor.kind,
        ...(order.descriptor.test === undefined ? {} : { test: order.descriptor.test }),
        source: order.descriptor.source,
        stage: order.stage,
        expectationStatus: order.expectationStatus,
        dueAt: order.dueAt.toISOString(),
        urgent: order.urgent,
        ...(order.closedBy === undefined ? {} : { closedBy: order.closedBy }),
        ...(order.closedAt === undefined ? {} : { closedAt: order.closedAt.toISOString() }),
      })),
      ignoredEngineItems: view.ignoredEngineItems,
      steps: view.steps.map(stepView),
      runs: view.runs.map((run) => ({
        id: run.id,
        trigger: run.trigger,
        status: run.status,
        mode: run.mode,
        ...(run.model === undefined ? {} : { model: run.model }),
        startedAt: run.startedAt.toISOString(),
        modelCalls: run.modelCalls,
        toolCalls: run.toolCalls,
        costUsd: run.costUsd,
        ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
      })),
      tasks: view.tasks.map((task) => ({
        id: task.id,
        kind: task.kind,
        priority: task.priority,
        status: task.status,
        createdAt: task.createdAt.toISOString(),
        dueAt: task.dueAt.toISOString(),
        summary: {
          orders: task.summary.orders,
          outboundCount: task.summary.outboundCount,
          ...(task.summary.lastOutboundAt === undefined
            ? {}
            : { lastOutboundAt: task.summary.lastOutboundAt.toISOString() }),
          ...(task.summary.lastStatus === undefined ? {} : { lastStatus: task.summary.lastStatus }),
          replied: task.summary.replied,
          ask: task.summary.ask,
        },
      })),
      appointments: view.appointments.map((appointment) => ({
        id: appointment.id,
        start: appointment.slot.start.toISOString(),
        resourceKind: appointment.slot.resourceKind,
        resource: appointment.slot.resource,
        ...(appointment.fhirAppointmentId === undefined
          ? {}
          : { fhirAppointmentId: appointment.fhirAppointmentId }),
        ...(appointment.originCaseId === undefined
          ? {}
          : { originCaseId: appointment.originCaseId }),
      })),
      findings: findings.items.map((finding) => ({
        id: finding.id,
        category: finding.category,
        severity: finding.severity,
        summary: finding.summary,
        suggestion: finding.suggestion,
        mode: finding.mode,
        modelId: finding.modelId,
        createdAt: finding.createdAt.toISOString(),
      })),
    });
  });

  app.post('/api/demo/agent/story', async (c) => {
    const body = await readJson(c, AgentStoryStartSchema);
    const { clinic, clock, evaluatorEmail } = await lab(c);
    if (body.mode === 'live' && !runtime.liveAgent) {
      throw new HttpError(422, 'agent_live_unavailable', c.var.t.errors.agentLiveUnavailable);
    }
    const { patientId } = await startOrderAgentStory(runtime, clinic.id, clock, {
      mode: body.mode,
      language: body.language,
    });
    await trackEvaluatorEvent(runtime, {
      clinicId: clinic.id,
      evaluatorEmail,
      action: 'lab_patient_created',
      entityType: 'patient',
      entityId: patientId,
      patientId,
      payload: { story: body.story, mode: body.mode, language: body.language },
    });
    return c.json({ patientId }, 201);
  });

  /** The patient writes: JSON `{ text }`, or multipart with a `file` (a WAV voice note, a photo). */
  app.post('/api/demo/agent/patients/:id/messages', async (c) => {
    const { clinic } = await lab(c);
    const view = await requireConversation(c, clinic.id, c.req.param('id'));
    const patientId = view.conversation.patientId;
    const contentType = c.req.header('content-type') ?? '';
    let message: AgentMessage;
    if (contentType.includes('multipart/form-data')) {
      const form = await c.req.parseBody();
      const file = form['file'];
      if (!(file instanceof File) || file.size === 0 || file.size > MAX_AGENT_MEDIA_BYTES) {
        throw new HttpError(422, 'agent_media_type', c.var.t.errors.agentMediaType);
      }
      const type = file.type.split(';')[0]?.trim().toLowerCase() ?? '';
      const kind = IMAGE_TYPES.has(type) ? 'image' : AUDIO_TYPES.has(type) ? 'voice' : undefined;
      if (kind === undefined) {
        throw new HttpError(422, 'agent_media_type', c.var.t.errors.agentMediaType);
      }
      message = await runtime.orderAgent.receiveMessage(clinic.id, patientId, {
        kind,
        media: { data: new Uint8Array(await file.arrayBuffer()), contentType: type },
      });
    } else {
      const body = await readJson(c, AgentTextMessageSchema);
      message = await runtime.orderAgent.receiveMessage(clinic.id, patientId, {
        kind: 'text',
        text: body.text,
      });
    }
    return c.json(messageView(message), 201);
  });

  /** The story's sample media: María's lab report photo, or her voice note in the conversation's language. */
  app.post('/api/demo/agent/patients/:id/samples', async (c) => {
    const body = await readJson(c, AgentSampleSchema);
    const { clinic } = await lab(c);
    const view = await requireConversation(c, clinic.id, c.req.param('id'));
    const name =
      body.sample === 'lab_report'
        ? 'labReport'
        : view.conversation.language === 'es'
          ? 'voiceEs'
          : 'voiceEn';
    const message = await runtime.orderAgent.receiveMessage(
      clinic.id,
      view.conversation.patientId,
      {
        kind: body.sample === 'lab_report' ? 'image' : 'voice',
        media: { data: readSample(name), contentType: SAMPLE_FILES[name].contentType },
      },
    );
    return c.json(messageView(message), 201);
  });

  app.post('/api/demo/agent/messages/:id/status', async (c) => {
    const body = await readJson(c, AgentDeliverySchema);
    const { clinic } = await lab(c);
    try {
      const message = await runtime.orderAgent.setDeliveryStatus(
        clinic.id,
        c.req.param('id'),
        body.status,
      );
      return c.json(messageView(message));
    } catch (error) {
      if (error instanceof Error && error.name === 'ValidationError') {
        throw new HttpError(404, 'not_found', c.var.t.errors.notFound);
      }
      throw error;
    }
  });

  app.post('/api/demo/agent/patients/:id/phone-fixed', async (c) => {
    const { clinic } = await lab(c);
    const view = await requireConversation(c, clinic.id, c.req.param('id'));
    await runtime.orderAgent.fixPhone(clinic.id, view.conversation.patientId);
    return c.body(null, 204);
  });

  /** Jumps the lab clinic's own clock: the engine's sweeps and the agent's ladder run day by day. */
  app.post('/api/demo/agent/clock', async (c) => {
    const body = await readJson(c, AgentClockSchema);
    const { clinic, clock, evaluatorEmail } = await lab(c);
    const target = new Date(clock.now().getTime() + body.days * 86_400_000);
    try {
      const advance = await setLabClinicDate(runtime, clock, clinic.id, target);
      await trackEvaluatorEvent(runtime, {
        clinicId: clinic.id,
        evaluatorEmail,
        action: 'lab_date_viewed',
        payload: { from: advance.from.toISOString(), to: advance.to.toISOString() },
      });
      return c.json({ from: advance.from.toISOString(), to: advance.to.toISOString() });
    } catch (error) {
      if (error instanceof InvalidLabDateError) {
        throw new HttpError(422, 'lab_past_date', c.var.t.errors.labPastDate);
      }
      throw error;
    }
  });

  /** A voice note or photo of the lab clinic's conversations (for the simulated phone). */
  app.get('/api/demo/agent/media/:id', async (c) => {
    const { clinic } = await lab(c);
    const media = await runtime.storage.orderAgent.getMedia(clinic.id, c.req.param('id'));
    if (media === undefined) {
      throw new HttpError(404, 'not_found', c.var.t.errors.notFound);
    }
    return c.body(new Uint8Array(media.data), 200, {
      'content-type': media.contentType,
      'cache-control': 'private, max-age=3600',
    });
  });
}
