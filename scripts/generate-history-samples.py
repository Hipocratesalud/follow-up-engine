#!/usr/bin/env python3
"""Generates the synthetic historical-import sample set (synthetic only).

One fictitious patient, Rafael Antonio Méndez, four documents over two years
(the lab's "Import history", packages/runtime/src/history-import.ts):

- 2024-02-12-nota-control.pdf: a consultation note ("HbA1c y control en 3 meses").
- 2024-05-06-informe-laboratorio.pdf: a lab report (HbA1c 8.4 %, fasting glucose).
- 2024-11-18-carta-referencia.docx: a referral letter (lipid panel, creatinine,
  ophthalmology, control in 2 months).
- 2025-12-15-foto-resultado.jpg: a phone photo of a later result (creatinine, LDL).

A second fictitious patient, Carmen Elena Rivas, with one old note, so the
daily release cap shows with two patients (one case released today, the
other waiting among the patients to recover):

- 2024-09-10-nota-hta.pdf: a hypertension note (lipid panel, control in 6 months).

A third fictitious patient, Jorge Luis Salazar, with one scanned lab report:

- 2025-03-10-informe-escaneado.pdf: an image-only PDF (a scan, no text layer):
  HbA1c 7.9 %, fasting glucose. Read by Muse Spark like a photo.

And two PDF lab reports for María (the order agent's story), twins of
packages/runtime/assets/order-agent/lab-report.jpg:

- packages/runtime/assets/order-agent/lab-report.pdf (with a text layer)
- packages/runtime/assets/order-agent/lab-report-scanned.pdf (a scan: image only)

Needs Pillow and reportlab. Run from the repo root:
    python3 scripts/generate-history-samples.py
Values and sample codes must match packages/runtime/src/order-agent/samples.ts.
"""
import io
import os
import zipfile

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

HISTORY = os.path.join('packages', 'runtime', 'assets', 'history')
AGENT = os.path.join('packages', 'runtime', 'assets', 'order-agent')
PATIENT = 'Rafael Antonio Méndez'

# Fixed metadata: the same bytes on every run (the scripted readers know the photo by sha256).
INVARIANT = dict(invariant=1)


def pdf(path, title, lines):
    sheet = canvas.Canvas(path, pagesize=A4, **INVARIANT)
    sheet.setTitle(title)
    sheet.setAuthor('Follow-up Engine synthetic data')
    sheet.setCreator('scripts/generate-history-samples.py')
    width, height = A4
    y = height - 72
    sheet.setFont('Helvetica-Bold', 15)
    sheet.drawString(64, y, title)
    y -= 26
    sheet.setFont('Helvetica', 11)
    for line in lines:
        if line.startswith('## '):
            y -= 6
            sheet.setFont('Helvetica-Bold', 11)
            sheet.drawString(64, y, line[3:])
            sheet.setFont('Helvetica', 11)
        else:
            sheet.drawString(64, y, line)
        y -= 17
    sheet.showPage()
    sheet.save()


def consultation_note():
    pdf(
        os.path.join(HISTORY, '2024-02-12-nota-control.pdf'),
        'Centro Médico Demo - Nota de consulta',
        [
            'Datos sintéticos - solo demostración',
            f'Paciente: {PATIENT}',
            'Fecha: 12/02/2024 - Medicina interna',
            '',
            '## Motivo de consulta',
            'Control de diabetes mellitus tipo 2 diagnosticada hace 4 años.',
            '## Evolución',
            'Refiere buena adherencia a metformina 850 mg cada 12 horas.',
            'Glicemia capilar en ayunas entre 140 y 160 mg/dL. Sin hipoglicemias.',
            'PA 132/84 mmHg. IMC 29,4.',
            '## Plan',
            'Continuar metformina 850 mg cada 12 horas. Reforzar dieta y actividad física.',
            'Solicito HbA1c y control en 3 meses.',
        ],
    )


def lab_report():
    pdf(
        os.path.join(HISTORY, '2024-05-06-informe-laboratorio.pdf'),
        'Laboratorio Clínico Demo - Informe de resultados',
        [
            'Datos sintéticos - solo demostración',
            f'Paciente: {PATIENT}',
            'Fecha de toma: 06/05/2024',
            'Código de muestra: HIST-LAB-20240506',
            '',
            '## Prueba / Resultado / Referencia',
            'Hemoglobina glicosilada (HbA1c)     8.4 %        4.0 - 5.6 %',
            'Glucosa en ayunas                   158 mg/dL    70 - 99 mg/dL',
            '',
            'Validado por: Lic. Demo',
        ],
    )


