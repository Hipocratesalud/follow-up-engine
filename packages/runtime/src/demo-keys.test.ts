import { afterEach, describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from './config.ts';
import { createRuntime, type EngineRuntime, registerDemoClinic } from './runtime.ts';

let runtime: EngineRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

describe('rotating the demo clinic keys', () => {
  it('a boot with new DEMO_API_KEY and DEMO_INBOX_API_KEY retires the previous keys on the same database', async () => {
    runtime = await createRuntime(
      loadRuntimeConfig({
        CLOCK: 'fake',
        LOG_LEVEL: 'silent',
        DEMO_API_KEY: 'old-host-key-0123456789',
        DEMO_INBOX_API_KEY: 'old-inbox-key-0123456789',
      }),
    );
    expect(await runtime.authenticate('old-host-key-0123456789')).toBeDefined();
    expect(await runtime.authenticate('old-inbox-key-0123456789')).toBeDefined();

    // The next boot registers the demo clinic again, with the rotated keys.
    await registerDemoClinic(runtime, 'new-host-key-0123456789', 'new-inbox-key-0123456789');

    expect(await runtime.authenticate('old-host-key-0123456789')).toBeUndefined();
    expect(await runtime.authenticate('old-inbox-key-0123456789')).toBeUndefined();
    const host = await runtime.authenticate('new-host-key-0123456789');
    const inbox = await runtime.authenticate('new-inbox-key-0123456789');
    expect(host?.scopes).toContain('fhir:write');
    expect(inbox?.scopes).toContain('inbox:act');
    expect(inbox?.scopes).not.toContain('fhir:write');
  });

  it('booting again with the same inbox key keeps it working', async () => {
    runtime = await createRuntime(
      loadRuntimeConfig({
        CLOCK: 'fake',
        LOG_LEVEL: 'silent',
        DEMO_API_KEY: 'host-key-0123456789',
        DEMO_INBOX_API_KEY: 'inbox-key-0123456789',
      }),
    );
    await registerDemoClinic(runtime, 'host-key-0123456789', 'inbox-key-0123456789');
    expect((await runtime.authenticate('inbox-key-0123456789'))?.scopes).toContain('inbox:read');
  });
});
