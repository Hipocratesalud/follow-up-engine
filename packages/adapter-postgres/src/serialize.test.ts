import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Queryable } from './sql.ts';
import { serialize } from './unit-of-work.ts';

/** A fake connection that records how many statements overlap. */
class RecordingClient implements Queryable {
  inFlight = 0;
  maxInFlight = 0;
  readonly order: string[] = [];

  async query<TRow extends QueryResultRow>(text: string): Promise<QueryResult<TRow>> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.order.push(text);
    this.inFlight -= 1;
    if (text === 'fail') {
      throw new Error('statement failed');
    }
    return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
  }
}

describe('serialize', () => {
  it('runs concurrent statements one at a time, in call order, and survives a failure', async () => {
    const client = new RecordingClient();
    const queryable = serialize(client);
    const results = await Promise.allSettled(
      ['a', 'b', 'fail', 'c', 'd'].map((text) => queryable.query(text)),
    );
    expect(client.maxInFlight).toBe(1);
    expect(client.order).toEqual(['a', 'b', 'fail', 'c', 'd']);
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
  });
});
