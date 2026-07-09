/**
 * Shift-assignment push notification aggregator.
 *
 * Called post-commit from POST /shifts (all three modes: single,
 * specific_dates, repeat_days) with the set of shift rows just created.
 * Groups by guard, resolves each guard's fcm_token + the site name/tz
 * for the shift set, builds a per-guard title/body per one of three
 * shape templates, and fires the push.
 *
 * Best-effort by design — the caller wraps this in `.catch()` so a
 * push failure never rolls back a committed shift batch.
 *
 * Timezone rendering: uses the earliest shift's site.timezone (Imp #2).
 * POST /shifts only ever creates shifts at a single site per request
 * today, so this collapses to "the site's tz." The multi-site branch
 * (shape 3 below) is defensive against future batch-multi-site handlers.
 */
import { pool } from '../db/pool';
import { sendPushNotification } from './firebase';

export interface CreatedShift {
  id:              string;
  guard_id:        string | null;
  site_id:         string;
  scheduled_start: string | Date;
  scheduled_end:   string | Date;
}

interface SiteMeta {
  name:     string;
  timezone: string;
}

const PACIFIC = 'America/Los_Angeles';

function fmtDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: tz,
  }).format(d);
}

function fmtDateShort(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', timeZone: tz,
  }).format(d);
}

function fmtTime(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  }).format(d);
}

function buildMessage(
  shifts: CreatedShift[],
  siteMeta: Map<string, SiteMeta>,
): { title: string; body: string } {
  // shifts is already sorted chronologically by the caller.
  const earliest = shifts[0];
  const latest   = shifts[shifts.length - 1];
  const siteIds  = new Set(shifts.map((s) => s.site_id));
  const N        = shifts.length;
  const tz       = siteMeta.get(earliest.site_id)?.timezone ?? PACIFIC;
  const startDt  = new Date(earliest.scheduled_start);
  const endDt    = new Date(earliest.scheduled_end);
  const latestDt = new Date(latest.scheduled_start);

  // Shape 1 — single shift. Title carries the site only; body carries the
  // day + time range so the notification stack shows two lines of context
  // without duplicating the date.
  if (N === 1) {
    const siteName = siteMeta.get(earliest.site_id)?.name ?? 'your site';
    return {
      title: `New shift assigned — ${siteName}`,
      body:  `${fmtDate(startDt, tz)} · ${fmtTime(startDt, tz)} – ${fmtTime(endDt, tz)}`,
    };
  }

  // Shape 2 — 2 or 3 shifts at the same site. Guard scanning the tray sees
  // count + site up top, date bookends in the body.
  if (N <= 3 && siteIds.size === 1) {
    const siteName = siteMeta.get(earliest.site_id)?.name ?? 'your site';
    return {
      title: `${N} new shifts assigned — ${siteName}`,
      body:  `First: ${fmtDateShort(startDt, tz)}, Last: ${fmtDateShort(latestDt, tz)}`,
    };
  }

  // Shape 3 — 4+ shifts OR multi-site. Keep the title short + count-forward;
  // body summarizes span + site diversity.
  const sitePlural = siteIds.size === 1 ? '' : 's';
  return {
    title: `${N} new shifts assigned`,
    body:  `${fmtDateShort(startDt, tz)} to ${fmtDateShort(latestDt, tz)} across ${siteIds.size} site${sitePlural}`,
  };
}

/**
 * Public entry. Fire per-guard aggregated pushes for the passed shift set.
 * Returns void — errors are logged, never thrown, so callers can safely
 * `.catch()` on the promise without risking uncaught rejections.
 */
export async function pushShiftAssignments(shifts: CreatedShift[]): Promise<void> {
  if (!shifts.length) return;

  // Group by guard. Unassigned shifts (guard_id === null) are silently
  // dropped — nothing to push to.
  const byGuard = new Map<string, CreatedShift[]>();
  for (const s of shifts) {
    if (!s.guard_id) continue;
    const bucket = byGuard.get(s.guard_id) ?? [];
    bucket.push(s);
    byGuard.set(s.guard_id, bucket);
  }
  if (byGuard.size === 0) return;

  // Collect the unique site ids we need metadata for.
  const allSiteIds = new Set<string>();
  for (const bucket of byGuard.values()) {
    for (const s of bucket) allSiteIds.add(s.site_id);
  }

  const siteRows = await pool.query<{ id: string; name: string; timezone: string }>(
    'SELECT id, name, timezone FROM sites WHERE id = ANY($1::uuid[])',
    [Array.from(allSiteIds)],
  );
  const siteMeta = new Map<string, SiteMeta>();
  for (const r of siteRows.rows) siteMeta.set(r.id, { name: r.name, timezone: r.timezone });

  for (const [guardId, bucket] of byGuard) {
    try {
      const tokRow = await pool.query<{ fcm_token: string | null }>(
        'SELECT fcm_token FROM guards WHERE id = $1',
        [guardId],
      );
      const token = tokRow.rows[0]?.fcm_token;
      if (!token) continue;

      // Sort chronologically so the message uses first/last correctly.
      bucket.sort(
        (a, b) => new Date(a.scheduled_start).getTime() - new Date(b.scheduled_start).getTime(),
      );

      const { title, body } = buildMessage(bucket, siteMeta);
      const firstDate = new Date(bucket[0].scheduled_start).toISOString();
      const lastDate  = new Date(bucket[bucket.length - 1].scheduled_start).toISOString();

      const { staleToken } = await sendPushNotification({
        token,
        title,
        body,
        data: {
          type:       'shifts_assigned',
          shift_ids:  bucket.map((s) => s.id).join(','),
          count:      String(bucket.length),
          first_date: firstDate,
          last_date:  lastDate,
        },
      });
      if (staleToken) {
        await pool.query(
          'UPDATE guards SET fcm_token = NULL WHERE id = $1 AND fcm_token = $2',
          [guardId, token],
        );
      }
    } catch (err) {
      console.error('[shift-assignment-push] failed for guard', guardId, err);
    }
  }
}
