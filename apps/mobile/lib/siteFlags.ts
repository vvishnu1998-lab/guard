/**
 * Site feature flags (schema_v47) — FAIL-SAFE readers.
 *
 * The flags ride the shift payload from /shifts/active-session (restore
 * path) and /shifts/:id (clock-in hydration). A pre-v47 API omits both
 * keys entirely, so absence MUST resolve to today's behaviour:
 *
 *   checkpoints_enabled absent  → TRUE  (STARNET's live scanner must
 *                                        never disappear behind an API
 *                                        version skew)
 *   vehicle_inspection_required absent → FALSE (never prompt for a
 *                                        feature the API doesn't know)
 *
 * Hence the asymmetric checks: `!== false` fails open for the scanner,
 * `=== true` fails closed for the inspection prompt. Do not "simplify"
 * either into a truthiness check.
 */

interface FlagCarrier {
  checkpoints_enabled?: boolean;
  vehicle_inspection_required?: boolean;
}

export function checkpointsEnabled(shift: FlagCarrier | null | undefined): boolean {
  return shift?.checkpoints_enabled !== false;
}

export function inspectionRequired(shift: FlagCarrier | null | undefined): boolean {
  return shift?.vehicle_inspection_required === true;
}
