/**
 * The notifications-off banner's rules (N173).
 *
 * A phone that never granted notifications never posts a push token, so the
 * server has no guard_devices row for it and every ping reminder for that
 * guard goes nowhere — silently, on both sides. STARNET GRD0013 and GRD0016
 * have never had a row. Nothing on the phone said so; this does.
 *
 * Pure: no React, no Expo. scripts/check-ping-home.ts exercises it.
 */

export interface NotifPermission {
  status: 'granted' | 'denied' | 'undetermined';
  /** False once the OS will no longer show the prompt (iOS after any
   *  decision; Android after the second denial). */
  canAskAgain: boolean;
}

export interface NotifBanner {
  title: string;
  sub: string;
  /** 'request' shows the OS prompt; 'settings' opens this app's Settings
   *  page, the only route left once the OS refuses to prompt. */
  action: 'request' | 'settings';
}

const TITLE = '⚠ PING REMINDERS ARE OFF';

/** null = render nothing: permission granted, or not known yet. */
export function notificationsBannerFor(p: NotifPermission | null): NotifBanner | null {
  if (p === null || p.status === 'granted') return null;
  const canPrompt = p.status === 'undetermined' || p.canAskAgain;
  return canPrompt
    ? { title: TITLE, sub: 'You won’t be reminded when a ping is due. Tap to turn on notifications.', action: 'request' }
    : { title: TITLE, sub: 'You won’t be reminded when a ping is due. Tap to turn on notifications in Settings.', action: 'settings' };
}
