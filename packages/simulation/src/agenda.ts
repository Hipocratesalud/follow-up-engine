/**
 * The simulation's event list: actions at instants of the simulated clock,
 * run in time order (ties in the order they were scheduled), so every
 * engine write happens on a clock that never goes back.
 */
interface AgendaItem {
  readonly at: number;
  readonly seq: number;
  readonly run: () => Promise<void>;
}

export class Agenda {
  readonly #heap: AgendaItem[] = [];
  #seq = 0;
  #now = Number.NEGATIVE_INFINITY;

  /** The instant of the action being run (or the last one run). */
  get now(): Date {
    return new Date(this.#now);
  }

  /** Schedules `run` at `at`; an instant in the past runs at the current one. */
  at(at: Date, run: () => Promise<void>): void {
    const item = { at: Math.max(at.getTime(), this.#now), seq: this.#seq++, run };
    const heap = this.#heap;
    heap.push(item);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const up = heap[parent];
      if (up === undefined || !before(item, up)) break;
      heap[index] = up;
      heap[parent] = item;
      index = parent;
    }
  }

  /**
   * Runs every action scheduled before `end`, in order, including those they
   * schedule. `pause` runs every `every` actions (a host lets its event loop
   * breathe there; the result does not depend on it).
   */
  async runUntil(
    end: Date,
    options: { readonly every?: number; readonly pause?: () => Promise<void> } = {},
  ): Promise<void> {
    const limit = end.getTime();
    const every = options.every ?? 500;
    for (let count = 1; ; count += 1) {
      const top = this.#heap[0];
      if (top === undefined || top.at >= limit) return;
      this.#pop();
      this.#now = top.at;
      await top.run();
      if (options.pause !== undefined && count % every === 0) await options.pause();
    }
  }

  #pop(): void {
    const heap = this.#heap;
    const last = heap.pop();
    if (last === undefined || heap.length === 0) return;
    heap[0] = last;
    let index = 0;
    for (;;) {
      const left = 2 * index + 1;
      const right = left + 1;
      let smallest = index;
      const leftItem = heap[left];
      const rightItem = heap[right];
      const current = heap[smallest];
      if (current === undefined) return;
      if (leftItem !== undefined && before(leftItem, heap[smallest] ?? current)) smallest = left;
      if (rightItem !== undefined && before(rightItem, heap[smallest] ?? current)) smallest = right;
      if (smallest === index) return;
      const swap = heap[smallest];
      if (swap === undefined) return;
      heap[smallest] = current;
      heap[index] = swap;
      index = smallest;
    }
  }
}

function before(left: AgendaItem, right: AgendaItem): boolean {
  return left.at < right.at || (left.at === right.at && left.seq < right.seq);
}
