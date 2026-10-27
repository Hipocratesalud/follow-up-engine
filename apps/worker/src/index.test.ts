import { describe, expect, it } from 'vitest';
import { createWorkerDependencies } from './index.ts';

describe('@follow-up-engine/worker composition root', () => {
  it('wires a clock from the core package', () => {
    const { clock } = createWorkerDependencies();
    expect(clock.now()).toBeInstanceOf(Date);
  });
});
