# Path 4b: an abnormal result asks for a visit; the doctor confirms before the agent writes about it

The lab sent María’s HbA1c (8.4 %, flagged abnormal) three days ago. The clinical reviewer runs first (findings with citations for the doctor) and the engine asks for a visit (abnormal_result_followup): that order waits for the doctor (awaiting_doctor, a high-priority notice), while the agent contacts María only about what the doctor wrote. The doctor confirms (recorded with the doctor’s id and the time); only then does the agent run the urgent track.

- Patient (synthetic): `pat-agent-maria-d052ed`, conversation es, mode live, final status active
- Models called (llm_gateway usage log): `meta:muse-spark-1.3`
- LLM cost of this run (sum of the usage rows below): **$0.049114** over 21 provider calls
- Exported at (clinic clock): 2026-01-05T12:00:00.000Z; clinic time zone America/Caracas

## What the driver did (wall clock)

| Wall clock (UTC)         | Action                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-30T15:39:24.000Z | start story maria_urgent (live, es)                                                                                                          |
| 2026-10-30T15:39:59.281Z | checkpoint: the engine’s visit waits for the doctor; nothing urgent was sent {"orderId":"6de46754-b172-4cfb-b365-f0ac92f0f3ae","outbound":1} |
| 2026-10-30T15:39:59.281Z | the doctor confirms the follow-up visit in For the doctor {"orderId":"6de46754-b172-4cfb-b365-f0ac92f0f3ae"}                                 |

## Conversation (as the patient’s phone shows it)

**Agent →** · 2026-01-05T12:00:00.000Z _(delivered)_

> Hola María, te escribo de tu clínica para ayudarte a agendar un control que te dejaron pendiente. ¿Te viene bien alguno de estos?
>
> 1. martes, 6 de enero, 8:00 a. m. · Dra. Elena Ruiz · Consultorio 2, sede principal
> 2. miércoles, 7 de enero, 8:30 a. m. · Dra. Elena Ruiz · Consultorio 2, sede principal
>
> Respóndeme con el número que te sirva.

**Agent →** · 2026-01-05T12:00:01.000Z _(delivered)_

> Hola María, tienes pendiente un control y además otro control, y tu doctora quiere verte pronto esta semana. ¿Te viene bien alguno de estos para el control?
>
> 1. martes, 6 de enero, 8:00 a. m. · Dra. Elena Ruiz · Consultorio 2, sede principal
> 2. miércoles, 7 de enero, 8:30 a. m. · Dra. Elena Ruiz · Consultorio 2, sede principal
>
> Respóndeme con el número que te sirva.

## Console trace (every model call and tool call)

Each model call shows the model, tokens and cost the gateway reported, and its gateway call id (the matching usage row is below). Each tool call shows its arguments, what it read, its outcome and result parameters.

- `#140` 2026-01-05T12:00:00.000Z · **ladder** · `ownership_taken` · ok
  - output: `{"orders":2,"ignoredEngineItems":3,"track":"routine","mode":"live"}`
- `#141` 2026-01-05T12:00:00.000Z · **engine** · `clinical_review_completed` · ok
  - output: `{"on":"arrival","reviewRunId":"380e0f18-70ce-4ade-9b37-50ea8081cc79","status":"completed","findings":7,"categories":["lab_trend","abnormal_result_no_followup","missing_screening","pre_visit_question"]}`
- `#142` 2026-01-05T12:00:00.000Z · **policy** · `doctor_confirmation_requested` · info
  - output: `{"orders":["6de46754-b172-4cfb-b365-f0ac92f0f3ae"]}`
- `#143` 2026-01-05T12:00:00.000Z · **ladder** · `staff_task_created` · ok
  - output: `{"kind":"doctor_notice","priority":"high","ask":"confirm_followup"}`

### Turn `agent-run-da2d1ce8dc74` · trigger take_ownership (routine:0d) · 5 model calls · $0.007407 · completed/end_turn

