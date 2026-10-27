import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.ts';

describe('@follow-up-engine/adapter-postgres', () => {
  it('is wired into the workspace', () => {
    expect(PACKAGE_NAME).toBe('@follow-up-engine/adapter-postgres');
  });
});
