import { describe, expect, it } from 'vitest';
import { actorLabel, noteReader } from './labels.ts';

describe('note reader', () => {
  it('never claims a model read the note when the provider is fake', () => {
    expect(noteReader({ provider: 'fake', model: 'fake-extractor' })).toEqual({
      simulated: true,
      label: 'Lectura simulada (sin modelo)',
      name: 'la lectura simulada',
    });
  });

  it('names the model and its provider otherwise', () => {
    expect(noteReader({ provider: 'meta', model: 'muse-spark-1.3' }).label).toBe(
      'Muse Spark · Meta',
    );
    expect(noteReader({ provider: 'baseten', model: 'meta-models/muse-spark-open' }).label).toBe(
      'Muse Spark Open · Baseten',
    );
  });
});

describe('timeline actors', () => {
  it('names the API default user as the clinic team', () => {
    expect(actorLabel({ type: 'user', id: 'inbox-user' })).toBe('Equipo del consultorio');
    expect(actorLabel({ type: 'user', id: 'Dra. Ibarra' })).toBe('Dra. Ibarra');
  });
});