- `#144` 2026-01-05T12:00:00.000Z · **ladder** · `turn_started` · info
  - output: `{"trigger":"take_ownership","rung":"routine:0d","mode":"live"}`
- `#145` 2026-01-05T12:00:00.000Z · **model** · `model_called` · ok · tool `list_open_orders`
  - model `meta:muse-spark-1.3` · in 0 / out 0 tokens · $0.000000 · 0 ms
  - reason: Voy a revisar tus indicaciones para proponerte horarios disponibles.
  - output: `{"index":1,"repaired":false,"tool":"list_open_orders","callId":"473c3285-ad54-4fc8-97a9-0bf4d0d33ced"}`
- `#146` 2026-01-05T12:00:00.000Z · **tool** · `orders_listed` · ok · tool `list_open_orders`
  - reason: Voy a revisar tus indicaciones para proponerte horarios disponibles.
  - read: expectations, appointments
  - output: `{"open":1,"ignoredEngineItems":3,"awaitingDoctor":1}`
- `#147` 2026-01-05T12:00:00.000Z · **model** · `model_called` · ok · tool `get_contact_policy`
  - model `meta:muse-spark-1.3` · in 4132 / out 65 tokens · $0.001093 · 1855 ms
  - reason: Sigo con tu control pendiente y te preparo opciones.
  - output: `{"index":2,"repaired":false,"tool":"get_contact_policy","callId":"7f3b5acc-0bea-497c-9346-5ad6ee526550"}`
- `#148` 2026-01-05T12:00:00.000Z · **tool** · `policy_read` · ok · tool `get_contact_policy`
  - reason: Sigo con tu control pendiente y te preparo opciones.
  - read: messages, conversation
  - output: `{"canSend":true,"sendKind":"proactive","proactiveRemaining":2}`
- `#149` 2026-01-05T12:00:00.000Z · **model** · `model_called` · ok · tool `get_available_slots`
  - model `meta:muse-spark-1.3` · in 4250 / out 135 tokens · $0.001397 · 1335 ms
  - reason: Voy a buscar horarios disponibles para tu control.
  - output: `{"index":3,"repaired":false,"tool":"get_available_slots","callId":"5cc4d501-2581-41ad-91e4-88be8c810d4f"}`
- `#150` 2026-01-05T12:00:00.000Z · **tool** · `slots_found` · ok · tool `get_available_slots`
  - reason: Voy a buscar horarios disponibles para tu control.
  - input: `{"orderId":"4b8fd28d-5b17-4a17-a1eb-66e0c31d244f","preference":null,"excludeWeekdays":null}`
  - read: schedule, appointments, messages
  - output: `{"count":3,"preference":"earliest","slotIds":["professional@20260106T1200Z","professional@20260107T1230Z","professional@20260108T1200Z"]}`
- `#151` 2026-01-05T12:00:00.000Z · **model** · `model_called` · ok · tool `propose_slots`
  - model `meta:muse-spark-1.3` · in 9167 / out 416 tokens · $0.003686 · 1183 ms
  - reason: Propondré los primeros huecos para su control pendiente.
  - output: `{"index":4,"repaired":true,"tool":"propose_slots","callId":"4aa4535d-8b2e-429a-82e0-b3576a69ddea"}`
- `#152` 2026-01-05T12:00:00.000Z · **tool** · `slots_offered` · ok · tool `propose_slots`
  - reason: Propondré los primeros huecos para su control pendiente.
  - input: `{"orderId":"4b8fd28d-5b17-4a17-a1eb-66e0c31d244f","slotIds":["professional@20260106T1200Z","professional@20260107T1230Z"],"text":"Hola {first_name}, te escribo de tu clínica para ayudarte a agendar un control que te dejaron pendiente. ¿Te viene bien alguno de estos?"}`
  - read: contact_policy, outbound_safety
  - output: `{"messageId":"agent-message-8797f5520e21","sendKind":"proactive","slots":["professional@20260106T1200Z","professional@20260107T1230Z"]}`
