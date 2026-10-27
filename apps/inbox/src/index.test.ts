import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.ts';

describe('@follow-up-engine/inbox', () => {
  it('is wired into the workspace', () => {
    expect(PACKAGE_NAME).toBe('@follow-up-engine/inbox');
  });
});
