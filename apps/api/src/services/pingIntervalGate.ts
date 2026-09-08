/**
 * Which ping cadence a NEW session is created with. SERVER-ONLY.
 *
 * ── WHAT THIS DECIDES ───────────────────────────────────────────────────
 *
 * At clock-in we stamp shift_sessions.ping_interval_minutes (schema_v68) as
 * an immutable snapshot. This module answers the one question that stamp
 * depends on: is the app on the other end capable of HONOURING a cadence
 * other than 30?
 *
 * If it is not, the snapshot must read 30 regardless of what the site says.
 * A session stamped 45 while the handset still counts down in 30-minute
 * steps would be judged by a grid the guard's own app never shows them —
 * they would be flagged for windows the countdown said were not due yet.
 * Writing the site value to a client that cannot honour it is worse than
 * ignoring the site value, because the DB would then look authoritative.
 *
 * ── WHY runtime/, NOT version/ AND NOT build/ ───────────────────────────
 *
 * The client sends, on every request (apps/mobile/lib/apiClient.ts:82):
 *
 *   platform/<os>; version/<appVersion>; build/<buildNumber>; runtime/<runtimeVersion>; update/<updateId>
 *
 * `build/` is unusable. It comes from Constants.expoConfig's
 * ios.buildNumber / android.versionCode — i.e. app.json — which EAS remote
 * versioning IGNORES. Production proves the gap: handsets report build/41
 * (iOS) and build/17 (Android) while the shipped builds are 48 and 24.
 * apiClient.ts:40-42 says so itself: "treat `build` as indicative,
 * `runtime` as authoritative".
 *
 * `version/` is nearly right and still wrong. The capability being gated is
 * JS-level — it lives in apps/mobile/lib/pingSchedule.ts, which today
 * hardcodes PING_WINDOW_MS = 30 * 60 * 1000. An OTA replaces that JS
 * WITHOUT changing the store version, so a device can gain the capability
 * while `version` stands still. runtimeVersion is what an update group is
 * published against, so it is the field that actually tracks which JS a
 * handset can be running.
 *
 * They look interchangeable in the field right now — all eight client
 * strings production has recorded carry version and runtime as the same
 * value, because app.json sets runtimeVersion to {"policy": "appVersion"}.
 * That coincidence is exactly why this is worth writing down: the two
 * diverge precisely in the case this gate exists to catch.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────
 *
 * Never throws. Every failure — absent header, malformed string, a caller
 * that is not the mobile app, an unparseable or absent runtime, a site
 * value that is not a positive integer — resolves to 30. There is no input
 * that produces an exception or a non-finite result, because this sits
 * inside the clock-in transaction and a throw here would fail a clock-in
 * over telemetry.
 */

/**
 * The cadence every client in the field uses today, and the answer whenever
 * the gate is not satisfied.
 *
 * Not a policy default and not a platform constant: it is the value
 * apps/mobile/lib/pingSchedule.ts:57 hardcodes, which is what makes it the
 * only cadence a current handset can actually display and act on.
 */
export const LEGACY_PING_INTERVAL_MINUTES = 30;

/**
 * The minimum mobile runtime that READS the session's cadence snapshot
 * instead of assuming 30.
 *
 * Named for the behaviour it gates rather than for the feature shipping it,
 * because the next thing to depend on this threshold will not be called
 * "per-site ping interval" and should not have to invent a second constant.
 *
 * ── THIS VALUE IS UNVERIFIED BY DESIGN ──────────────────────────────────
 *
 * 1.1.0 does not exist. Production is on runtime 1.0.17 and no build has
 * ever reported anything above it, so this gate returns
 * LEGACY_PING_INTERVAL_MINUTES for every client in the field today, which
 * is the intended behaviour for this phase: the column gets written, and
 * every value written is 30.
 *
 * A minor bump rather than 1.0.18 on purpose. Runtime tracks appVersion
 * ({"policy": "appVersion"}), so 1.0.18 is a routine patch release that
 * could satisfy this gate by accident, months before any JS reads the
 * snapshot. 1.1.0 has to be chosen deliberately.
 *
 * WHEN THE MOBILE SIDE LANDS: set this to that release's runtimeVersion,
 * and only after confirming the shipped bundle actually reads the snapshot.
 * The threshold is a claim about handset behaviour — do not advance it to
 * match a version number that merely exists.
 */