- `#153` 2026-01-05T12:00:00.000Z · **model** · `model_called` · ok · tool `end_turn`
  - model `meta:muse-spark-1.3` · in 4649 / out 78 tokens · $0.001231 · 1387 ms
  - reason: Terminando el turno tras el primer contacto.
  - output: `{"index":5,"repaired":false,"tool":"end_turn","callId":"d4dac202-3267-4138-a1f7-494d6db9704f"}`
- `#154` 2026-01-05T12:00:00.000Z · **tool** · `turn_ended` · ok · tool `end_turn`
  - reason: Terminando el turno tras el primer contacto.
  - input: `{"summary":"First contact: proposed two slots for control visit"}`
  - output: `{"summary":"First contact: proposed two slots for control visit"}`
- `#155` 2026-01-05T12:00:00.000Z · **policy** · `order_confirmed_by_doctor` · ok
  - output: `{"orderId":"6de46754-b172-4cfb-b365-f0ac92f0f3ae","by":"agent-evidence-urgent@example.com","urgent":true}`

### Turn `agent-run-2a7845b71293` · trigger doctor_confirmed (urgent:0h) · 4 model calls · $0.011286 · completed/end_turn

- `#156` 2026-01-05T12:00:00.000Z · **ladder** · `turn_started` · info
  - output: `{"trigger":"doctor_confirmed","rung":"urgent:0h","mode":"live"}`
- `#157` 2026-01-05T12:00:00.000Z · **model** · `model_called` · ok · tool `list_open_orders`
  - model `meta:muse-spark-1.3` · in 4230 / out 312 tokens · $0.002406 · 1746 ms
  - reason: Sigo tu control pendiente y verifico el estado antes de escribirte.
  - output: `{"index":1,"repaired":false,"tool":"list_open_orders","callId":"f0dbf197-e6a2-412a-b058-551e25a3e555"}`
- `#158` 2026-01-05T12:00:00.000Z · **tool** · `orders_listed` · ok · tool `list_open_orders`
  - reason: Sigo tu control pendiente y verifico el estado antes de escribirte.
  - read: expectations, appointments
  - output: `{"open":2,"ignoredEngineItems":3,"awaitingDoctor":0}`
- `#159` 2026-01-05T12:00:00.000Z · **model** · `model_called` · ok · tool `get_contact_policy`
  - model `meta:muse-spark-1.3` · in 4459 / out 348 tokens · $0.002423 · 2072 ms
  - reason: Nuevo control urgente por agendar — preparo tus opciones de esta semana.
  - output: `{"index":2,"repaired":false,"tool":"get_contact_policy","callId":"c61efeb1-0dc2-443d-9373-3f185da73159"}`
- `#160` 2026-01-05T12:00:00.000Z · **tool** · `policy_read` · ok · tool `get_contact_policy`
  - reason: Nuevo control urgente por agendar — preparo tus opciones de esta semana.
  - read: messages, conversation
  - output: `{"canSend":true,"sendKind":"proactive","proactiveRemaining":1}`
- `#161` 2026-01-05T12:00:00.000Z · **model** · `model_called` · ok · tool `get_available_slots`
  - model `meta:muse-spark-1.3` · in 4581 / out 410 tokens · $0.002698 · 1690 ms
  - reason: Voy a conseguirte un control esta misma semana.
  - output: `{"index":3,"repaired":false,"tool":"get_available_slots","callId":"fbeb7ce7-01f7-4782-b833-67bc2884a16f"}`
- `#162` 2026-01-05T12:00:00.000Z · **tool** · `slots_found` · ok · tool `get_available_slots`
  - reason: Voy a conseguirte un control esta misma semana.
  - input: `{"orderId":"6de46754-b172-4cfb-b365-f0ac92f0f3ae","preference":"earliest","excludeWeekdays":null}`
  - read: schedule, appointments, messages
  - output: `{"count":3,"preference":"earliest","slotIds":["professional@20260106T1200Z","professional@20260107T1230Z","professional@20260108T1200Z"]}`
