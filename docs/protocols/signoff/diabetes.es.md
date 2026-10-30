# Control de diabetes — paquete de aval clínico

**Estado:** Listo para aval médico — aún sin validar por el equipo clínico del consultorio

**Id del protocolo:** `diabetes` · **Versión:** `1.2.1`

Esta página se genera a partir de `config/protocols/diabetes.json` (y, cuando comparte una prueba, del otro archivo de protocolo que se nombra abajo) y del catálogo de motivos y acciones del motor (`apps/api/src/i18n`). Se regenera con `pnpm protocols:signoff` después de cambiar cualquiera de los dos; `pnpm test` falla si una página ya guardada deja de coincidir con una generación nueva. Nada en esta página es texto libre: cada número, código y cita de abajo se lee de la configuración, así que no puede decir algo que el motor no hace.

## A quién aplica este protocolo

- Un diagnóstico CIE-10 E10, E11, E13, E14 (o uno más específico dentro de alguno de ellos, por ejemplo E10.9), con un diagnóstico confirmado, o uno que la historia solo hace probable.
- Una receta que coincide con: metformin, insulin, glibenclamid, glimepirid, gliclazid, sitagliptin, vildagliptin, linagliptin, empagliflozin, dapagliflozin, liraglutid, semaglutid, dulaglutid, pioglitazon — se lee como E14 cuando la historia no tiene un diagnóstico codificado.
- Un resultado LOINC 4548-4 de 6.5 o más — se lee como E14 cuando la historia no tiene un diagnóstico codificado.

## Qué se espera, y con qué frecuencia

| #   | Punto    | Qué se espera                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Con qué frecuencia | Regla de vencimiento                                                                                                                                                                                                                                                                                           | Guía                                                                     |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | `visit`  | **Agendar control de diabetes**<br>Sin control de diabetes en 6 meses                                                                                                                                                                                                                                                                                                                                                                                                                                 | Cada 180 días.     | Vence 180 días después de la última consulta o resultado que lo cumpla; si aún no hay ninguno, 180 días después de que el paciente entró al protocolo. Una cita agendada cumple la expectativa abierta, pero nunca marca el punto de partida de la siguiente: esa siempre se cuenta desde algo que ya ocurrió. | Standards of Care in Diabetes—2025 (American Diabetes Association, 2025) |
| 2   | `hba1c`  | **Indicar HbA1c**<br>Sin HbA1c reciente (cada 3 meses)<br>Evidencia aceptada (códigos que el motor trata como cumplimiento de este punto): 4548-4, 17856-6, 4549-2, 62388-4, 59261-8<br>También lo cubre un punto del plan sin código cuya cita nombra: hba1c, hb a1c, a1c, hemoglobina glicosilada, hemoglobina glucosilada, hemoglobina glicada, glycated hemoglobin, hemoglobin a1c                                                                                                                | Cada 90 días.      | Vence 90 días después de la última consulta o resultado que lo cumpla; si aún no hay ninguno, 90 días después de que el paciente entró al protocolo. Una cita agendada cumple la expectativa abierta, pero nunca marca el punto de partida de la siguiente: esa siempre se cuenta desde algo que ya ocurrió.   | Standards of Care in Diabetes—2025 (American Diabetes Association, 2025) |
| 3   | `lipids` | **Indicar perfil lipídico**<br>Perfil lipídico anual pendiente<br>Evidencia aceptada (códigos que el motor trata como cumplimiento de este punto): 24331-1, 57698-3, 57696-7, 2093-3, 2085-9, 13457-7, 18262-6, 2089-1, 2571-8<br>También lo cubre un punto del plan sin código cuya cita nombra: perfil lipidico, lipidograma, lipidos, colesterol, trigliceridos, lipid panel<br>Comparte esta prueba con: Control de dislipidemia (`lipids`). Una prueba, una expectativa — ver Excepciones abajo. | Cada 365 días.     | Vence 365 días después de la última consulta o resultado que lo cumpla; si aún no hay ninguno, 365 días después de que el paciente entró al protocolo. Una cita agendada cumple la expectativa abierta, pero nunca marca el punto de partida de la siguiente: esa siempre se cuenta desde algo que ya ocurrió. | Standards of Care in Diabetes—2025 (American Diabetes Association, 2025) |
| 4   | `fundus` | **Referir a oftalmología para fondo de ojo**<br>Fondo de ojo anual pendiente<br>También lo cubre un punto del plan sin código cuya cita nombra: fondo de ojo, oftalmologia, oftalmologo, retinografia, fundus                                                                                                                                                                                                                                                                                         | Cada 365 días.     | Vence 365 días después de la última consulta o resultado que lo cumpla; si aún no hay ninguno, 365 días después de que el paciente entró al protocolo. Una cita agendada cumple la expectativa abierta, pero nunca marca el punto de partida de la siguiente: esa siempre se cuenta desde algo que ya ocurrió. | Standards of Care in Diabetes—2025 (American Diabetes Association, 2025) |

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

| Punto                                               | Aprobar   | Necesita cambios   | Comentario |
| --------------------------------------------------- | --------- | ------------------ | ---------- |
| `visit` — Agendar control de diabetes               | ☐ Aprobar | ☐ Necesita cambios |            |
| `hba1c` — Indicar HbA1c                             | ☐ Aprobar | ☐ Necesita cambios |            |
| `lipids` — Indicar perfil lipídico                  | ☐ Aprobar | ☐ Necesita cambios |            |
| `fundus` — Referir a oftalmología para fondo de ojo | ☐ Aprobar | ☐ Necesita cambios |            |

**Decisión general del protocolo:** ☐ Aprobar ☐ Necesita cambios

**Nombre del médico:**

**Fecha:**

**Firma:**

## Apéndice: punto → prueba

Generado a partir de `tests.ts`; `generate.test.ts` falla si un título de abajo no es el nombre exacto de una prueba en el archivo que cita.

| Punto    | Código de motivo           | Se activa (fecha correcta)                                                                                                                                                                                                    | Se suprime con                                                                                                                                                                                                                        |
| -------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visit`  | `protocol_diabetes_visit`  | `packages/acceptance/test/protocol-signoff.test.ts` › diabetes protocol: every listed point fires, due the day the config says › protocol_diabetes_visit fires 180 days after enrollment, then 180 days after the next visit  | —                                                                                                                                                                                                                                     |
| `hba1c`  | `protocol_diabetes_hba1c`  | `packages/acceptance/test/protocol-signoff.test.ts` › diabetes protocol: every listed point fires, due the day the config says › protocol_diabetes_hba1c fires 90 days after enrollment, then 90 days after the last HbA1c    | covered_by_plan: `packages/acceptance/test/protocol-signoff.test.ts` › diabetes protocol: every listed exception suppresses the item › protocol_diabetes_hba1c covered_by_plan: an open HbA1c order suppresses the protocol item      |
| `lipids` | `protocol_diabetes_lipids` | `packages/acceptance/test/protocol-signoff.test.ts` › diabetes protocol: every listed point fires, due the day the config says › protocol_diabetes_lipids fires 365 days after enrollment, then 365 days after the last panel | covered_by_protocol: `packages/acceptance/test/protocol-signoff.test.ts` › diabetes protocol: every listed exception suppresses the item › protocol_diabetes_lipids covered_by_protocol: dyslipidemia expects the same panel no later |
| `fundus` | `protocol_diabetes_fundus` | `packages/acceptance/test/protocol-signoff.test.ts` › diabetes protocol: every listed point fires, due the day the config says › protocol_diabetes_fundus fires 365 days after enrollment, then 365 days after the eye exam   | —                                                                                                                                                                                                                                     |
