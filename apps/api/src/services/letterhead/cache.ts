/**
 * In-process cache for letterhead logos. No dependency: lru-cache is in the
 * repo only as other packages' dependency, and Railway installs apps/api alone.
 *
 * Keyed by the caller (index.ts uses `${company_id}:${logo_updated_at}`, which
 * changes on every upload and removal, so a new logo is a new key and a stale
 * one is never served). Values are the validated bytes or null, a negative
 * result kept for a shorter time so a transient S3 failure does not stick.
 * Bounded by entry count AND total bytes; least recently used goes first.
 * Concurrent misses on one key share one load, so a burst of reports (the
 * 09:00 daily emails) fetches a logo once, not once per site.
 */
export interface LogoCacheOptions {
  maxEntries: number;
  maxBytes: number;
  /** How long a logo is kept. */
  hitTtlMs: number;
  /** How long "no logo" (missing, refused, unreachable) is kept. */
  missTtlMs: number;
  now?: () => number;
}

interface Entry { value: Buffer | null; bytes: number; expires: number }

export class LogoCache {
  private readonly entries = new Map<string, Entry>();
  private readonly loading = new Map<string, Promise<Buffer | null>>();
  private bytes = 0;
  private readonly now: () => number;

  constructor(private readonly opts: LogoCacheOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** The cached value for `key`, or `load()`'s result, stored. `load` must not throw. */
  get(key: string, load: () => Promise<Buffer | null>): Promise<Buffer | null> {
    const hit = this.entries.get(key);
    if (hit) {
      if (hit.expires > this.now()) {
        this.entries.delete(key);   // re-insert: Map order is the LRU order
        this.entries.set(key, hit);
        return Promise.resolve(hit.value);
      }
      this.drop(key);
    }
    const pending = this.loading.get(key);
    if (pending) return pending;
    const p = load()
      .then((value) => { this.store(key, value); return value; })
      .finally(() => { this.loading.delete(key); });
    this.loading.set(key, p);
    return p;
  }

  stats(): { entries: number; bytes: number; loading: number } {
    return { entries: this.entries.size, bytes: this.bytes, loading: this.loading.size };
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  private store(key: string, value: Buffer | null): void {
    const bytes = value ? value.length : 0;
    if (bytes > this.opts.maxBytes) return;
    this.drop(key);
    this.entries.set(key, { value, bytes, expires: this.now() + (value ? this.opts.hitTtlMs : this.opts.missTtlMs) });
    this.bytes += bytes;
    while (this.entries.size > this.opts.maxEntries || this.bytes > this.opts.maxBytes) {
      const oldest = this.entries.keys().next().value as string;
      this.drop(oldest);
    }
  }

  private drop(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.bytes -= e.bytes;
    this.entries.delete(key);
  }
}