- `#163` 2026-01-05T12:00:00.000Z · **model** · `model_called` · ok · tool `propose_slots`
  - model `meta:muse-spark-1.3` · in 4815 / out 624 tokens · $0.003759 · 3380 ms
  - reason: Tu control urgente necesita agendarse esta semana: preparo la propuesta.
  - output: `{"index":4,"repaired":false,"tool":"propose_slots","callId":"b3d38e80-5a05-4a49-9b8e-da638f2cad5f"}`
- `#164` 2026-01-05T12:00:00.000Z · **tool** · `slots_offered` · ok · tool `propose_slots`
  - reason: Tu control urgente necesita agendarse esta semana: preparo la propuesta.
  - input: `{"orderId":"6de46754-b172-4cfb-b365-f0ac92f0f3ae","slotIds":["professional@20260106T1200Z","professional@20260107T1230Z"],"text":"Hola {first_name}, tienes pendiente un control y además otro control, y tu doctora quiere verte pronto esta semana. ¿Te viene bien alguno de estos para el control?"}`
  - read: contact_policy, outbound_safety
  - output: `{"messageId":"agent-message-0d44b09e909f","sendKind":"proactive","slots":["professional@20260106T1200Z","professional@20260107T1230Z"]}`
- `#165` 2026-01-05T12:00:00.000Z · **tool** · `call_rejected` · rejected · tool `prose`
  - output: `{"error":"prose_reminded","detail":"replied in prose, not a tool call"}`
- `#166` 2026-01-05T12:00:00.000Z · **tool** · `turn_ended` · ok · tool `end_turn`
  - input: `{"summary":"loop:prose_end"}`
  - output: `{"summary":"loop:prose_end"}`

## LLM usage log rows (llm_gateway, this lab clinic)

