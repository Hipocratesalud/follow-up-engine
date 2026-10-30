#!/usr/bin/env python3
"""Generates the order-to-completion agent's demo assets (synthetic only).

- lab-report.jpg: a photo-like synthetic lab report for María (HbA1c 8.4 %).
- voice-note-es.wav / voice-note-en.wav: María's spoken reply, 16 kHz mono PCM.

Needs Pillow and macOS `say` + `afconvert`. Run from the repo root:
    python3 scripts/generate-order-agent-samples.py
Values must match packages/runtime/src/order-agent/samples.ts.
"""
import os
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = os.path.join('packages', 'runtime', 'assets', 'order-agent')

VOICE = {
    'es': ('Paulina', 'Hola, sí. Ya me hice el examen la semana pasada, pero el martes no puedo. ¿Hay otro día?'),
    'en': ('Samantha', "Hi, yes. I already had the test last week, but I can't make it on Tuesday. Is there another day?"),
}


def font(size, bold=False):
    candidates = [
        '/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold else '/System/Library/Fonts/Supplemental/Arial.ttf',
        '/Library/Fonts/Arial.ttf',
    ]
    for path in candidates:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def lab_report():
    paper = Image.new('RGB', (900, 640), (250, 250, 246))
    draw = ImageDraw.Draw(paper)
    ink = (34, 38, 52)
    draw.text((50, 40), 'LABORATORIO CLINICO DEMO', fill=(30, 50, 110), font=font(38, True))
    draw.text((50, 92), 'Datos sinteticos - solo demostracion', fill=(110, 110, 120), font=font(20))
    draw.text((50, 140), 'Paciente: Maria Fernanda Rojas', fill=ink, font=font(28))
    draw.text((50, 180), 'Fecha de toma: 29/12/2025', fill=ink, font=font(28))
    draw.line((50, 232, 850, 232), fill=(160, 160, 170), width=2)
    draw.text((50, 248), 'Prueba', fill=ink, font=font(26, True))
    draw.text((470, 248), 'Resultado', fill=ink, font=font(26, True))
    draw.text((660, 248), 'Referencia', fill=ink, font=font(26, True))
    rows = [
        ('Hemoglobina glicosilada (HbA1c)', '8.4 %', '4.0 - 5.6 %'),
        ('Glucosa en ayunas', '162 mg/dL', '70 - 99 mg/dL'),
    ]
    y = 300
    for name, value, ref in rows:
        draw.text((50, y), name, fill=ink, font=font(25))
        draw.text((470, y), value, fill=ink, font=font(25))
        draw.text((660, y), ref, fill=ink, font=font(25))
        y += 56
    draw.line((50, y + 10, 850, y + 10), fill=(160, 160, 170), width=2)
    draw.text((50, y + 40), 'Validado por: Lic. Demo', fill=ink, font=font(24))
    # A phone photo: a slight tilt, a desk around the paper, a little blur.
    desk = Image.new('RGB', (1000, 760), (92, 84, 74))
    rotated = paper.rotate(-2.2, expand=True, fillcolor=(92, 84, 74))
    desk.paste(rotated, (30, 30))
    desk = desk.filter(ImageFilter.GaussianBlur(0.6))
    desk.save(os.path.join(OUT, 'lab-report.jpg'), 'JPEG', quality=82)


def voice(language):
    name, text = VOICE[language]
    with tempfile.TemporaryDirectory() as tmp:
        aiff = os.path.join(tmp, 'voice.aiff')
        subprocess.run(['say', '-v', name, '-o', aiff, text], check=True)
        subprocess.run(
            ['afconvert', '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff,
             os.path.join(OUT, f'voice-note-{language}.wav')],
            check=True,
        )


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    lab_report()
    voice('es')
    voice('en')
    print('written to', OUT)
