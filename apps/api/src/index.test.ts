import { describe, expect, it } from 'vitest';
import { createApiDependencies } from './index.ts';

describe('@follow-up-engine/api composition root', () => {
  it('wires a clock from the core package', () => {
    const { clock } = createApiDependencies();
    expect(clock.now()).toBeInstanceOf(Date);
  });
});