| Call id                                | Task            | Provider:model      | In   | Out  | Cost (USD) | Latency ms | OK                                                                       | At (engine clock)        |
| -------------------------------------- | --------------- | ------------------- | ---- | ---- | ---------- | ---------- | ------------------------------------------------------------------------ | ------------------------ |
| `c5df4062-a238-45d5-b253-504e2c770676` | note_extraction | meta:muse-spark-1.3 | 0    | 0    | $0.000000  | 1          | yes                                                                      | 2026-01-05T12:00:00.000Z |
| `f69c3515-6e0d-4168-a980-4f968cbe09ec` | clinical_review | meta:muse-spark-1.3 | 4166 | 237  | $0.002993  | 1780       | yes                                                                      | 2026-01-05T12:00:00.000Z |
| `3394a7a8-0ab2-410e-a695-4c9c161e19be` | clinical_review | meta:muse-spark-1.3 | 4378 | 274  | $0.002148  | 1775       | yes                                                                      | 2026-01-05T12:00:00.000Z |
| `a18f65d6-a22c-4b69-b468-a90e2d559474` | clinical_review | meta:muse-spark-1.3 | 4433 | 626  | $0.003431  | 2608       | yes                                                                      | 2026-01-05T12:00:00.000Z |
| `b31caf0e-c5bf-482d-b3bc-bf67e8b0db5a` | clinical_review | meta:muse-spark-1.3 | 4486 | 495  | $0.002941  | 2127       | yes                                                                      | 2026-01-05T12:00:00.000Z |
| `4f11209a-7674-4d4d-8c0a-26bd1f53f137` | clinical_review | meta:muse-spark-1.3 | 4652 | 666  | $0.003734  | 3841       | yes                                                                      | 2026-01-05T12:00:00.000Z |
| `d63644a1-ef3e-4dce-b24f-30787f54f9e3` | clinical_review | meta:muse-spark-1.3 | 4709 | 2198 | $0.010175  | 8031       | yes                                                                      | 2026-01-05T12:00:00.000Z |
| `473c3285-ad54-4fc8-97a9-0bf4d0d33ced` | order_agent     | meta:muse-spark-1.3 | 0    | 0    | $0.000000  | 0          | yes                                                                      | 2026-01-05T12:00:00.000Z |
| `7f3b5acc-0bea-497c-9346-5ad6ee526550` | order_agent     | meta:muse-spark-1.3 | 4132 | 65   | $0.001093  | 1855       | yes                                                                      | 2026-01-05T12:00:00.000Z |
| `5cc4d501-2581-41ad-91e4-88be8c810d4f` | order_agent     | meta:muse-spark-1.3 | 4250 | 135  | $0.001397  | 1335       | yes                                                                      | 2026-01-05T12:00:00.000Z |
| `7e04b2c7-020b-4574-9bb7-038267e9b010` | order_agent     | meta:muse-spark-1.3 | 4493 | 182  | $0.001760  | 1450       | no: LlmOutputError: Model output does not match the schema: no tool call | 2026-01-05T12:00:00.000Z |
| `4aa4535d-8b2e-429a-82e0-b3576a69ddea` | order_agent     | meta:muse-spark-1.3 | 4674 | 234  | $0.001926  | 1183       | yes                                                                      | 2026-01-05T12:00:00.000Z |
| `d4dac202-3267-4138-a1f7-494d6db9704f` | order_agent     | meta:muse-spark-1.3 | 4649 | 78   | $0.001231  | 1387       | yes                                                                      | 2026-01-05T12:00:00.000Z |
| `f0dbf197-e6a2-412a-b058-551e25a3e555` | order_agent     | meta:muse-spark-1.3 | 4230 | 312  | $0.002406  | 1746       | yes                                                                      | 2026-01-05T12:00:00.000Z |
| `c61efeb1-0dc2-443d-9373-3f185da73159` | order_agent     | meta:muse-spark-1.3 | 4459 | 348  | $0.002423  | 2072       | yes                                                                      | 2026-01-05T12:00:00.000Z |
| `fbeb7ce7-01f7-4782-b833-67bc2884a16f` | order_agent     | meta:muse-spark-1.3 | 4581 | 410  | $0.002698  | 1690       | yes                                                                      | 2026-01-05T12:00:00.000Z |
| `b3d38e80-5a05-4a49-9b8e-da638f2cad5f` | order_agent     | meta:muse-spark-1.3 | 4815 | 624  | $0.003759  | 3380       | yes                                                                      | 2026-01-05T12:00:00.000Z |
| `9f29a8cd-eaf1-499d-918a-3a99f3758ed1` | order_agent     | meta:muse-spark-1.3 | 4970 | 36   | $0.001172  | 787        | no: LlmOutputError: Model output does not match the schema: no tool call | 2026-01-05T12:00:00.000Z |
| `b67e5855-0fb3-4169-8b33-3668f0ab92bc` | order_agent     | meta:muse-spark-1.3 | 5057 | 96   | $0.001395  | 1381       | no: LlmOutputError: Model output does not match the schema: no tool call | 2026-01-05T12:00:00.000Z |
| `06d8ffed-8cb4-4e57-b2f8-f86735be3706` | order_agent     | meta:muse-spark-1.3 | 5028 | 37   | $0.001108  | 619        | no: LlmOutputError: Model output does not match the schema: no tool call | 2026-01-05T12:00:00.000Z |
| `52a1e036-0598-4cdd-9e00-13e7922797f9` | order_agent     | meta:muse-spark-1.3 | 5116 | 95   | $0.001324  | 1333       | no: LlmOutputError: Model output does not match the schema: no tool call | 2026-01-05T12:00:00.000Z |

**Total: $0.049114**

## Staff tasks

- doctor_notice (high, done): ask `confirm_followup`, orders visit · created 2026-01-05T12:00:00.000Z

## For the doctor (clinical reviewer findings with citations)

