/**
 * Battery-aware ping throttle (Item 7).
 *
 * State machine with hysteresis:
 *   normal       — full cadence (1x base interval)
 *   throttled_2x — battery < 20% OR Low Power Mode on. Recovery to
 *                  normal requires battery > 30% AND low-power off.
 *   throttled_3x — battery < 10%. Recovery to throttled_2x requires
 *                  battery > 15%. From there normal recovery applies.
 *
 * Thresholds (20→30 for 2x, 10→15 for 3x) are based on standard
 * low-battery hysteresis practice — proportional 1.5x gap on both
 * tiers, big enough to absorb screen-off bumps and charging blips,
 * small enough that real recovery surfaces promptly. NOT load-bearing
 * on any audit or compliance requirement; tunable from Sentry
 * breadcrumb data if we ever see flapping under real load.
 *
 * `throttle_reason` tiebreaker (Q4): when both triggers are active,
 * the helper reports 'low_battery'. Reasoning: a guard with 12%
 * battery + low-power-mode on needs the operator to know the phone
 * is about to die (actionable: SOS / escalation), not that the user
 * turned on power saving (informational). The actionable diagnostic
 * wins. If we later need to distinguish, add a second column —
 * don't conflate the values.
 *
 * Android caveat: Battery.isLowPowerModeEnabledAsync() on Android
 * maps to the battery-saver flag, which is less universally adopted
 * across OEMs than iOS Low Power Mode. Under-throttling on a
 * misreporting Android phone is acceptable; we don't ship a separate
 * banner. Documented here, not in user-facing copy.
 *
 * Telemetry: every state transition emits a Sentry breadcrumb (not
 * an event — breadcrumbs ride along with whatever event later fires).
 * If hysteresis is well-tuned we see one or two transitions per
 * shift; if it flaps we see 50 in 10 minutes and tune.
 */
import { useEffect, useState } from 'react';
import * as Battery from 'expo-battery';
import * as Sentry from '@sentry/react-native';

export type ThrottleReason = 'low_battery' | 'low_power_mode';

type ThrottleState = 'normal' | 'throttled_2x' | 'throttled_3x';

const TRIGGER_2X_BATTERY = 0.20;
const RECOVERY_2X_BATTERY = 0.30;
const TRIGGER_3X_BATTERY = 0.10;
const RECOVERY_3X_BATTERY = 0.15;

const MULTIPLIERS: Record<ThrottleState, number> = {
  normal: 1,
  throttled_2x: 2,
  throttled_3x: 3,
};

interface CurrentThrottle {
  state: ThrottleState;
  batteryLevel: number;
  lowPowerMode: boolean;
}

// Module-level singleton — read by the ping-submit code path
// (apps/mobile/app/ping/photo.tsx) which is mounted on a different
// screen than the hook subscriber (active-shift). The hook keeps this
// up-to-date as battery events fire; the ping submit reads it via
// `getCurrentThrottleReason()`.
let _current: CurrentThrottle = {
  state: 'normal',
  batteryLevel: 1,
  lowPowerMode: false,
};

function deriveReason(s: CurrentThrottle): ThrottleReason | null {
  if (s.state === 'normal') return null;
  if (s.batteryLevel < TRIGGER_2X_BATTERY) return 'low_battery';
  if (s.lowPowerMode) return 'low_power_mode';
  // Defensive: state != 'normal' but neither trigger looks active. Treat
  // as low_battery rather than null so downstream callers don't see a
  // throttled state with no reason.
  return 'low_battery';
}

function nextState(prev: ThrottleState, batteryLevel: number, lowPowerMode: boolean): ThrottleState {
  const lowBattery3x   = batteryLevel < TRIGGER_3X_BATTERY;
  const lowBattery2x   = batteryLevel < TRIGGER_2X_BATTERY;
  const recoverFrom3x  = batteryLevel > RECOVERY_3X_BATTERY;
  const recoverFrom2x  = batteryLevel > RECOVERY_2X_BATTERY && !lowPowerMode;

  switch (prev) {
    case 'normal':
      if (lowBattery3x) return 'throttled_3x';
      if (lowBattery2x || lowPowerMode) return 'throttled_2x';
      return 'normal';
    case 'throttled_2x':
      if (lowBattery3x) return 'throttled_3x';
      if (recoverFrom2x) return 'normal';
      return 'throttled_2x';
    case 'throttled_3x':
      if (recoverFrom3x) return (lowBattery2x || lowPowerMode) ? 'throttled_2x' : 'normal';
      return 'throttled_3x';
  }
}

/** Read by ping submission code — module-level current state, kept fresh
 *  by the hook. Returns null when no throttle applied. */
export function getCurrentThrottleReason(): ThrottleReason | null {
  return deriveReason(_current);
}

export interface BatteryThrottleResult {
  /** Effective ping interval after applying the throttle multiplier. */
  intervalMs: number;
  /** Same value written to location_pings.throttle_reason on the next ping. */
  throttleReason: ThrottleReason | null;
  /** Whether to show the throttle banner. */
  isThrottled: boolean;
}

export function useBatteryThrottle(baseMs: number): BatteryThrottleResult {
  const [tick, setTick] = useState(0); // forces re-render on state change

  useEffect(() => {
    let cancelled = false;

    function applyUpdate(partial: Partial<CurrentThrottle>) {
      const merged: CurrentThrottle = { ..._current, ...partial };
      const computed = nextState(merged.state, merged.batteryLevel, merged.lowPowerMode);
      const transitioned = computed !== merged.state;
      _current = { ...merged, state: computed };

      if (transitioned) {
        Sentry.addBreadcrumb({
          category: 'battery_throttle',
          level: 'info',
          message: `transition ${merged.state}→${computed}`,
          data: {
            from: merged.state,
            to: computed,
            battery_pct: Math.round(_current.batteryLevel * 100),
            low_power_mode: _current.lowPowerMode,
            effective_interval_ms: baseMs * MULTIPLIERS[computed],
          },
        });
      }
      if (!cancelled) setTick((t) => t + 1);
    }

    (async () => {
      try {
        const [level, lpm] = await Promise.all([
          Battery.getBatteryLevelAsync(),
          Battery.isLowPowerModeEnabledAsync(),
        ]);
        if (cancelled) return;
        applyUpdate({ batteryLevel: level, lowPowerMode: lpm });
      } catch (err) {
        // Simulator or older Android device that doesn't expose the API:
        // stay in 'normal' so we don't throttle phantom-low devices.
        console.warn('[battery] init failed (assuming normal state):', err);
      }
    })();

    const levelSub = Battery.addBatteryLevelListener(({ batteryLevel }) => {
      applyUpdate({ batteryLevel });
    });
    const lpmSub = Battery.addLowPowerModeListener(({ lowPowerMode }) => {
      applyUpdate({ lowPowerMode });
    });

    return () => {
      cancelled = true;
      levelSub.remove();
      lpmSub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseMs]);

  // Re-read singleton on every tick so the returned values reflect the
  // current state even though `tick` is the only React-state we hold.
  void tick;
  const multiplier = MULTIPLIERS[_current.state];
  return {
    intervalMs: baseMs * multiplier,
    throttleReason: deriveReason(_current),
    isThrottled: _current.state !== 'normal',
  };
}
