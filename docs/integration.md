# Integrating a host EHR

How a host EHR (Hipócrates first, any FHIR-capable EHR later) plugs into the Follow-up Engine: one call per saved consultation, signed webhooks back. Everything here is exercised by the end-to-end suite (`pnpm e2e`), which posts the [example Bundle](#example-consultation-bundle) of this page verbatim.

```
 Host EHR                                   Follow-up Engine
 ────────                                   ────────────────
 consultation saved
   └─ POST /fhir (transaction Bundle) ───▶  validate, store resources, enqueue
                                       ◀─── 202 transaction-response (milliseconds)
                                            worker: rules → LLM reads the plan
                                                    → protocols fill the gaps
                                                    → fulfillment / supersession
 ...days later...                           watcher: due expectations → case
                                       ◀─── webhook case.opened
                                            escalation: notify, raise priority,
                                       ◀─── webhook patient_contact.requested
                                                    (a CommunicationRequest: WhatsApp)
 host sends WhatsApp (its channel)
 patient answers (or not)
   └─ POST /fhir (Communication) ──────▶   outcome on the attempt: wait for the visit,
                                            resolve, call next, or try again
 result / appointment arrives
   └─ POST /fhir (Bundle) ─────────────▶   fulfills the expectation, resolves the case
                                       ◀─── webhook case.resolved
```

The engine never contacts patients. It asks the host to, with ids and a generic purpose only; the host owns the message and the channel, and tells the engine what came of it ([Closing the loop](#4-closing-the-loop)).

## 1. Authentication

Every request carries one of the clinic's API keys:

```http
Authorization: Bearer <clinic API key>
```

The key identifies the clinic (`sha256(key)` is looked up in the clinic registry; the key itself is never stored). The clinic is never read from the body, and nothing of another clinic is visible with a key. A missing or unknown key is `401` (an `OperationOutcome` under `/fhir`, `{ "error": { "code", "message" } }` elsewhere); a key without the scope a route needs is `403` (`insufficient_scope`). `GET /fhir/metadata`, `/openapi.json`, `/docs` and the health probes are public.

### Registering a clinic and issuing keys

A clinic gets its keys from the operator, with the CLI (it prints each key once; only its hash is stored):

```sh
DATABASE_URL=... pnpm --filter @follow-up-engine/api clinic:create \
  --name "Clínica Ejemplo" --scopes fhir:write              # the host integration key
DATABASE_URL=... pnpm --filter @follow-up-engine/api clinic:create \
  --id clinica-ejemplo --label inbox --scopes inbox:read,inbox:act   # another key, same clinic
```

`--id` defaults to a slug of `--name`; giving the id of an existing clinic adds a key (and updates the name when given). `--label` names the key (default `integration`); `--revoke <label>` revokes the clinic's keys with that label. `--locale <bcp47>` sets the clinic's locale (`ClinicSettings.locale`, default `en-US`; `--locale es-VE` for a Spanish-speaking team, also on an existing clinic): the language of the inbox labels when the user's browser asks for none the engine has, and of the clinical reviewer's findings (see [Languages](#languages)). Run `--help` for the rest (`--allow-patient-contact`, `--timezone`, `--escalation-policy`, `--protocols`).

### Scopes

Each key carries the least it needs:

| Scope         | Allows                                                                                                                                          | Who holds it                                              |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `fhir:write`  | Everything under `/fhir` (ingest, read `Task`, `Condition`, `DetectedIssue`, `CommunicationRequest`, `Communication`, `Flag`) and `/jobs`.      | The host integration (server)                             |
| `inbox:read`  | `GET /api/inbox/*` (and reading the demo clock).                                                                                                | The inbox                                                 |
| `inbox:act`   | `POST /api/inbox/*`: case actions, feedback, condition review.                                                                                  | The inbox                                                 |
| `demo:clock`  | `POST /api/demo/clock/advance` (the fake clock is shared by every clinic of the process) and `GET /api/demo/webhooks`.                          | The demo operator; never a clinic                         |
| `demo:ingest` | `POST /api/demo/consultations`: synthetic consultations, only into the demo clinic `clinic-demo`.                                               | The demo operator; never a clinic                         |
| `admin:rules` | `/api/admin/*`: read and change the clinic's rule configuration (deadlines, rules switched off), audited ([below](#per-clinic-rule-overrides)). | The clinic's operator; never the integration or the inbox |

`demo:*` scopes only exist on a fake clock (`CLOCK=fake`): on a real clock they are dropped and the demo routes do not exist. The CLI refuses them for any clinic but `clinic-demo` unless `--allow-demo` is passed.

An inbox key never has `fhir:write`: whoever can open the inbox cannot ingest clinical data or opt patients out. In production the inbox runs behind the host's own login, and the host calls the inbox API from its server (or a proxy), so the key never reaches a browser; `VITE_API_KEY` in a browser bundle is for the demo only.

### Who acted: `X-FollowUp-User`

Inbox actions (notify, snooze, resolve, feedback, confirming or rejecting a condition) record the acting clinic user in the audit trail from the `X-FollowUp-User` header (host user id or name, at most 120 printable characters: letters, digits, punctuation, symbols and spaces; `inbox-user` when absent). Send it as UTF-8 bytes (`Dr. Médico`); a value whose bytes are not valid UTF-8 is read as Latin-1, which is what browsers send. A longer value, or one with control or invisible characters, gets `400 invalid_request`. The engine does not authenticate users: the header is trusted **only when the host sets it**, after its own login, on the server side (strip any value the browser sent). A key used straight from a browser lets its holder write any name there.

### Limits

Each key may make 600 requests per minute (`429` with `Retry-After` beyond that, per API process). Requests with a missing or wrong key are limited per client address (60 per minute): past the limit they get `429`, and a key the API has not seen in the last 10 minutes reaches the key lookup one at a time per address, in arrival order. Only failed attempts count, and a valid key is not refused because of them: it waits for the lookups ahead of it (milliseconds each) and is served, so a client guessing keys behind the same proxy as the host never locks the host out. Only when more than 16 requests from one address already wait for a lookup is the next one refused (`429`) without reaching the database. `X-Request-Id` is echoed when it is 1 to 64 characters of `A-Z a-z 0-9 _ -`; anything else is replaced by a generated id. Request bodies are at most 5 MB (`413`, readable by the browsers in `CORS_ORIGINS`).

Errors of the JSON API (`/api/*`) are `{ "error": { "code", "message" } }`, with `message` ready to show to the clinic team, in the language of the request (below). A request that breaks the validation rules is `422` with `code: "invalid_request"` and `fields`, one entry per invalid field: `{ "path": "note", "message": "Must have at most 2000 characters." }` (`"Debe tener como máximo 2000 caracteres."` with `Accept-Language: es`).

### Languages

Four languages are independent ([ADR 0007](adr/0007-language-model.md)):

| Whose          | Where it comes from                                                                                                | What it decides                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The inbox user | `Accept-Language` of each request (the inbox sends the language picked in its switch)                              | Every label and message of `/api/*`: reasons, timeline, escalation steps, contact outcomes, errors, validation messages. `en` and `es` today. Answered in `Content-Language`. |
| The clinic     | `ClinicSettings.locale` (BCP-47, default `en-US`; `clinic:create --locale`)                                        | The fallback when the user's `Accept-Language` names no language the engine has; the language the clinical reviewer writes its findings in.                                   |
| The patient    | `Patient.communication` (the `preferred` one first; a `urn:ietf:bcp:47` coding, e.g. `es-VE`)                      | Forwarded on every contact request (`language` of `patient_contact.requested`, `CommunicationRequest.language`): **the host writes its message in that language.**            |
| The note       | `DocumentReference.language` (or its attachment's `language`, `Composition.language`), else detected from the text | Which lexicons the extractor's deterministic checks use (negation, discharge, timing, test names). The note is never translated: quotes stay verbatim.                        |

Clinical content is never translated in any direction: note text, evidence quotes, the host's own displays (`code.text` of an order) and names are returned as written. A Spanish-speaking patient of an English-speaking clinic, seen through Spanish notes, is the normal case.

## 2. Sending a consultation

`POST /fhir` with `Content-Type: application/fhir+json` and a FHIR R4 `transaction` Bundle (or `batch`). One Bundle per saved consultation: the `Encounter`, the note, the orders, the prescriptions, the diagnoses and, the first time, the `Patient`. The full FHIR contract (every resource, field and status the engine reads) is in [fhir.md](fhir.md).

### Mapping the host's records

| Host record (Hipócrates)                 | FHIR resource                          | Notes                                                                                                                                                   |
| ---------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paciente                                 | `Patient`                              | Send it with the patient's first consultation, and again when demographics change. `id` = the host's patient id; `communication` = preferred language.  |
| Consulta (finalizada)                    | `Encounter` `status: finished`         | `serviceType` = specialty code (`diabetology`, `psychology`, ...), `participant` = the treating `Practitioner`, `period` = when it happened.            |
| Nota de la consulta (evolución, informe) | `DocumentReference` (or `Composition`) | Note text in `content[0].attachment.data` (base64, `text/plain; charset=utf-8`), `context.encounter` = the consultation.                                |
| Orden de laboratorio / imagen            | `ServiceRequest` `status: active`      | LOINC `code`, SNOMED `category` (`108252007` laboratory, `363679005` imaging), `encounter`.                                                             |
| Receta                                   | `MedicationRequest` `status: active`   | `medicationCodeableConcept` (ATC/RxNorm when available, text always), `dispenseRequest.expectedSupplyDuration` for short treatments.                    |
| Diagnóstico                              | `Condition`                            | ICD-10 coding; `verificationStatus: provisional` for presumptive diagnoses.                                                                             |
| Médico                                   | `Practitioner`                         | Optional, once: lets the inbox show the owner's name instead of an id.                                                                                  |
| Cita agendada / cancelada                | `Appointment` `booked` / `cancelled`   | Separate Bundle when it happens; a booked visit fulfills visit expectations.                                                                            |
| Resultado de laboratorio / imagen        | `DiagnosticReport` + `Observation`s    | `basedOn` the `ServiceRequest` when known; `interpretation` `H`/`L`/`N`.                                                                                |
| Paciente no quiere seguimiento           | `Consent` (deny, `follow-up-opt-out`)  | Stops patient contact requests only: open expectations and cases stay, and escalation goes to the coordinator instead of the patient.                   |
| Resultado del contacto (WhatsApp)        | `Communication`                        | `basedOn` the `CommunicationRequest` the engine asked for; the outcome in the `contact-outcome` extension. See [Closing the loop](#4-closing-the-loop). |

Use stable ids (`PUT Type/<host id>`) or `urn:uuid` full URLs: re-sending a Bundle is harmless, ingestion is idempotent end to end (resources, events, expectations, cases).

### Example consultation Bundle

A diabetology consultation (synthetic). The note, base64 in `attachment.data`, reads: "Paciente femenina de 58 años con DM2 [...] Plan: continuar metformina 850 mg c/12h. Solicito HbA1c y perfil lipídico. Control en 3 meses con resultados."

<!-- e2e:consultation-bundle -->

```json
{
  "resourceType": "Bundle",
  "type": "transaction",
  "timestamp": "2026-01-05T14:30:00-04:00",
  "entry": [
    {
      "fullUrl": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01",
      "resource": {
        "resourceType": "Patient",
        "identifier": [
          {
            "system": "https://ehr.example.org/patients",
            "value": "DM-0001"
          }
        ],
        "name": [
          {
            "family": "Prueba",
            "given": ["Ana"]
          }
        ],
        "gender": "female",
        "birthDate": "1967-08-14"
      },
      "request": {
        "method": "POST",
        "url": "Patient"
      }
    },
    {
      "fullUrl": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e02",
      "resource": {
        "resourceType": "Practitioner",
        "name": [
          {
            "family": "Sintético",
            "given": ["Luis"],
            "prefix": ["Dr."]
          }
        ]
      },
      "request": {
        "method": "POST",
        "url": "Practitioner"
      }
    },
    {
      "fullUrl": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03",
      "resource": {
        "resourceType": "Encounter",
        "status": "finished",
        "class": {
          "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
          "code": "AMB",
          "display": "ambulatory"
        },
        "serviceType": {
          "coding": [
            {
              "system": "https://hipocratesalud.com/fhir/CodeSystem/specialty",
              "code": "diabetology",
              "display": "Diabetology"
            }
          ],
          "text": "Diabetología"
        },
        "subject": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01"
        },
        "participant": [
          {
            "type": [
              {
                "coding": [
                  {
                    "system": "http://terminology.hl7.org/CodeSystem/v3-ParticipationType",
                    "code": "PPRF",
                    "display": "primary performer"
                  }
                ]
              }
            ],
            "individual": {
              "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e02"
            }
          }
        ],
        "period": {
          "start": "2026-01-05T14:00:00-04:00",
          "end": "2026-01-05T14:30:00-04:00"
        }
      },
      "request": {
        "method": "POST",
        "url": "Encounter"
      }
    },
    {
      "fullUrl": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e04",
      "resource": {
        "resourceType": "DocumentReference",
        "status": "current",
        "docStatus": "final",
        "type": {
          "coding": [
            {
              "system": "http://loinc.org",
              "code": "11506-3",
              "display": "Progress note"
            }
          ]
        },
        "subject": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01"
        },
        "date": "2026-01-05T14:30:00-04:00",
        "author": [
          {
            "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e02"
          }
        ],
        "content": [
          {
            "attachment": {
              "contentType": "text/plain; charset=utf-8",
              "language": "es",
              "data": "UGFjaWVudGUgZmVtZW5pbmEgZGUgNTggYcOxb3MgY29uIERNMiBkaWFnbm9zdGljYWRhIGhhY2UgNiBhw7Fvcy4gUmVmaWVyZSBidWVuYSBhZGhlcmVuY2lhIGEgbWV0Zm9ybWluYS4KR2x1Y2VtaWEgZW4gYXl1bmFzIDE2OCBtZy9kTC4gUEEgMTI4LzgyIG1tSGcsIElNQyAzMS4KSW1wcmVzacOzbjogRE0yIG5vIGNvbnRyb2xhZGEuClBsYW46IGNvbnRpbnVhciBtZXRmb3JtaW5hIDg1MCBtZyBjLzEyaC4gU29saWNpdG8gSGJBMWMgeSBwZXJmaWwgbGlww61kaWNvLiBDb250cm9sIGVuIDMgbWVzZXMgY29uIHJlc3VsdGFkb3Mu"
            }
          }
        ],
        "context": {
          "encounter": [
            {
              "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03"
            }
          ],
          "practiceSetting": {
            "coding": [
              {
                "system": "https://hipocratesalud.com/fhir/CodeSystem/specialty",
                "code": "diabetology"
              }
            ]
          }
        }
      },
      "request": {
        "method": "POST",
        "url": "DocumentReference"
      }
    },
    {
      "fullUrl": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e05",
      "resource": {
        "resourceType": "ServiceRequest",
        "status": "active",
        "intent": "order",
        "category": [
          {
            "coding": [
              {
                "system": "http://snomed.info/sct",
                "code": "108252007",
                "display": "Laboratory procedure"
              }
            ]
          }
        ],
        "code": {
          "coding": [
            {
              "system": "http://loinc.org",
              "code": "4548-4",
              "display": "Hemoglobin A1c/Hemoglobin.total in Blood"
            }
          ],
          "text": "HbA1c"
        },
        "subject": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01"
        },
        "encounter": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03"
        },
        "authoredOn": "2026-01-05T14:30:00-04:00",
        "requester": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e02"
        }
      },
      "request": {
        "method": "POST",
        "url": "ServiceRequest"
      }
    },
    {
      "fullUrl": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e06",
      "resource": {
        "resourceType": "ServiceRequest",
        "status": "active",
        "intent": "order",
        "category": [
          {
            "coding": [
              {
                "system": "http://snomed.info/sct",
                "code": "108252007",
                "display": "Laboratory procedure"
              }
            ]
          }
        ],
        "code": {
          "coding": [
            {
              "system": "http://loinc.org",
              "code": "57698-3",
              "display": "Lipid panel with direct LDL - Serum or Plasma"
            }
          ],
          "text": "Perfil lipídico"
        },
        "subject": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01"
        },
        "encounter": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03"
        },
        "authoredOn": "2026-01-05T14:30:00-04:00",
        "requester": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e02"
        }
      },
      "request": {
        "method": "POST",
        "url": "ServiceRequest"
      }
    },
    {
      "fullUrl": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e07",
      "resource": {
        "resourceType": "MedicationRequest",
        "status": "active",
        "intent": "order",
        "medicationCodeableConcept": {
          "coding": [
            {
              "system": "http://www.nlm.nih.gov/research/umls/rxnorm",
              "code": "861004",
              "display": "metformin hydrochloride 850 MG Oral Tablet"
            }
          ],
          "text": "metformina 850 mg"
        },
        "subject": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01"
        },
        "encounter": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03"
        },
        "authoredOn": "2026-01-05T14:30:00-04:00",
        "requester": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e02"
        },
        "dosageInstruction": [
          {
            "text": "1 tableta cada 12 horas con las comidas",
            "timing": {
              "repeat": {
                "frequency": 1,
                "period": 12,
                "periodUnit": "h"
              }
            }
          }
        ],
        "dispenseRequest": {
          "numberOfRepeatsAllowed": 2,
          "expectedSupplyDuration": {
            "value": 90,
            "unit": "days",
            "system": "http://unitsofmeasure.org",
            "code": "d"
          }
        }
      },
      "request": {
        "method": "POST",
        "url": "MedicationRequest"
      }
    },
    {
      "fullUrl": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e08",
      "resource": {
        "resourceType": "Condition",
        "clinicalStatus": {
          "coding": [
            {
              "system": "http://terminology.hl7.org/CodeSystem/condition-clinical",
              "code": "active"
            }
          ]
        },
        "verificationStatus": {
          "coding": [
            {
              "system": "http://terminology.hl7.org/CodeSystem/condition-ver-status",
              "code": "confirmed"
            }
          ]
        },
        "category": [
          {
            "coding": [
              {
                "system": "http://terminology.hl7.org/CodeSystem/condition-category",
                "code": "encounter-diagnosis"
              }
            ]
          }
        ],
        "code": {
          "coding": [
            {
              "system": "http://hl7.org/fhir/sid/icd-10",
              "code": "E11.9",
              "display": "Type 2 diabetes mellitus without complications"
            }
          ],
          "text": "DM2"
        },
        "subject": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01"
        },
        "encounter": {
          "reference": "urn:uuid:5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e03"
        },
        "recordedDate": "2026-01-05T14:30:00-04:00"
      },
      "request": {
        "method": "POST",
        "url": "Condition"
      }
    }
  ]
}
```

### Responses

| Status | When                                                                                                                                                                                     | Body                                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `202`  | Default. Validated and stored; the engine runs in the worker. Headers `X-FollowUp-Job` (job id) and `Content-Location` (`/jobs/<id>`, poll it), `X-FollowUp-Summary` (what was queued).  | `transaction-response` (or `batch-response`) Bundle: exactly one entry per request entry, in request order. |
| `200`  | `?sync=true` or `Prefer: respond-sync`: the engine ran before answering; `X-FollowUp-Summary` says what it did (`3 expectation(s) created, ...`, or that a note was queued for a retry). | Same Bundle.                                                                                                |
| `400`  | The Bundle is invalid. A `transaction` is all or nothing: nothing was stored. A `batch` is never refused as a whole: even when every entry failed, it gets a `200` `batch-response`.     | `OperationOutcome`, one issue per problem with its FHIRPath-like `expression`.                              |
| `401`  | Missing or unknown API key.                                                                                                                                                              | `OperationOutcome`                                                                                          |
| `403`  | The key lacks the `fhir:write` scope (an inbox key).                                                                                                                                     | `OperationOutcome`                                                                                          |
| `413`  | The body is larger than 5 MB.                                                                                                                                                            | `OperationOutcome` (`too-costly`)                                                                           |
| `415`  | Not JSON.                                                                                                                                                                                | `OperationOutcome`                                                                                          |
| `429`  | Too many requests for this key; wait `Retry-After` seconds.                                                                                                                              | `OperationOutcome` (`throttled`)                                                                            |

Each response entry answers the request entry at the same position (FHIR R4 `transaction-response`): a stored resource gets `201 Created` (new) or `200 OK` (changed or unchanged) with its versioned `location` and `etag`; a failed entry of a `batch` gets `400 Bad Request` with its own `response.outcome`, and an entry whose `request.method` the engine does not carry out (`DELETE`, `GET`, `HEAD`, `PATCH`) `405 Method Not Allowed` (cancel an order by sending it with `status = revoked`); a version older than the stored one gets `200 OK` with a `stale` warning and is not stored (`X-FollowUp-Stale` header); an entry the engine does not consume (a `Basic`) gets `200 OK` with an informational `response.outcome`. Warnings (an uncoded order, control characters removed, a category inferred from LOINC, a date in the future, a visit, order, prescription, result or note dated more than 90 days before receipt: old history, whose overdue follow-up never contacts the patient by itself and, beyond the clinic's notify window, waits among the patients to recover) travel in the `response.outcome` of their entry.

```json
{
  "resourceType": "Bundle",
  "type": "transaction-response",
  "entry": [
    {
      "response": {
        "status": "201 Created",
        "location": "Patient/5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01/_history/1",
        "etag": "W/\"1\""
      }
    },
    {
      "response": {
        "status": "201 Created",
        "location": "Practitioner/5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e02/_history/1",
        "etag": "W/\"1\""
      }
    }
  ]
}
```

(one entry per request entry; the example shows the first two.)

`GET /jobs/<id>` (same API key; another clinic's job is `404`) follows an asynchronous ingestion:

```json
{
  "id": "0b3f6c1e-2f1a-4c55-9a7e-3d2b1c0a9e11",
  "type": "fhir.ingest_bundle",
  "status": "completed",
  "attempts": 1,
  "maxAttempts": 10,
  "createdAt": "2026-01-05T18:31:00.000Z"
}
```

`status` is `pending` (with `nextAttemptAt`), `running`, `completed` or `failed` (every attempt failed; `lastError` says why). A Bundle is retried up to 10 times with backoff before it is `failed`.

Single resources can also be sent one by one with `POST /fhir/<type>` or `PUT /fhir/<type>/<id>` (for example an `Appointment` when it is booked); they go through the same pipeline. `GET /fhir/metadata` (the `CapabilityStatement`) is public and lists exactly these interactions.

### What happens asynchronously

1. The API validates and maps the Bundle (pure functions), stores the resources and enqueues a `fhir.ingest_bundle` job in the same transaction, and answers.
2. The worker claims the job (`FOR UPDATE SKIP LOCKED`, leased) and runs the engine per consultation: universal rules, the doctor's plan read from the note by the LLM (Muse Spark through the `llm_gateway`, with verbatim evidence quotes), cadence, protocols for what the plan did not cover, fulfillment and supersession of older expectations.
3. If the LLM is unavailable, the consultation is still processed by the rules, and a `note.extract_plan` job retries the note with exponential backoff (5 s, 10 s, ... capped at 1 h), up to 30 attempts (about 20 hours). If it still fails, the job is dead-lettered and the worker logs an error with `alert: "note_extraction_exhausted"` and the patient and document ids; re-sending the note retries it. Nothing blocks the host.
4. The hourly sweeps expire due expectations into one case per patient and reason group (`runWatcher`) and advance escalation (`runEscalation`). Every case change writes its webhook to the outbox in the same transaction.

### Reading back

| Request                                       | Returns                                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /fhir/Task?patient=<id>[&status=&code=]` | searchset of the patient's expectations (`Task` `intent: plan`) and cases (`Task` `intent: proposal`); without `patient`, the clinic's cases |
| `GET /fhir/Task/<id>`                         | one expectation or case; the `task` link of every webhook points here                                                                        |
| `GET /fhir/Condition?patient=<id>`            | conditions the engine believes the patient has, with verification status and confidence                                                      |
| `GET /fhir/DetectedIssue?patient=<id>`        | documentation findings (a note without a follow-up plan)                                                                                     |
| `GET /fhir/CommunicationRequest[/<id>]`       | contact attempts (`?patient=<id>`); the `communicationRequest` link of every `patient_contact.requested` points here                         |
| `GET /fhir/Communication[/<id>]`              | what came of each attempt (`?patient=<id>`): what the host reported and the calls the team recorded                                          |
| `GET /fhir/Flag?patient=<id>`                 | reminders the team stopped for the patient (category `follow-up-suppression`), active or reactivated                                         |

`status` matches `Task.status` (`requested`, `ready`, ...) or the engine status (`open`, `expired`, `notified`, ...); `code` is a FHIR token: the rule id or `follow-up-case`, optionally with its system (`https://hipocratesalud.com/fhir/CodeSystem/follow-up-expectation|lab_order_result_pending`; a wrong system matches nothing). `subject` is an alias of `patient`. Pages hold `_count` Tasks (default 100, at most 500, `0` for just the `total`); follow the `next` link (it carries `_offset`) until there is none. A search parameter the engine does not support is reported, never silently dropped: by default the searchset carries an `OperationOutcome` entry (`search.mode = outcome`) with a warning and the filter is not applied; with `Prefer: handling=strict` the search is a `400`. A comma inside a value is OR (`patient=a,b`, `status=requested,ready`); a parameter repeated is AND, as FHIR says (`status=requested&status=failed` matches nothing): by default it is applied with a warning in the `outcome` entry, with `Prefer: handling=strict` it is a `400` so a host that meant OR finds out. The inbox JSON API (`/api/inbox/*`) and the OpenAPI document (`/openapi.json`, browsable at `/docs`) cover the rest.

## 3. Webhooks

The engine POSTs every outbound event to the host's `WEBHOOK_URL`:

```http
POST /webhooks/follow-up-engine HTTP/1.1
Content-Type: application/json
X-FollowUp-Event: case.opened
X-FollowUp-Delivery: 2b4f0e0e-3c55-4d6b-9a6f-8f1d2a0c9e11
X-FollowUp-Timestamp: 1775476800
X-FollowUp-Signature: sha256=5d0c8f7c1b...e9a4
```

| Header                 | Meaning                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `X-FollowUp-Event`     | Event type (also `type` in the body).                                                                                        |
| `X-FollowUp-Delivery`  | Event id (also `id` in the body). Stable across retries: **deduplicate on it**.                                              |
| `X-FollowUp-Timestamp` | Unix seconds when this attempt was sent.                                                                                     |
| `X-FollowUp-Signature` | `sha256=` + hex HMAC-SHA256, with the shared `WEBHOOK_SECRET`, of `<X-FollowUp-Timestamp>.<X-FollowUp-Delivery>.<raw body>`. |

The signature covers the timestamp and the delivery id as well as the body, so a captured webhook cannot be replayed with a fresh timestamp or a new delivery id: both headers can be trusted once the signature checks out.

Bodies are deliberately thin: ids, codes, numbers and dates. Never a diagnosis, a test name, a reason label or note text (a reason code like `protocol_diabetes_hba1c` would already name a condition). Fetch details with `GET /fhir/Task/<caseId>` if needed.

### `case.opened`

A case entered the clinic's inbox (one per patient and reason group; later reasons merge into it).

```json
{
  "id": "2b4f0e0e-3c55-4d6b-9a6f-8f1d2a0c9e11",
  "type": "case.opened",
  "clinicId": "clinic-demo",
  "occurredAt": "2026-01-21T12:00:00.000Z",
  "data": {
    "caseId": "8c0d6b4e-6f43-4a8e-9a55-1f0c3a2b7d10",
    "patientId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01",
    "priority": 45,
    "origin": "live",
    "reasonCount": 2,
    "task": "Task/8c0d6b4e-6f43-4a8e-9a55-1f0c3a2b7d10"
  }
}
```

### `case.escalated`

The case moved along its escalation policy. `default_v1`: notify the owner at day 0, raise priority and ask for patient contact at day 14, escalate to coordination at day 21, lost to follow-up at day 35. `default_v2` (the demo clinic's; `ClinicSettings.escalationPolicyId` per clinic): a WhatsApp at day 14, a front-desk call at day 21 if nobody answered, coordination at day 21, a second WhatsApp at day 28, lost at day 35. Lost to follow-up only when attempts were made, nobody answered and every answer window is over (waiting for the last one when it ends later); otherwise the case stays with the coordinator. A case keeps the policy it opened with.

```json
{
  "id": "6a1f0b2c-1d3e-4f5a-8b9c-0d1e2f3a4b5c",
  "type": "case.escalated",
  "clinicId": "clinic-demo",
  "occurredAt": "2026-02-11T12:00:00.000Z",
  "data": {
    "caseId": "8c0d6b4e-6f43-4a8e-9a55-1f0c3a2b7d10",
    "patientId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01",
    "escalationStep": 3,
    "priority": 65,
    "task": "Task/8c0d6b4e-6f43-4a8e-9a55-1f0c3a2b7d10"
  }
}
```

### `patient_contact.requested`

The engine (escalation policy) or a clinic user ("Ask for contact" in the inbox) asks the host to message the patient: one contact attempt, a FHIR `CommunicationRequest` (`communicationRequest`, readable with `GET /fhir/CommunicationRequest/<id>`). Only sent when the clinic allows patient contact (`ClinicSettings.allowPatientContact`), the patient has not opted out and their number is not flagged as wrong; automatic messages are capped at one per patient every 14 days, whatever the number of cases. `channel` is the policy's hint (`whatsapp`, `sms`, `email`), absent when the host chooses; `attempt` counts the attempts of the case; `dueBy` is when the attempt counts as unanswered. `language` is the patient's preferred language (BCP-47, from `Patient.communication`), or `null` when the host never stated one: **write the message in that language**, and in the clinic's own language when it is `null`. Calls are not sent: they are tasks for the clinic team in the inbox.

```json
{
  "id": "0f9e8d7c-6b5a-4c3d-2e1f-0a9b8c7d6e5f",
  "type": "patient_contact.requested",
  "clinicId": "clinic-demo",
  "occurredAt": "2026-02-04T12:00:00.000Z",
  "data": {
    "caseId": "8c0d6b4e-6f43-4a8e-9a55-1f0c3a2b7d10",
    "patientId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01",
    "purpose": "complete_pending_test",
    "dueBy": "2026-02-11T12:00:00.000Z",
    "channel": "whatsapp",
    "attempt": 1,
    "language": "es-VE",
    "task": "Task/8c0d6b4e-6f43-4a8e-9a55-1f0c3a2b7d10",
    "communicationRequest": "CommunicationRequest/7b0d3f52-2c1e-4f7a-9b6d-1e2f3a4b5c6d"
  }
}
```

`purpose` is one of `schedule_follow_up`, `complete_pending_test`, `review_results`, `medication_review`. The host turns it into its own generic message, in `language`, on its own channel (WhatsApp for Hipócrates): "Hola, Ana. Tienes un control pendiente con tu equipo de salud. Responde este mensaje para agendar tu cita." for `es-VE`, "Hi Ana, you have a pending check-up with your care team. Reply to this message to book your visit." for `en`. Never put clinical content in the message.

### `contact.outcome_recorded`

A clinic user recorded what came of a call ("Call the patient" in the inbox). Sent because the host owns the patient's contact data and its own reminders: a `wrong_number` means the phone number needs fixing (send the `Patient` again with the corrected `telecom` and the engine trusts it again), `booked` or `declined` mean the host should not keep messaging about it. Outcomes the host itself reported are not echoed back. Codes and links only; `GET /fhir/Communication/<id>` has the rest.

```json
{
  "id": "3c2b1a09-8f7e-4d6c-9b5a-4e3d2c1b0a99",
  "type": "contact.outcome_recorded",
  "clinicId": "clinic-demo",
  "occurredAt": "2026-02-11T15:20:00.000Z",
  "data": {
    "caseId": "8c0d6b4e-6f43-4a8e-9a55-1f0c3a2b7d10",
    "patientId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01",
    "outcome": "wrong_number",
    "channel": "phone_call",
    "task": "Task/8c0d6b4e-6f43-4a8e-9a55-1f0c3a2b7d10",
    "communicationRequest": "CommunicationRequest/1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6",
    "communication": "Communication/9e8d7c6b-5a49-4b38-a271-605f4e3d2c1b"
  }
}
```

### `case.resolved`

The case closed: what was expected happened (`fulfilled`), the team handled it or the patient was treated elsewhere (`handled_outside`), it was dismissed or superseded (`not_needed`), the patient declined (`patient_declined`) or could not be reached after every attempt (`patient_unreachable`).

```json
{
  "id": "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  "type": "case.resolved",
  "clinicId": "clinic-demo",
  "occurredAt": "2026-01-28T15:10:00.000Z",
  "data": {
    "caseId": "8c0d6b4e-6f43-4a8e-9a55-1f0c3a2b7d10",
    "patientId": "5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01",
    "resolution": "fulfilled",
    "task": "Task/8c0d6b4e-6f43-4a8e-9a55-1f0c3a2b7d10"
  }
}
```

### `backfill.completed`

The initial scan of the clinic's history finished. Counters only: how much history was replayed, how much of what it expected the history already closed, how many cases were opened, how many were given a release day (`casesScheduled`, released in daily batches as `case.opened`) and how many are too old to notify (`casesNotNotified`, listed among the patients to recover only). `shadow: true` means nothing was scheduled.

```json
{
  "id": "4d3c2b1a-0f9e-4d8c-b7a6-5e4d3c2b1a0f",
  "type": "backfill.completed",
  "clinicId": "clinic-demo",
  "occurredAt": "2026-01-05T12:00:00.000Z",
  "data": {
    "runId": "backfill-2026-01-05",
    "shadow": false,
    "patientsScanned": 148,
    "eventsProcessed": 6439,
    "documentsProcessed": 867,
    "expectationsCreated": 2713,
    "expectationsFulfilled": 2055,
    "casesOpened": 104,
    "llmCostUsd": 0,
    "casesScheduled": 104,
    "casesNotNotified": 0
  }
}
```

### `backfill.paused`

Alert: the scan stopped before the end because the clinic's monthly LLM budget ran out (`reason: "llm_budget_exceeded"`). Counters are the work done so far; the run resumes from the last finished patient once there is budget. Raise the budget or wait for the next month.

```json
{
  "id": "1e2d3c4b-5a69-4788-97a6-b5c4d3e2f1a0",
  "type": "backfill.paused",
  "clinicId": "clinic-demo",
  "occurredAt": "2026-01-05T12:40:00.000Z",
  "data": {
    "runId": "backfill-2026-01-05",
    "reason": "llm_budget_exceeded",
    "patientsScanned": 61,
    "eventsProcessed": 2533,
    "documentsProcessed": 340,
    "expectationsCreated": 1102,
    "expectationsFulfilled": 897,
    "casesOpened": 52,
    "llmCostUsd": 50
  }
}
```

### `clinical_finding.created`

The clinical reviewer ([docs/reviewer.md](reviewer.md)) found something in a patient's record, in a category the clinic's clinical team validated for live use. Shadow findings, those of categories still under validation, never produce it. The payload carries ids and severity only. Read the finding (summary, rationale, suggestion, cited evidence) as a FHIR `DetectedIssue` from `GET /fhir/DetectedIssue?patient=<patientId>` and show it to the clinical team, never to the patient.

```json
{
  "id": "6b1f0f0e-3c55-4d3e-9a2b-0c7e8d9f1a2b",
  "type": "clinical_finding.created",
  "clinicId": "clinic-demo",
  "occurredAt": "2026-01-05T12:10:00.000Z",
  "data": {
    "findingId": "2f8c1d4e-7a90-4b1c-8e3d-5f6a7b8c9d0e",
    "patientId": "rev-0004",
    "severity": "high",
    "detectedIssue": "DetectedIssue/2f8c1d4e-7a90-4b1c-8e3d-5f6a7b8c9d0e"
  }
}
```

### `reconciliation.completed`

The nightly reconciliation of the clinic ran ([below](#nightly-reconciliation)): how many patients it looked at (`scope: "recent"`, those with new events since the previous run; `"all"`, a full sweep), how many it repaired or left for the next night because they were changing at that moment (`patientsSkipped`), and the repairs by kind (`expectationCreated`, `expectationFulfilled`, `expectationSuperseded`, `expectationCancelled`, `expectationReopened`, `expectationUnlinked`, `conditionRecorded`, `caseOpened`, `caseResolved`). Counts only. A night with nothing new to look at sends nothing. Cases a repair opened or resolved also send their own `case.opened` / `case.resolved`.

```json
{
  "id": "0c9b8a7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d",
  "type": "reconciliation.completed",
  "clinicId": "clinic-demo",
  "occurredAt": "2026-01-06T07:00:00.000Z",
  "data": {
    "runId": "reconciliation-2026-01-06T07:00:00.000Z",
    "scope": "recent",
    "patientsScanned": 12,
    "patientsRepaired": 0,
    "patientsSkipped": 0,
    "repairs": 0,
    "expectationCreated": 0,
    "expectationFulfilled": 0,
    "expectationSuperseded": 0,
    "expectationCancelled": 0,
    "expectationReopened": 0,
    "expectationUnlinked": 0,
    "conditionRecorded": 0,
    "caseOpened": 0,
    "caseResolved": 0
  }
}
```

### `reconciliation.repairs_found`

Alert, sent with `reconciliation.completed` when the run repaired anything: state that a lost or out-of-order event had left inconsistent was put right (each repair is in the audit trail, actor `system`, reason `reconciliation`). Same data. A clean integration never triggers it: when it fires, something stored a clinical event without its effect (a defect, a manual change to the database, an import that skipped the annotator); the repair log names each patient and entity.

```json
{
  "id": "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
  "type": "reconciliation.repairs_found",
  "clinicId": "clinic-demo",
  "occurredAt": "2026-01-06T07:00:00.000Z",
  "data": {
    "runId": "reconciliation-2026-01-06T07:00:00.000Z",
    "scope": "recent",
    "patientsScanned": 12,
    "patientsRepaired": 1,
    "patientsSkipped": 0,
    "repairs": 2,
    "expectationCreated": 0,
    "expectationFulfilled": 1,
    "expectationSuperseded": 0,
    "expectationCancelled": 0,
    "expectationReopened": 0,
    "expectationUnlinked": 0,
    "conditionRecorded": 0,
    "caseOpened": 0,
    "caseResolved": 1
  }
}
```

### Verifying the signature (Node)

Verify the exact bytes received, before parsing, in constant time; reject (401) a signature that does not match or a timestamp more than 5 minutes from your clock; then deduplicate on the (signed) delivery id.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';

const app = express();
const TOLERANCE_SECONDS = 300;

app.post(
  '/webhooks/follow-up-engine',
  express.raw({ type: 'application/json' }), // keep the raw body
  async (req, res) => {
    const timestamp = req.get('X-FollowUp-Timestamp') ?? '';
    const delivery = req.get('X-FollowUp-Delivery') ?? '';
    const signed = Buffer.concat([Buffer.from(`${timestamp}.${delivery}.`), req.body]);
    const expected = Buffer.from(
      'sha256=' +
        createHmac('sha256', process.env.FOLLOW_UP_WEBHOOK_SECRET).update(signed).digest('hex'),
    );
    const received = Buffer.from(req.get('X-FollowUp-Signature') ?? '');
    const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) <= TOLERANCE_SECONDS;
    if (!fresh || expected.length !== received.length || !timingSafeEqual(expected, received)) {
      return res.sendStatus(401);
    }
    const event = JSON.parse(req.body.toString('utf8'));
    const firstTime = await rememberDelivery(delivery); // unique index
    if (firstTime) {
      await queue.add(event.type, event.data); // do the work out of band
    }
    res.sendStatus(204); // answer fast: 2xx means delivered
  },
);
```

The same check is exported as `verifyWebhookSignature(secret, { timestamp, deliveryId, rawBody, signature }, { now })` from `@follow-up-engine/runtime` (with `now` it also enforces the 5-minute window), and `pnpm --filter @follow-up-engine/worker webhook-sink` runs a receiver that verifies and lists deliveries (`GET /deliveries`) for development.

### Delivery and retries

- Events are written to a transactional outbox together with the change that caused them, and delivered by the worker: **at least once**. A redelivery has the same `X-FollowUp-Delivery`.
- Any non-2xx answer, a timeout (10 s) or a network error is retried with exponential backoff: 5 s, 10 s, 20 s, ... capped at 1 h, up to 25 attempts (about 20 hours). Then the event is dead-lettered (kept in the outbox with its last error) for an operator to replay.
- Order is preserved within a delivery pass (insertion order) but not guaranteed across retries: use `occurredAt` and the case's current state (`GET /fhir/Task/<caseId>`) rather than arrival order.
- Answer `2xx` quickly and do the work asynchronously.

## 4. Closing the loop

After every message it sends for a `patient_contact.requested`, the host tells the engine what came of it with a FHIR `Communication`: `POST /fhir` (a `transaction` or `batch` Bundle, or `PUT /fhir/Communication/<id>`), `basedOn` the `CommunicationRequest` of the webhook, `subject` the patient, the outcome in the `contact-outcome` extension (or `statusReason`). Send one `Communication` per update, or new versions of the same one (`meta.versionId`): the engine keeps the latest, ignores an older version and changes nothing when the same one arrives again. The strongest outcome of an attempt decides it.

| Outcome (`CodeSystem/contact-outcome`) | When the host sends it                                      | What the engine does                                                                                                                             |
| -------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `delivered`, `read`                    | the channel's receipts                                      | nothing yet: the attempt waits for an answer until its `dueBy`                                                                                   |
| `replied`                              | the patient answered                                        | the patient is reachable: later attempts that skip when answered (the call, the second WhatsApp) are skipped; never lost to follow-up            |
| `booked`                               | the patient booked (send the `Appointment` too)             | as `replied`; the `Appointment` holds the expectation and the visit resolves the case, as always (a no-show opens it again)                      |
| `treated_elsewhere`                    | the patient is followed elsewhere                           | the case resolves as `handled_outside`                                                                                                           |
| `declined`                             | the patient does not want this follow-up                    | the case resolves as `patient_declined` (an opt-out of every contact is a `Consent`, see the mapping table)                                      |
| `wrong_number`                         | the message reached someone else                            | the patient's contact data is flagged (no more messages; the inbox shows it), the front-desk call is requested now; send the corrected `Patient` |
| `no_answer`                            | the message could not be delivered (or a `not-done` status) | the attempt is over: the next attempt of the policy goes ahead on its day                                                                        |

A `basedOn` that is not a `CommunicationRequest` of the clinic (another clinic's, or made up) is refused with an `OperationOutcome` (`not-found` at `basedOn`): a transaction is rejected whole, a batch answers that entry `400`. A `Communication` about another patient than the attempt's is refused the same way (`value` at `subject`).

**The patient answered and is treated elsewhere.** The WhatsApp of attempt 1 was answered; the host's bot (or its staff) read the answer. This is the Bundle the end-to-end suite posts (with its own ids):

<!-- e2e:communication-bundle -->

```json
{
  "resourceType": "Bundle",
  "type": "transaction",
  "entry": [
    {
      "resource": {
        "resourceType": "Communication",
        "id": "wa-0001-answer",
        "meta": { "versionId": "3", "lastUpdated": "2026-02-05T09:12:00Z" },
        "extension": [
          {
            "url": "https://hipocratesalud.com/fhir/StructureDefinition/contact-outcome",
            "valueCodeableConcept": {
              "coding": [
                {
                  "system": "https://hipocratesalud.com/fhir/CodeSystem/contact-outcome",
                  "code": "treated_elsewhere"
                }
              ]
            }
          }
        ],
        "basedOn": [{ "reference": "CommunicationRequest/7b0d3f52-2c1e-4f7a-9b6d-1e2f3a4b5c6d" }],
        "status": "completed",
        "medium": [
          {
            "coding": [
              {
                "system": "https://hipocratesalud.com/fhir/CodeSystem/contact-channel",
                "code": "whatsapp"
              }
            ]
          }
        ],
        "subject": { "reference": "Patient/5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01" },
        "sent": "2026-02-04T12:01:00Z",
        "received": "2026-02-05T09:10:00Z"
      },
      "request": { "method": "PUT", "url": "Communication/wa-0001-answer" }
    }
  ]
}
```

**The patient booked.** Send the outcome with the booking in the same Bundle: the `Appointment` fulfills the visit expectation, the `Communication` stops the next attempts.

```json
{
  "resourceType": "Bundle",
  "type": "transaction",
  "entry": [
    {
      "resource": {
        "resourceType": "Communication",
        "id": "wa-0002-answer",
        "extension": [
          {
            "url": "https://hipocratesalud.com/fhir/StructureDefinition/contact-outcome",
            "valueCodeableConcept": {
              "coding": [
                {
                  "system": "https://hipocratesalud.com/fhir/CodeSystem/contact-outcome",
                  "code": "booked"
                }
              ]
            }
          }
        ],
        "basedOn": [{ "reference": "CommunicationRequest/7b0d3f52-2c1e-4f7a-9b6d-1e2f3a4b5c6d" }],
        "status": "completed",
        "subject": { "reference": "Patient/5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01" },
        "received": "2026-02-05T09:10:00Z"
      },
      "request": { "method": "PUT", "url": "Communication/wa-0002-answer" }
    },
    {
      "resource": {
        "resourceType": "Appointment",
        "id": "appt-0002",
        "status": "booked",
        "start": "2026-02-12T14:00:00-04:00",
        "end": "2026-02-12T14:30:00-04:00",
        "participant": [
          {
            "actor": { "reference": "Patient/5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01" },
            "status": "accepted"
          }
        ]
      },
      "request": { "method": "PUT", "url": "Appointment/appt-0002" }
    }
  ]
}
```

**Wrong number.** The message could not reach the patient: a `not-done` `Communication` with the outcome in `statusReason` (or the extension). The engine flags the contact data and puts "Call the patient" in the inbox at once.

```json
{
  "resourceType": "Communication",
  "id": "wa-0003-failed",
  "basedOn": [{ "reference": "CommunicationRequest/7b0d3f52-2c1e-4f7a-9b6d-1e2f3a4b5c6d" }],
  "status": "not-done",
  "statusReason": {
    "coding": [
      {
        "system": "https://hipocratesalud.com/fhir/CodeSystem/contact-outcome",
        "code": "wrong_number"
      }
    ]
  },
  "subject": { "reference": "Patient/5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01" },
  "sent": "2026-02-04T12:01:00Z"
}
```

**A call the team made.** Calls are inbox tasks, never webhooks. When the team records the call ("Answered and booked", "Answered, treated elsewhere", "No answer", "Wrong number", "Declined follow-up"), the engine stores it as a `Communication` (medium phone, `sender` the user), reacts as to any other outcome and sends [`contact.outcome_recorded`](#contactoutcome_recorded); `GET /fhir/Communication/<id>` returns it.

What the engine does after each WhatsApp of `default_v2`, if nobody acts on the case in between:

| Day of the case | Attempt                      | If the patient answered                  | If nobody answered by its `dueBy`                   |
| --------------- | ---------------------------- | ---------------------------------------- | --------------------------------------------------- |
| 14              | WhatsApp (answer within 7 d) | the case waits for the visit or resolves | the call goes ahead on day 21                       |
| 21              | front-desk call (3 d)        | skipped                                  | coordination already has the case; second WhatsApp  |
| 28              | second WhatsApp (7 d)        | skipped                                  | lost to follow-up on day 35 (`patient_unreachable`) |

## 5. Configuration

| Variable                              | Meaning                                                                                                                                                                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                        | Postgres (vanilla or Supabase). Migrated at startup. Unset: in-memory storage (demo only).                                                                                                                                                          |
| `WEBHOOK_URL` / `WEBHOOK_SECRET`      | Where webhooks go and the shared HMAC secret. Unset URL: delivered to an in-process sink (demo).                                                                                                                                                    |
| `LLM_PROVIDER`                        | `meta` (Muse Spark, `META_API_KEY`), `baseten` (Muse Spark Open, `BASETEN_API_KEY`), `openai-compatible`, `fake`.                                                                                                                                   |
| `CLOCK`                               | `system` in production; `fake` enables the demo endpoints and the demo clinic.                                                                                                                                                                      |
| `DEMO_API_KEY` / `DEMO_INBOX_API_KEY` | Keys of the synthetic demo clinic (integration; inbox). Registered only with `CLOCK=fake`, or with `DEMO_CLINIC=true` and private keys of 24+ characters; the published defaults (`demo-clinic-key`, `demo-inbox-key`) are refused on a real clock. |
| `EMBEDDED_WORKER`                     | `true` runs the worker inside the API process (one-container deployment).                                                                                                                                                                           |

See [.env.example](../.env.example) for the full list and [deploy.md](deploy.md) for the database.

### Per-clinic rule overrides

A clinic can run a rule of [config/rules](../config/rules) with another deadline (its lab answers in a week: `lab_order_result_pending` due in 10 days instead of 15) or switch it off, without a new rule version. Only `dueInDays` (a whole number of days, 1 to 3650) and `enabled` can be overridden, and only for the clinic's rules (protocol items follow their protocol). Each change is versioned per rule and audited: who, when, old → new, why.

- **New expectations only.** An expectation created after a change carries the new deadline and the rule version with the override (`ruleVersion` `1.1.0+clinic.3`, also on the FHIR `Task`); existing ones keep the deadline and version they were created with.
- **Switched off** (`enabled: false`): the rule creates nothing new for the clinic. What it created before keeps being fulfilled, escalated and closed under the rule.
- **Reset**: the override is removed and the rule runs as versioned again (the change is still versioned and kept).
- Every process sees a change at once: the engine caches each clinic's rules and checks one revision number per read.

With a key that has `admin:rules` (`clinic:create --label admin --scopes admin:rules`) and the operator in `X-FollowUp-User` (required: it is the "who" of the history):

```http
GET /api/admin/rules
PUT /api/admin/rules
X-FollowUp-User: coordinator@clinic

{ "ruleId": "lab_order_result_pending", "override": { "dueInDays": 10 },
  "reason": "Our lab answers in a week", "expectedVersion": 0 }
```

`GET` lists every rule with its `defaults`, the `effective` values, the `version` new expectations carry and the `override` in force (with its `version`, who and why). `PUT` merges the fields given into the rule's override (`{ "enabled": false }` switches it off and keeps a deadline set before); `"override": null` resets it. The answer says whether anything changed (`changed: false` when the rule already ran like that). `expectedVersion` (the override `version` you read; `0` for a rule never changed) makes a stale change fail with `409 stale_version` instead of overwriting someone else's. An unknown rule or field, a deadline under one day, a missing reason or a missing user is `422 invalid_request`, field by field. `GET /api/admin/rules/history?ruleId=&limit=` lists the changes, newest first. The same commands from a terminal: `clinic:rules` ([deploy.md](deploy.md#rule-overrides)).

### Nightly reconciliation

A safety net for clinical events whose effect was lost (an import that stored events without annotating them, a defect since fixed, a row changed or deleted by hand) or that arrived in an order the engine could not reconcile on the spot. It works from the events the engine stored: a Bundle whose asynchronous job ended dead-lettered never produced events, so it is not reconciled: send that Bundle again (`GET /jobs/<id>` shows the job dead; ingestion is idempotent). Every night (03:00 in the clinic's time zone by default) the engine replays the stored record of each patient with new events since the previous run through the same annotator as live ingestion, in a transaction it always rolls back, compares what that replay decides with what is stored, and repairs only the differences:

- an expectation the record calls for and that does not exist is created (and, already overdue, opens or joins a case);
- an expectation the record fulfills, supersedes or cancels is closed; one whose closure no longer stands in the record is open again;
- an expired expectation grouped into a case that does not exist is open again and opens a new case; an active case whose every reason is closed is resolved.

It never duplicates anything (keys by source and rule; a patient changed by someone else while it looks is left for the next night), never applies a rule change retroactively (a rule switched back on does not create what it would have created while it was off), and changes nothing on a clean clinic. Each repair is audited with actor `system` and reason `reconciliation` (in the case's timeline when it touches a case, and in the run's repair log). Once a week (Sunday by default) it sweeps every patient instead. The run reports through `reconciliation.completed` and, when it repaired anything, `reconciliation.repairs_found`.

The schedule is per clinic (`settings.reconciliation`: `enabled`, `hour` 0 to 23 local, `fullSweepWeekday` 0 = Sunday to 6, or `null` for no weekly sweep). The initial backfill counts as a full run, so the first night only looks at what arrived after it. Operators can run it by hand with `clinic:reconcile` ([deploy.md](deploy.md#nightly-reconciliation)).
