/**
 * Two small async primitives, kept free of React Native imports so
 * scripts/check-end-reconcile.ts can execute them under ts-node.
 */

/**
 * Run `op` so that concurrent callers share work, and every caller's promise
 * settles only after a run that STARTED after that caller asked.
 *
 * - Nothing running: start a run; the caller gets it.
 * - A run in flight: the caller gets ONE shared trailing run, which starts
 *   when the current one settles. Every caller arriving while the first run is
 *   in flight shares that same trailing run, so a burst costs at most two runs.
 *
 * The second rule is the point. A push that arrives while a fetch is already
 * in flight must not be answered by that fetch — it was issued before the
 * admin's edit committed, and would report the old end. Returning the in-flight
 * promise (a plain in-flight guard) would do exactly that.
 *
 * `op` should not throw; if it does, the rejection reaches that run's callers
 * and never wedges later calls.
 *
 * Runs never overlap. Between a run settling and its trailing run starting
 * there are a few microtasks where `running` is already null; a call landing
 * there joins the trailing run (which has not started yet, so it still starts
 * after the call) instead of starting a second, concurrent one.
 */
export function createCoalescer(op: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let trailing: Promise<void> | null = null;

  const start = (): Promise<void> => {
    const run = op().finally(() => {
      if (running === run) running = null;
    });
    running = run;
    return run;
  };

  return () => {
    if (!running) return trailing ?? start();
    if (!trailing) {
      const next = () => {
        trailing = null;
        return start();
      };
      trailing = running.then(next, next);
    }
    return trailing;
  };
}

/**
 * Run each queued op strictly after the previous one settles, whether it
 * resolved or rejected. The returned promise carries the op's own outcome; a
 * failure never blocks the ops queued behind it.
 */
export function createSerialQueue(): <T>(op: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(op: () => Promise<T>): Promise<T> => {
    const run = tail.then(op, op);
    tail = run.catch(() => undefined);
    return run;
  };
}
