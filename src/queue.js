/**
 * dsh-subagent-gate — a tiny FIFO serializer.
 *
 * One human card at a time: the Web UI shows a single approval prompt per
 * session, so parallel children asking at once would otherwise stack up in an
 * unpredictable order. Everything else waits its turn; a queued ask has not
 * started its own timeout yet.
 */
export class Queue {
  constructor() {
    this.tail = Promise.resolve();
    this.depth = 0;
  }

  /** Run `fn` after every previously queued task settled. */
  run(fn, signal) {
    const aborted = () => new DOMException("Queued approval cancelled", "AbortError");
    if (signal?.aborted) return Promise.reject(aborted());
    this.depth++;
    const start = () => {
      if (signal?.aborted) throw aborted();
      return fn();
    };
    const started = this.tail.then(start, start).finally(() => { this.depth--; });
    this.tail = started.then(() => undefined, () => undefined);
    if (!signal) return started;
    return new Promise((resolve, reject) => {
      const onAbort = () => { cleanup(); reject(aborted()); };
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      started.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }
}