def second_patient_note():
    pdf(
        os.path.join(HISTORY, '2024-09-10-nota-hta.pdf'),
        'Centro Médico Demo - Nota de consulta',
        [
            'Datos sintéticos - solo demostración',
            'Paciente: Carmen Elena Rivas',
            'Fecha: 10/09/2024 - Medicina interna',
            '',
            '## Motivo de consulta',
            'Hipertensión arterial en tratamiento con losartán 50 mg diarios.',
            '## Evolución',
            'PA 148/92 mmHg. Refiere cefalea ocasional. Sin dolor torácico.',
            '## Plan',
            'Aumentar losartán a 100 mg diarios. Dieta baja en sal.',
            'Solicito perfil lipídico y control en 6 meses.',
        ],
    )


def maria_lab_report():
    pdf(
        os.path.join(AGENT, 'lab-report.pdf'),
        'Laboratorio Clínico Demo - Informe de resultados',
        [
            'Datos sintéticos - solo demostración',
            'Paciente: Maria Fernanda Rojas',
            'Fecha de toma: 29/12/2025',
            'Código de muestra: DEMO-MFR-20251229',
            '',
            '## Prueba / Resultado / Referencia',
            'Hemoglobina glicosilada (HbA1c)     8.4 %        4.0 - 5.6 %',
            'Glucosa en ayunas                   162 mg/dL    70 - 99 mg/dL',
            '',
            'Validado por: Lic. Demo',
        ],
    )


DOCX_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

DOCX_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""


