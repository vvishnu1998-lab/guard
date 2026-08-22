/**
 * Mock-location rejection — Wave 2 layer one.
 *
 * ── THE THREE-STATE RULE. THIS IS THE WHOLE DESIGN. ─────────────────────
 *
 *   location_mocked === true   →  REJECT   (only when mode === 'on')
 *   location_mocked === false  →  ALLOW
 *   location_mocked == null    →  ALLOW + flag   ← NEVER reject
 *   anything throws            →  ALLOW + flag   ← NEVER reject
 *
 * NULL IS NOT A REJECT CONDITION AND MUST NEVER BECOME ONE.
 *
 * NULL means iOS (expo-location exposes `mocked` on Android only), or a
 * pre-OTA client, or an absent field. Today that is MOST OF THE FLEET:
 * every iOS device permanently, plus every Android device that has not
 * taken the update. A reject on NULL locks out the platform.
 *
 * ── FAIL OPEN IS LOAD-BEARING ───────────────────────────────────────────
 *
 * This check sits on the clock-in path — the most time-critical screen in
 * the app. A guard blocked at shift start with no bench is a worse outcome
 * than a simulated coordinate. Every failure mode here resolves to ALLOW:
 * unknown value, missing field, unset env var, thrown exception. There is
 * no code path in this module that denies on absence of a signal.
 *
 * ── ROLLOUT ─────────────────────────────────────────────────────────────
 *
 * MOCK_LOCATION_ENFORCEMENT env var, DEFAULT OFF:
 *
 *   off     (default, and the value when unset/garbage) — not evaluated
 *   shadow  — verdict computed and logged, request PROCEEDS UNCHANGED
 *   on      — reject when the OS says true
 *
 * Ship at `off`. Move to `shadow`, measure for at least a week, then
 * consider `on`. Flipping back needs no deploy.
 *
 * BEFORE ANYONE SETS THIS TO `on`, read the safety criterion:
 * in the data already held, observed `mocked`-style bursts have coincided
 * with photographs placing a guard AT their post. Under a hard reject those
 * writes would have been refused while the guard was standing at the site.
 * Until the shadow data explains that shape, `on` is not safe.
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────
 *
 * ANDROID ONLY. iOS reports nothing here and is therefore permanently
 * ALLOW+flag — it is NOT covered by this layer. Never describe this as
 * platform-wide protection.
 */

export type MockEnforcementMode = 'off' | 'shadow' | 'on';

/** Read the mode. Anything unrecognised — unset, typo, empty — is 'off'.
 *  Failing to parse the flag must never enable enforcement. */
export function mockEnforcementMode(): MockEnforcementMode {
  const raw = (process.env.MOCK_LOCATION_ENFORCEMENT ?? '').trim().toLowerCase();
  if (raw === 'on') return 'on';
  if (raw === 'shadow') return 'shadow';
  return 'off';
}

export interface MockCheckResult {
  /** True ONLY when mode==='on' AND the OS explicitly reported true. */
  reject: boolean;
  verdict: 'mocked' | 'clean' | 'unknown';
}

/** 422 body for a rejected write. The `error` code is deliberately NOT
 *  `GEOFENCE_FAILED` — different failure, different handling, and the two
 *  must stay separable in logs and in client branching.
 *
 *  ── WHY THE MESSAGE SAYS NOTHING SPECIFIC ──────────────────────────────
 *
 *  DO NOT name the setting, the menu path, or the cause in this string.
 *
 *  A remedy like "turn off Developer options → Select mock location app"
 *  is a fix instruction for an honest guard and a BYPASS INSTRUCTION for
 *  everyone else — it tells whoever triggered the check exactly which
 *  control to change to stop triggering it. The guard is told the write
 *  failed, not how to make it stop failing.
 *
 *  The full detail — route, guard, site, mode, fix age, accuracy — goes to
 *  the `mock.reject` server log, where an admin sees it and the person who
 *  tripped the check does not.
 *
 *  If this ever needs to become more helpful, route the help through the
 *  supervisor, not through the error string. */
export const MOCK_LOCATION_ERROR = {
  error: 'MOCK_LOCATION_REJECTED',
  message: "We couldn't verify your location. Please contact your supervisor.",
} as const;

interface CheckMeta {
  guardId?: string;
  siteId?: string;
  fixAgeMs?: number | null;
  accuracyM?: number | null;
}

/**
 * Evaluate the mock-location verdict for one write.
 *
 * NEVER THROWS. Any internal failure resolves to { reject: false }.
 *
 * @param mocked sanitised three-state flag from readShadowSignals()
 * @param ctx    short route label for the log line
 */
export function checkMockLocation(
  mocked: boolean | null,
  ctx: string,
  meta: CheckMeta = {},
): MockCheckResult {
  try {
    const mode = mockEnforcementMode();
    const verdict: MockCheckResult['verdict'] =
      mocked === true ? 'mocked' : mocked === false ? 'clean' : 'unknown';

    if (mode === 'off') return { reject: false, verdict };

    // Only a positive, present, affirmative TRUE is ever actionable.
    if (verdict !== 'mocked') return { reject: false, verdict };

    const reject = mode === 'on';
    // This line is the ONLY place the cause is stated. The guard-facing
    // message deliberately withholds it — see MOCK_LOCATION_ERROR.
    console.log(
      `mock.reject route=${ctx} guard=${meta.guardId ?? 'unknown'} site=${meta.siteId ?? 'unknown'} ` +
      `mode=${mode} enforced=${reject} reason=os_reported_mock_provider ` +
      `fix_age_ms=${meta.fixAgeMs ?? 'null'} accuracy=${meta.accuracyM ?? 'null'}`,
    );
    return { reject, verdict };
  } catch {
    // Telemetry or config failure must never deny a guard. Fail open.
    return { reject: false, verdict: 'unknown' };
  }
}