export const MIN_RUNTIME_READING_SESSION_INTERVAL = '1.1.0';

/** Only headers and nothing else. Mirrors services/clientIdentity.ts so the
 *  gate is testable without constructing an Express request. */
export interface MinimalReq {
  headers: Record<string, unknown>;
}

/**
 * Pull `runtime/<value>` out of the client header.
 *
 * Returns null for anything that is not a usable runtime, INCLUDING the
 * literal 'unknown' that apiClient.ts:54 emits in Expo Go and in dev builds
 * with updates disabled. A device that cannot report its runtime is treated
 * exactly like one that reports an old runtime.
 */
export function parseRuntime(header: unknown): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  // Bound the work: a hostile client controls this string entirely.
  const m = /(?:^|;)\s*runtime\/([^;]{1,64})/i.exec(raw.slice(0, 512));
  if (!m) return null;
  const value = m[1].trim();
  if (!value || value.toLowerCase() === 'unknown') return null;
  return value;
}

/**
 * Compare dot-separated versions NUMERICALLY. Returns <0, 0 or >0.
 *
 * Numeric per segment, not lexicographic: string comparison puts '1.0.9'
 * ABOVE '1.0.10' because '9' > '1', which would open the gate to a handset
 * that is actually older than the threshold. Missing segments read as 0, so
 * '1.1' and '1.1.0' are equal.
 *
 * Returns null when either side has a non-numeric segment, so callers can
 * fail closed rather than treat a garbage version as 0.0.0 — which would
 * compare BELOW the threshold and happen to be safe today, but only by
 * accident of the threshold being non-zero.
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => {
    const parts = v.split('.');
    if (parts.length === 0 || parts.length > 4) return null;
    const out: number[] = [];
    for (const p of parts) {
      if (!/^\d{1,6}$/.test(p)) return null;
      out.push(Number(p));
    }
    return out;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The cadence to stamp on a session being created right now.
 *
 * @param req                  the request (only `headers` is read)
 * @param siteIntervalMinutes  sites.ping_interval_minutes for the session's site
 * @returns the site value when the caller's runtime is at or above
 *          MIN_RUNTIME_READING_SESSION_INTERVAL, otherwise
 *          LEGACY_PING_INTERVAL_MINUTES. Never throws.
 */
export function pingIntervalForNewSession(
  req: MinimalReq,
  siteIntervalMinutes: unknown,
): number {
  try {
    const runtime = parseRuntime(req?.headers?.['x-netraops-client']);
    if (runtime === null) return LEGACY_PING_INTERVAL_MINUTES;

    const cmp = compareVersions(runtime, MIN_RUNTIME_READING_SESSION_INTERVAL);
    if (cmp === null || cmp < 0) return LEGACY_PING_INTERVAL_MINUTES;

    // Capable client. Only now does the site value matter — and it still has
    // to be a sane positive integer. sites.ping_interval_minutes is NOT NULL
    // with CHECK (BETWEEN 5 AND 240), so this should be unreachable; it is
    // here because "should be unreachable" is not a guarantee held by this
    // module, and a NaN reaching the INSERT would be a bad row rather than
    // a clean rejection.
    const site = typeof siteIntervalMinutes === 'number'
      ? siteIntervalMinutes
      : Number(siteIntervalMinutes);
    if (!Number.isInteger(site) || site <= 0) return LEGACY_PING_INTERVAL_MINUTES;

    return site;
  } catch {
    // A clock-in must never fail because of this gate.
    return LEGACY_PING_INTERVAL_MINUTES;
  }
}
