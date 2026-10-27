import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';

const PREFIX = 'follow-up-inbox:';

function read(key: string): unknown {
  try {
    const raw = globalThis.sessionStorage.getItem(PREFIX + key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    // Storage blocked (private mode, sandbox) or a stale value: start empty.
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === undefined) globalThis.sessionStorage.removeItem(PREFIX + key);
    else globalThis.sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota or blocked storage: the value just does not survive navigation.
  }
}

/**
 * `useState` that survives leaving and coming back to a page in the same
 * browser tab (sessionStorage). A per-viewer convenience: the page works the
 * same without it.
 */
export function useSessionState<T>(
  key: string,
): [T | undefined, Dispatch<SetStateAction<T | undefined>>] {
  // Written by this hook only: the stored shape is the state's.
  const [value, setValue] = useState<T | undefined>(() => read(key) as T | undefined);
  useEffect(() => {
    write(key, value);
  }, [key, value]);
  return [value, setValue];
}
