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
 * consider `on`.
 *
 * FLIPPING IT BACK NEEDS NO REBUILD, BUT IT IS NOT FREE. Both variables here
 * are read from process.env inside the functions below, once per request, so
 * the running process picks up a new value with no code change and no image
 * rebuild. The PLATFORM is the cost: a Railway variable write restarts the
 * service unless it is made with `--skip-deploys`. Budget a cold boot for any
 * toggle, and prefer `--skip-deploys` when a guard is on post. An earlier
 * version of this docblock said "flipping back needs no deploy" full stop,
 * which is true of the code and misleading about the platform.
 *
 * ── PER-GUARD EXEMPTION ─────────────────────────────────────────────────
 *
 * MOCK_LOCATION_EXEMPT_GUARD_IDS — comma-separated guard UUIDs, DEFAULT EMPTY.
 *
 * Exists for app-store review: a Play or App Store reviewer runs on an
 * emulator, an emulator reports mocked=true, and enforcement would refuse
 * their clock-in with a message telling them to contact a supervisor. One
 * UUID on this list is exempted from the REJECTION only.
 *
 * It does NOT suppress the verdict. An exempted write still carries
 * verdict 'mocked', so location_mocked lands on the row exactly as it would
 * have and the spoof stays auditable after the fact. The exemption is
 * consulted in one place — inside the mode==='on' + verdict==='mocked'
 * branch — and on no other path.
 *
 * Unset or empty is byte-identical to the behaviour before it existed.
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

/**
 * Is this guard on the per-guard exemption allowlist?
 *
 * ── THIS FUNCTION CANNOT THROW, AND THAT IS ITS WHOLE POINT ─────────────
 *
 * Every operation is total on every input: `??` against a possibly-absent
 * env var, split/trim/toLowerCase on values that are already strings by
 * construction, filter and includes on an array that always exists. There is
 * no JSON.parse, no RegExp construction, no destructuring, no indexing that
 * can land on undefined.
 *
 * WHY THE CONSTRAINT IS STRICTER THAN IT LOOKS: checkMockLocation wraps its
 * whole body in a catch that returns { reject: false }. That fail-open is
 * correct for its original scope — a telemetry or config failure must never
 * deny a guard at shift start. But it means a throw raised ANYWHERE inside
 * that try exempts EVERY guard on EVERY tenant at once, STARNET included,
 * and does it silently: no error surfaces, writes simply stop being refused.
 * A parser that cannot throw is the only thing between a malformed Railway
 * variable and fleet-wide silent disablement of this layer.
 *
 * Read per call, never cached at module scope, so a variable change takes
 * effect on the next request without a rebuild.
 *
 * Absent, empty, or whitespace-only variable yields an empty list and
 * therefore nobody exempt — byte-identical to the behaviour before this
 * function existed. A guardId that is undefined or empty is likewise never
 * exempt: the check fails toward enforcement in every ambiguous case.
 */
function isExemptGuard(guardId: string | undefined): boolean {
  const id = (guardId ?? '').trim().toLowerCase();
  if (id === '') return false;

  const raw = (process.env.MOCK_LOCATION_EXEMPT_GUARD_IDS ?? '').toLowerCase();
  if (raw.trim() === '') return false;

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .includes(id);
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

    // ── Per-guard exemption ───────────────────────────────────────────────
    // Reached ONLY here. Both early returns above have already run, so
    // verdict is 'mocked' and mode is 'shadow' or 'on'; the `reject &&`
    // narrows that to 'on'. Nothing on any other path consults the list.
    //
    // Guarding on `reject` rather than on `mode === 'on'` separately is
    // deliberate: it makes the shadow path provably untouched. In shadow,
    // reject is already false, this branch is skipped, and the mock.reject
    // line below still prints with enforced=false exactly as before.
    //
    // verdict stays 'mocked' in the return. The caller writes that straight
    // to location_mocked, so an exempted reviewer's clock-in is recorded as
    // a mocked fix and stays auditable — the exemption removes the refusal,
    // not the evidence.
    if (reject && isExemptGuard(meta.guardId)) {
      console.log(
        `mock.exempt route=${ctx} guard=${meta.guardId ?? 'unknown'} site=${meta.siteId ?? 'unknown'} ` +
        `mode=${mode} enforced=false reason=guard_exempt`,
      );
      return { reject: false, verdict };
    }

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
