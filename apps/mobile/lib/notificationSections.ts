/**
 * Pure list logic for the notifications tab — which rows are visible and how
 * they group into TODAY / YESTERDAY / EARLIER.
 *
 * Extracted from app/(tabs)/notifications.tsx so it can be exercised without
 * the React Native runtime. The screen itself needs a device; this does not.
 */

export interface DismissableRow {
  id: string;
  read_at: string | null;
  created_at: string;
}

export interface Section<T> {
  title: string;
  data: T[];
}

/**
 * Rows the guard should still see.
 *
 * GET /notifications returns read AND unread rows — read_at now means
 * DISMISSED (Build 44), so anything with a timestamp is filtered out here
 * rather than server-side. Client-side keeps the endpoint unchanged and shared
 * with the badge count, and LIMIT 100 already bounds how much arrives.
 */
export function visibleNotifications<T extends DismissableRow>(rows: T[]): T[] {
  return rows.filter((r) => !r.read_at);
}

/**
 * Bucket rows by day relative to `nowMs`.
 *
 * Day boundaries are DEVICE-local, matching the original behaviour and the
 * `timeAgo` label beside each row. Unlike a shift's scheduled day, "when did
 * this alert reach me" is genuinely a property of the guard's own clock, so
 * the site timezone is deliberately not involved here.
 *
 * Empty buckets are dropped so the list never renders a header with nothing
 * under it. Input order is preserved within each bucket (the server already
 * sorts created_at DESC).
 */
export function groupNotifications<T extends DismissableRow>(
  rows: T[],
  nowMs: number,
): Section<T>[] {
  const now = new Date(nowMs);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86_400_000;

  const today: T[] = [];
  const yesterday: T[] = [];
  const earlier: T[] = [];

  for (const r of rows) {
    const t = new Date(r.created_at).getTime();
    // An unparseable created_at would otherwise vanish from every bucket —
    // NaN fails all three comparisons. Show it rather than silently drop an
    // alert the guard was sent.
    if (!Number.isFinite(t)) { today.push(r); continue; }
    if (t >= todayStart) today.push(r);
    else if (t >= yesterdayStart) yesterday.push(r);
    else earlier.push(r);
  }

  return [
    ...(today.length     ? [{ title: 'TODAY',     data: today     }] : []),
    ...(yesterday.length ? [{ title: 'YESTERDAY', data: yesterday }] : []),
    ...(earlier.length   ? [{ title: 'EARLIER',   data: earlier   }] : []),
  ];
}
