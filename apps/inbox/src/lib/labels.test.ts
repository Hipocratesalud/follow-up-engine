import { describe, expect, it } from 'vitest';
import { messagesFor } from '../i18n/index.ts';
import { actorLabel, noteReader } from './labels.ts';

const en = messagesFor('en');
const es = messagesFor('es');

describe('note reader', () => {
  it('never claims a model read the note when the provider is fake', () => {
    expect(noteReader(en, { provider: 'fake', model: 'fake-extractor' })).toEqual({
      simulated: true,
      label: 'Simulated reading (no model)',
      name: 'the simulated reading',
    });
    expect(noteReader(es, { provider: 'fake', model: 'fake-extractor' }).label).toBe(
      'Lectura simulada (sin modelo)',
    );
  });

  it('names the model and its provider otherwise (brands are never translated)', () => {
    for (const t of [en, es]) {
      expect(noteReader(t, { provider: 'meta', model: 'muse-spark-1.3' }).label).toBe(
        'Muse Spark · Meta',
      );
      expect(
        noteReader(t, { provider: 'baseten', model: 'meta-models/muse-spark-open' }).label,
      ).toBe('Muse Spark Open · Baseten');
    }
  });
});

describe('timeline actors', () => {
  it('names the API default user as the clinic team, in each locale', () => {
    expect(actorLabel(en, { type: 'user', id: 'inbox-user' })).toBe('Clinic team');
    expect(actorLabel(es, { type: 'user', id: 'inbox-user' })).toBe('Equipo del consultorio');
    expect(actorLabel(en, { type: 'user', id: 'Dra. Ibarra' })).toBe('Dra. Ibarra');
  });
});
