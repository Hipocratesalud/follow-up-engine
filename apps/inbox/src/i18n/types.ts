import type { en } from './en.ts';

/**
 * The shape of a UI catalog: every key of the English catalog, with its
 * parameters. Catalogs are plain objects (strings and functions of typed
 * parameters), so a key is read like `t.inbox.title` and a message with
 * parameters is called like `t.inbox.showing(10, 45)`: a typo, a missing
 * key or a wrong parameter fails to compile.
 */
export type Messages = typeof en;
