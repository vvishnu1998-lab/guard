/**
 * UUID v4 generator — Math.random-based.
 *
 * Why not `uuid` npm package: the `uuid` package calls
 * `crypto.getRandomValues()`, which Hermes (RN's JS engine) does not expose
 * by default. That's exactly what crashed the report-submit flow during the
 * Apr-7 testing session (memory `session_apr7_2026.md`); offlineQueue.ts
 * inlined the same Math.random pattern as a fix.
 *
 * Same algorithm extracted here so new callers (currently: clock-in
 * idempotency keys) don't need to re-inline it. Not deduped against
 * offlineQueue.ts in this commit — that's a separate refactor.
 */
export function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
