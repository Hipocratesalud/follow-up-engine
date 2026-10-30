# Control de hipertensión — paquete de aval clínico

**Estado:** Listo para aval médico — aún sin validar por el equipo clínico del consultorio

**Id del protocolo:** `hypertension` · **Versión:** `1.1.1`

Esta página se genera a partir de `config/protocols/hypertension.json` (y, cuando comparte una prueba, del otro archivo de protocolo que se nombra abajo) y del catálogo de motivos y acciones del motor (`apps/api/src/i18n`). Se regenera con `pnpm protocols:signoff` después de cambiar cualquiera de los dos; `pnpm test` falla si una página ya guardada deja de coincidir con una generación nueva. Nada en esta página es texto libre: cada número, código y cita de abajo se lee de la configuración, así que no puede decir algo que el motor no hace.

## Para responder primero

Estos puntos no tienen una sección específica de guía citada (ver Guías citadas abajo): el médico los confirma antes que todo lo demás.

- `visit` — Agendar control de hipertensión
- `labs` — Indicar creatinina y potasio

## Guías citadas

- 2023 ESH Guidelines for the management of arterial hypertension — European Society of Hypertension (2023). <https://doi.org/10.1097/HJH.0000000000003480>
- Guideline for the pharmacological treatment of hypertension in adults — World Health Organization (2021). <https://www.who.int/publications/i/item/9789240033986>

## A quién aplica este protocolo

- Un diagnóstico CIE-10 I10, I11, I12, I13, I15 (o uno más específico dentro de alguno de ellos, por ejemplo I10.9), con un diagnóstico confirmado, o uno que la historia solo hace probable.
- Una receta que coincide con: losartan, enalapril, amlodipin, valsartan, hydrochlorothiazide, hidroclorotiazida, captopril, lisinopril, irbesartan, telmisartan, candesartan, nifedipin, chlorthalidone, clortalidona — se lee como I10 cuando la historia no tiene un diagnóstico codificado.

## Qué se espera, y con qué frecuencia

| #   | Punto   | Qué se espera                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Con qué frecuencia | Regla de vencimiento                                                                                                                                                                                                                                                                                           | Guía                                                                                         |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | `visit` | **Agendar control de hipertensión**<br>Sin control de hipertensión en 6 meses                                                                                                                                                                                                                                                                                                                                                                                                                    | Cada 180 días.     | Vence 180 días después de la última consulta o resultado que lo cumpla; si aún no hay ninguno, 180 días después de que el paciente entró al protocolo. Una cita agendada cumple la expectativa abierta, pero nunca marca el punto de partida de la siguiente: esa siempre se cuenta desde algo que ya ocurrió. | Sin punto específico citado — ver Guías citadas arriba; el médico debe confirmar que aplica. |
| 2   | `labs`  | **Indicar creatinina y potasio**<br>Laboratorio anual pendiente (creatinina, potasio)<br>Evidencia aceptada (códigos que el motor trata como cumplimiento de este punto): 2160-0, 2823-3<br>También lo cubre un punto del plan sin código cuya cita nombra: creatinina, potasio, funcion renal, quimica sanguinea, electrolitos, creatinine, potassium<br>Comparte esta prueba con: Control de enfermedad renal crónica (`renal_function`). Una prueba, una expectativa — ver Excepciones abajo. | Cada 365 días.     | Vence 365 días después de la última consulta o resultado que lo cumpla; si aún no hay ninguno, 365 días después de que el paciente entró al protocolo. Una cita agendada cumple la expectativa abierta, pero nunca marca el punto de partida de la siguiente: esa siempre se cuenta desde algo que ya ocurrió. | Sin punto específico citado — ver Guías citadas arriba; el médico debe confirmar que aplica. |

## Excepciones y supresiones

### Ya cubierto por el plan del médico o una orden abierta

Si una expectativa viva del plan del médico o de una regla universal ya pide la misma prueba (el mismo código, un código del mismo grupo de equivalencia, o un punto del plan sin código cuya cita nombra la prueba — ver `planTerms` abajo), el protocolo nunca agrega una segunda: el plan del médico siempre gana.

### Compartido con otro protocolo, vence igual o antes

Una prueba, una expectativa: cuando otro protocolo que el consultorio también activa pide la misma prueba (mismo código o uno equivalente) igual o antes que este punto, solo queda la que vence primero.

### No declarado para este protocolo

- Sin cierre de episodio (como en embarazo): este protocolo es crónico, no episódico. Nunca termina por un diagnóstico de desenlace, ni aplica nada parecido a la visita posparto.
- Sin cierre por alta: una nota que da de alta al paciente de otro protocolo (seguimiento de tratamiento) no cierra este. Este protocolo no tiene una condición de la que sus propias notas den de alta.
- No es sensible: la condición que sigue este protocolo se puede nombrar en sus motivos, acciones sugeridas y el propósito del contacto al paciente (a diferencia del enmascaramiento de salud mental de seguimiento de tratamiento).
- Sin ventana de confirmación por resultados repetidos (a diferencia de enfermedad renal crónica, que exige dos resultados que califiquen con 90 días o más de separación): un solo resultado o diagnóstico que califique ya inscribe al paciente.
- Sin filtro de solo-tratamiento-activo (a diferencia de seguimiento de tratamiento): un diagnóstico por sí solo, sin receta activa, basta para inscribir al paciente.

## Aval

Una fila por cada punto de arriba. Un punto sin aprobar sigue funcionando tal como está escrito hasta que una nueva versión del archivo de configuración lo cambie — esta página no cambia el comportamiento por sí sola.

| Punto                                     | Aprobar   | Necesita cambios   | Comentario |
| ----------------------------------------- | --------- | ------------------ | ---------- |
| `visit` — Agendar control de hipertensión | ☐ Aprobar | ☐ Necesita cambios |            |
| `labs` — Indicar creatinina y potasio     | ☐ Aprobar | ☐ Necesita cambios |            |

**Decisión general del protocolo:** ☐ Aprobar ☐ Necesita cambios

**Nombre del médico:**

**Fecha:**

**Firma:**

## Apéndice: punto → prueba

Generado a partir de `tests.ts`; `generate.test.ts` falla si un título de abajo no es el nombre exacto de una prueba en el archivo que cita.

| Punto   | Código de motivo              | Se activa (fecha correcta)                                                                                                                                                                                                           | Se suprime con                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visit` | `protocol_hypertension_visit` | `packages/acceptance/test/protocol-signoff.test.ts` › hypertension protocol: every listed point fires, due the day the config says › protocol_hypertension_visit fires 180 days after enrollment, then 180 days after the next visit | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `labs`  | `protocol_hypertension_labs`  | `packages/acceptance/test/protocol-signoff.test.ts` › hypertension protocol: every listed point fires, due the day the config says › protocol_hypertension_labs fires 365 days after enrollment, then 365 days after the last result | covered_by_plan: `packages/acceptance/test/protocol-signoff.test.ts` › hypertension protocol: every listed exception suppresses the item › protocol_hypertension_labs covered_by_plan: an open creatinine order suppresses the protocol item<br>covered_by_protocol: `packages/acceptance/test/protocol-signoff.test.ts` › hypertension protocol: every listed exception suppresses the item › protocol_hypertension_labs covered_by_protocol: chronic kidney disease expects creatinine no later |