- **lab_trend** (shadow, meta:muse-spark-1.3): HbA1c en ascenso sostenido (6,6 → 7,1 → 8,4 %) — Considera revisar la evolución de HbA1c y el tratamiento actual en la próxima consulta.
  - “HbA1c: 6.6 %” — HbA1c, 2024-12-10 (`Observation/pat-agent-maria-d052ed-hba1c-0-obs`)
  - “HbA1c: 7.1 %” — HbA1c, 2025-08-05 (`Observation/pat-agent-maria-d052ed-hba1c-1-obs`)
  - “HbA1c: 8.4 %” — HbA1c, 2026-01-02 (`Observation/pat-agent-maria-d052ed-hba1c-lab-obs`)
- **abnormal_result_no_followup** (shadow, meta:muse-spark-1.3): HbA1c de 8,4 % sin visita posterior registrada — Considera priorizar la cita de seguimiento que el plan previo indicaba.
  - “HbA1c: 8.4 %” — HbA1c, 2026-01-02 (`Observation/pat-agent-maria-d052ed-hba1c-lab-obs`)
  - “Control en 3 meses con HbA1c.” — Internal medicine note, 2025-08-12 (`DocumentReference/pat-agent-maria-d052ed-visit-note`)
- **pre_visit_question** (shadow, meta:muse-spark-1.3): Pregunta por adherencia, dieta y actividad desde la última consulta — Pregunta si ha olvidado dosis, si ha tenido efectos adversos y por dieta y actividad.
  - “HbA1c: 8.4 %” — HbA1c, 2026-01-02 (`Observation/pat-agent-maria-d052ed-hba1c-lab-obs`)
  - “refiere buena adherencia.” — Internal medicine note, 2025-08-12 (`DocumentReference/pat-agent-maria-d052ed-visit-note`)
- **missing_screening** (shadow, meta:muse-spark-1.3): Diabetes sin fondo de ojo registrado en el último año — Considera solicitar fondo de ojo anual para cribado de retinopatía.
  - “E11.9 Diabetes mellitus tipo 2” — Type 2 diabetes mellitus, 2024-11-20 (`Condition/pat-agent-maria-d052ed-dx-dx`)
- **missing_screening** (shadow, meta:muse-spark-1.3): Diabetes sin albuminuria registrada en el último año — Considera solicitar cociente albúmina/creatinina en orina anual.
  - “E11.9 Diabetes mellitus tipo 2” — Type 2 diabetes mellitus, 2024-11-20 (`Condition/pat-agent-maria-d052ed-dx-dx`)
- **missing_screening** (shadow, meta:muse-spark-1.3): Diabetes sin panel lipídico anual registrado — Considera solicitar panel lipídico anual si lo ves indicado.
  - “E11.9 Diabetes mellitus tipo 2” — Type 2 diabetes mellitus, 2024-11-20 (`Condition/pat-agent-maria-d052ed-dx-dx`)
- **missing_screening** (shadow, meta:muse-spark-1.3): Diabetes sin examen de pies registrado en el último año — Considera examinar los pies en la próxima consulta.
  - “E11.9 Diabetes mellitus tipo 2” — Type 2 diabetes mellitus, 2024-11-20 (`Condition/pat-agent-maria-d052ed-dx-dx`)

## Engine side

### Expectations of the patient

