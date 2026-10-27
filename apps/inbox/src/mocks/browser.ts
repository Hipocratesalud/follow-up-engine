import { setupWorker } from 'msw/browser';
import { createHandlers } from './handlers.ts';
import { createMockStore, type MockStore } from './store.ts';

const LOG_KEY = 'inbox-mock-log';

/** Store methods that change state. Replaying them on a fresh store rebuilds the same state. */
type Command =
  | { op: 'act'; args: Parameters<MockStore['act']> }
  | { op: 'feedback'; args: Parameters<MockStore['feedback']> }
  | { op: 'reviewCondition'; args: Parameters<MockStore['reviewCondition']> }
  | { op: 'advance'; args: Parameters<MockStore['advance']> }
  | { op: 'createConsultation'; args: Parameters<MockStore['createConsultation']> };

function readLog(): Command[] {
  try {
    const raw = window.sessionStorage.getItem(LOG_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as Command[]) : [];
  } catch {
    return [];
  }
}

function writeLog(log: readonly Command[]): void {
  try {
    window.sessionStorage.setItem(LOG_KEY, JSON.stringify(log));
  } catch {
    // Storage blocked or full: the mock keeps working, it just will not survive a reload.
  }
}

function run(store: MockStore, command: Command): unknown {
  switch (command.op) {
    case 'act':
      return store.act(...command.args);
    case 'feedback':
      return store.feedback(...command.args);
    case 'reviewCondition':
      return store.reviewCondition(...command.args);
    case 'advance':
      return store.advance(...command.args);
    case 'createConsultation':
      return store.createConsultation(...command.args);
  }
}

/**
 * The mock store is deterministic, so instead of serializing its state we
 * keep the list of successful commands in sessionStorage and replay it on
 * load: a page reload during a demo keeps the story where it was.
 */
function createPersistentStore(): MockStore {
  const store = createMockStore();
  const log = readLog().filter((command) => {
    try {
      run(store, command);
      return true;
    } catch {
      return false;
    }
  });
  writeLog(log);

  function record<T>(command: Command, result: T): T {
    log.push(command);
    writeLog(log);
    return result;
  }

  return {
    ...store,
    act: (...args) => record({ op: 'act', args }, store.act(...args)),
    feedback: (...args) => record({ op: 'feedback', args }, store.feedback(...args)),
    reviewCondition: (...args) =>
      record({ op: 'reviewCondition', args }, store.reviewCondition(...args)),
    advance: (...args) => record({ op: 'advance', args }, store.advance(...args)),
    createConsultation: (...args) =>
      record({ op: 'createConsultation', args }, store.createConsultation(...args)),
  };
}

/** Starts the in-browser mock API (mock mode only). */
export async function startMockApi(): Promise<void> {
  const worker = setupWorker(
    ...createHandlers(createPersistentStore(), { latencyMs: 180, modelLatencyMs: 1300 }),
  );
  await worker.start({ onUnhandledFrame: 'bypass', quiet: true });
}
