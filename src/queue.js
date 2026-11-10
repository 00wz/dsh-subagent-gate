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
  run(fn) {
    this.depth++;
    const started = this.tail.then(
      () => fn(),
      () => fn(),
    );
    this.tail = started.then(
      () => undefined,
      () => undefined,
    );
    return started.finally(() => {
      this.depth--;
    });
  }
}