| Expectation                            | Rule                     | Layer       | Agent owns | Status    | Closed by                                        | Closed at                | Reason                   |
| -------------------------------------- | ------------------------ | ----------- | ---------- | --------- | ------------------------------------------------ | ------------------------ | ------------------------ |
| `d3c0cc06-c06d-46d0-9515-53e07060b480` | protocol_diabetes_hba1c  | protocol    | no         | fulfilled | Observation/pat-agent-maria-d052ed-hba1c-0-obs   | 2026-01-05T12:00:00.000Z | fulfilled_by_result      |
| `f24d5496-6230-4e73-999b-8616bf8e48db` | protocol_diabetes_hba1c  | protocol    | no         | fulfilled | Observation/pat-agent-maria-d052ed-hba1c-1-obs   | 2026-01-05T12:00:00.000Z | fulfilled_by_result      |
| `7a2fe208-1a15-422c-b814-0dc46edfd941` | protocol_diabetes_visit  | protocol    | no         | fulfilled | Encounter/pat-agent-maria-d052ed-visit-enc       | 2026-01-05T12:00:00.000Z | fulfilled_by_encounter   |
| `d8d6d11d-f164-4ce2-a1d8-be03c6d9b792` | protocol_diabetes_hba1c  | protocol    | no         | cancelled |                                                  | 2026-01-05T12:00:00.000Z | covered_by_later_request |
| `4b8fd28d-5b17-4a17-a1eb-66e0c31d244f` | doctor_plan_followup     | doctor_plan | yes        | expired   |                                                  |                          |                          |
| `51cc9771-357b-4a36-b050-1a393e016e00` | doctor_plan_followup     | doctor_plan | yes        | fulfilled | Observation/pat-agent-maria-d052ed-hba1c-lab-obs | 2026-01-05T12:00:00.000Z | fulfilled_by_result      |
| `ae4b1fff-40de-4f17-973b-581b71acff67` | protocol_diabetes_fundus | protocol    | no         | expired   |                                                  |                          |                          |
| `f5c0976b-685e-478a-ab00-6b2a5d6d06f9` | protocol_diabetes_lipids | protocol    | no         | expired   |                                                  |                          |                          |
| `6de46754-b172-4cfb-b365-f0ac92f0f3ae` | abnormal_result_followup | universal   | yes        | open      |                                                  |                          |                          |
| `0631fbb0-77b5-4d4b-9f9b-5c2c5d3fd6d9` | protocol_diabetes_hba1c  | protocol    | no         | open      |                                                  |                          |                          |

### Clinical events ingested (FHIR → engine)

- `encounter.finished` from `Encounter/pat-agent-maria-d052ed-dx-enc` (occurred 2024-11-20T13:00:00.000Z)
- `condition.recorded` from `Condition/pat-agent-maria-d052ed-dx-dx` (occurred 2024-11-20T13:00:00.000Z)
- `result.received` from `Observation/pat-agent-maria-d052ed-hba1c-0-obs` (occurred 2024-12-10T13:00:00.000Z)
- `result.received` from `Observation/pat-agent-maria-d052ed-hba1c-1-obs` (occurred 2025-08-05T13:00:00.000Z)
- `encounter.finished` from `Encounter/pat-agent-maria-d052ed-visit-enc` (occurred 2025-08-12T13:00:00.000Z)
- `note.received` from `DocumentReference/pat-agent-maria-d052ed-visit-note` (occurred 2025-08-12T13:00:00.000Z)
- `medication.prescribed` from `MedicationRequest/pat-agent-maria-d052ed-visit-mr-1` (occurred 2025-08-12T13:00:00.000Z)
- `plan.extracted` from `DocumentReference/pat-agent-maria-d052ed-visit-note` (occurred 2025-08-12T13:00:00.000Z)
- `condition.recorded` from `DocumentReference/pat-agent-maria-d052ed-visit-note` (occurred 2025-08-12T13:00:00.000Z)
- `result.received` from `Observation/pat-agent-maria-d052ed-hba1c-lab-obs` (occurred 2026-01-02T12:00:00.000Z)

### Case audit trail

- Case `a0cd3cfe-6c1e-4b78-81c4-f1048cbe9850`: open
  - 2026-01-05T12:00:00.000Z · `opened` · actor rule:doctor_plan_followup · {"expectationId":"4b8fd28d-5b17-4a17-a1eb-66e0c31d244f","ruleId":"doctor_plan_followup","layer":"doctor_plan"}
  - 2026-01-05T12:00:00.000Z · `reason_added` · actor rule:protocol_diabetes_fundus · {"expectationId":"ae4b1fff-40de-4f17-973b-581b71acff67","ruleId":"protocol_diabetes_fundus","layer":"protocol"}
  - 2026-01-05T12:00:00.000Z · `reason_added` · actor rule:protocol_diabetes_lipids · {"expectationId":"f5c0976b-685e-478a-ab00-6b2a5d6d06f9","ruleId":"protocol_diabetes_lipids","layer":"protocol"}