def docx(path, paragraphs):
    def paragraph(text, bold=False):
        escaped = text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        run = '<w:rPr><w:b/></w:rPr>' if bold else ''
        return f'<w:p><w:r>{run}<w:t xml:space="preserve">{escaped}</w:t></w:r></w:p>'

    body = ''.join(paragraph(text[3:], True) if text.startswith('## ') else paragraph(text) for text in paragraphs)
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f'<w:body>{body}</w:body></w:document>'
    )
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in [
            ('[Content_Types].xml', DOCX_CONTENT_TYPES),
            ('_rels/.rels', DOCX_RELS),
            ('word/document.xml', document),
        ]:
            info = zipfile.ZipInfo(name, date_time=(2024, 11, 18, 12, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)


def referral_letter():
    docx(
        os.path.join(HISTORY, '2024-11-18-carta-referencia.docx'),
        [
            '## Centro Médico Demo - Carta de referencia',
            'Datos sintéticos - solo demostración',
            f'Paciente: {PATIENT}',
            'Fecha: 18/11/2024 - Medicina interna',
            'Estimado colega de oftalmología:',
            'Refiero al paciente con diabetes mellitus tipo 2 de 5 años de evolución para fondo de ojo.',
            'En consulta de hoy, HbA1c reciente de 8,4 %. Se ajusta tratamiento: metformina 1000 mg cada 12 horas.',
            'Solicito perfil lipídico y creatinina antes del próximo control.',
            'Control en 2 meses con resultados.',
            'Atentamente, Dr. Demo, Medicina interna',
        ],
    )


def font(size, bold=False):
    candidates = [
        '/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold else '/System/Library/Fonts/Supplemental/Arial.ttf',
        '/Library/Fonts/Arial.ttf',
    ]
    for path in candidates:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def result_photo():
    paper = Image.new('RGB', (900, 600), (250, 250, 246))
    draw = ImageDraw.Draw(paper)
    ink = (34, 38, 52)
    draw.text((50, 40), 'LABORATORIO CLINICO DEMO', fill=(30, 50, 110), font=font(38, True))
    draw.text((50, 92), 'Datos sinteticos - solo demostracion', fill=(110, 110, 120), font=font(20))
    draw.text((50, 140), 'Paciente: Rafael Antonio Mendez', fill=ink, font=font(28))
    draw.text((50, 180), 'Fecha de toma: 15/12/2025', fill=ink, font=font(28))
    draw.line((50, 232, 850, 232), fill=(160, 160, 170), width=2)
    draw.text((50, 248), 'Prueba', fill=ink, font=font(26, True))
    draw.text((470, 248), 'Resultado', fill=ink, font=font(26, True))
    draw.text((660, 248), 'Referencia', fill=ink, font=font(26, True))
    rows = [
        ('Creatinina', '0.9 mg/dL', '0.6 - 1.2 mg/dL'),
        ('Colesterol LDL', '128 mg/dL', '0 - 100 mg/dL'),
    ]
    y = 300
    for name, value, ref in rows:
        draw.text((50, y), name, fill=ink, font=font(25))
        draw.text((470, y), value, fill=ink, font=font(25))
        draw.text((660, y), ref, fill=ink, font=font(25))
        y += 56
    draw.line((50, y + 10, 850, y + 10), fill=(160, 160, 170), width=2)
    draw.text((50, y + 40), 'Validado por: Lic. Demo', fill=ink, font=font(24))
    desk = Image.new('RGB', (1000, 720), (92, 84, 74))
    rotated = paper.rotate(1.8, expand=True, fillcolor=(92, 84, 74))
    desk.paste(rotated, (30, 30))
    desk = desk.filter(ImageFilter.GaussianBlur(0.6))
    desk.save(os.path.join(HISTORY, '2025-12-15-foto-resultado.jpg'), 'JPEG', quality=82)


def scanned_page(lines):
    """A sheet of paper through a flatbed scanner: grayscale, slightly skewed, pixels only."""
    width, height = 1240, 1754  # A4 at 150 dpi
    paper = Image.new('L', (width, height), 246)
    draw = ImageDraw.Draw(paper)
    y = 120
    for kind, text in lines:
        if kind == 'title':
            draw.text((110, y), text, fill=40, font=font(46, True))
            y += 74
        elif kind == 'note':
            draw.text((110, y), text, fill=110, font=font(26))
            y += 56
        elif kind == 'rule':
            draw.line((110, y, width - 110, y), fill=150, width=3)
            y += 22
        elif kind == 'row':
            name, value, ref = text
            bold = name == 'Prueba'
            draw.text((110, y), name, fill=30, font=font(32, bold))
            draw.text((690, y), value, fill=30, font=font(32, bold))
            draw.text((900, y), ref, fill=30, font=font(32, bold))
            y += 62
        else:
            draw.text((110, y), text, fill=30, font=font(34))
            y += 54
    skewed = paper.rotate(0.9, expand=False, fillcolor=236, resample=Image.BICUBIC)
    return skewed.filter(ImageFilter.GaussianBlur(0.7))


def scanned_pdf(path, title, page):
    """An image-only PDF: one JPEG per page, no text layer (what a scanner without OCR writes)."""
    data = io.BytesIO()
    page.save(data, 'JPEG', quality=70)
    data.seek(0)
    sheet = canvas.Canvas(path, pagesize=A4, **INVARIANT)
    sheet.setTitle(title)
    sheet.setAuthor('Follow-up Engine synthetic data')
    sheet.setCreator('scripts/generate-history-samples.py')
    width, height = A4
    sheet.drawImage(ImageReader(data), 0, 0, width=width, height=height)
    sheet.showPage()
    sheet.save()


def scanned_report_lines(patient, date, code, rows):
    return [
        ('title', 'LABORATORIO CLINICO DEMO'),
        ('note', 'Datos sinteticos - solo demostracion'),
        ('text', f'Paciente: {patient}'),
        ('text', f'Fecha de toma: {date}'),
        ('text', f'Codigo de muestra: {code}'),
        ('rule', ''),
        ('row', ('Prueba', 'Resultado', 'Referencia')),
        *[('row', row) for row in rows],
        ('rule', ''),
        ('text', 'Validado por: Lic. Demo'),
    ]


def scanned_history_report():
    scanned_pdf(
        os.path.join(HISTORY, '2025-03-10-informe-escaneado.pdf'),
        'Informe de resultados (escaneado)',
        scanned_page(scanned_report_lines(
            'Jorge Luis Salazar', '10/03/2025', 'HIST-SCAN-20250310',
            [('Hemoglobina glicosilada (HbA1c)', '7.9 %', '4.0 - 5.6 %'),
             ('Glucosa en ayunas', '141 mg/dL', '70 - 99 mg/dL')],
        )),
    )


def maria_scanned_lab_report():
    scanned_pdf(
        os.path.join(AGENT, 'lab-report-scanned.pdf'),
        'Informe de resultados (escaneado)',
        scanned_page(scanned_report_lines(
            'Maria Fernanda Rojas', '29/12/2025', 'DEMO-MFR-20251229',
            [('Hemoglobina glicosilada (HbA1c)', '8.4 %', '4.0 - 5.6 %'),
             ('Glucosa en ayunas', '162 mg/dL', '70 - 99 mg/dL')],
        )),
    )


if __name__ == '__main__':
    os.makedirs(HISTORY, exist_ok=True)
    consultation_note()
    lab_report()
    referral_letter()
    result_photo()
    second_patient_note()
    maria_lab_report()
    scanned_history_report()
    maria_scanned_lab_report()
    print('written to', HISTORY, 'and', AGENT)
