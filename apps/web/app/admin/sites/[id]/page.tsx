'use client';
/**
 * Admin — Site Detail (/admin/sites/[id])
 *
 * Read-only. Minimal: site name + address, guard(s) currently on shift,
 * and upcoming shifts for the next 7 days.
 *
 * Data sources (all existing endpoints, no filters added):
 *   • GET /api/sites/:id                 — used for name + address only
 *   • GET /api/admin/live-guards         — filtered client-side by site_name
 *     (endpoint has no site_id column exposed; two identically-named sites
 *     in the same company would cross-populate — acceptable for MVP.)
 *   • GET /api/shifts                    — filtered client-side to
 *     (site_id === id) & next 7 days & !cancelled. Matches the pattern used
 *     by /admin/shifts/site/[siteId]/page.tsx.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { adminGet } from '../../../../lib/adminApi';
import { fmtTime } from '../../../../lib/shiftFormat';

interface Site {
  id:      string;
  name:    string;
  address: string;
}

interface LiveGuard {
  id:            string;
  name:          string;
  site_name:     string;
  clocked_in_at: string;
}

interface Shift {
  id:               string;
  site_id:          string;
  guard_name:       string | null;
  scheduled_start:  string;
  scheduled_end:    string;
  status:           'unassigned' | 'scheduled' | 'active' | 'completed' | 'cancelled' | 'missed';
}

const DAY_LABEL = new Intl.DateTimeFormat('en-US', {
  weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles',
});
const DATE_KEY = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Los_Angeles',
});

export default function SiteDetailPage() {
  const params = useParams<{ id: string }>();
  const siteId = params?.id ?? '';

  const [site,    setSite]    = useState<Site | null>(null);
  const [guards,  setGuards]  = useState<LiveGuard[]>([]);
  const [shifts,  setShifts]  = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const load = useCallback(async () => {
    if (!siteId) return;
    try {
      const [siteData, guardData, shiftData] = await Promise.all([
        adminGet<Site>(`/api/sites/${siteId}`),
        adminGet<LiveGuard[]>('/api/admin/live-guards').catch(() => [] as LiveGuard[]),
        adminGet<Shift[]>('/api/shifts').catch(() => [] as Shift[]),
      ]);
      setSite(siteData);
      setGuards(guardData);
      setShifts(shiftData);
      setError('');
    } catch (e: any) {
      setError(e.message ?? 'Failed to load site');
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => { load(); }, [load]);

  const presentGuards = useMemo(() => {
    if (!site) return [];
    return guards.filter((g) => g.site_name === site.name);
  }, [guards, site]);

  const upcomingShifts = useMemo(() => {
    const now  = new Date();
    const end  = new Date(now); end.setDate(end.getDate() + 7); end.setHours(23, 59, 59, 999);
    return shifts
      .filter((s) =>
        s.site_id === siteId &&
        s.status !== 'cancelled' &&
        new Date(s.scheduled_end) >= now &&
        new Date(s.scheduled_start) <= end
      )
      .sort((a, b) => new Date(a.scheduled_start).getTime() - new Date(b.scheduled_start).getTime());
  }, [shifts, siteId]);

  const shiftsByDay = useMemo(() => {
    const groups: Array<{ key: string; label: string; rows: Shift[] }> = [];
    for (const s of upcomingShifts) {
      const d   = new Date(s.scheduled_start);
      const key = DATE_KEY.format(d);
      let group = groups.find((g) => g.key === key);
      if (!group) {
        group = { key, label: DAY_LABEL.format(d).toUpperCase(), rows: [] };
        groups.push(group);
      }
      group.rows.push(s);
    }
    return groups;
  }, [upcomingShifts]);

  if (loading) {
    return <div className="p-10 text-center text-gray-500 text-sm">Loading site…</div>;
  }

  if (error || !site) {
    return (
      <div className="space-y-4">
        <Link href="/admin/sites" className="text-gray-500 hover:text-amber-400 text-xs tracking-widest inline-flex items-center gap-1">
          ← BACK TO SITES
        </Link>
        <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">
          {error || 'Site not found.'}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header + back link */}
      <div>
        <Link
          href="/admin/sites"
          className="text-gray-500 hover:text-amber-400 text-xs tracking-widest inline-flex items-center gap-1 mb-2"
        >
          ← BACK TO SITES
        </Link>
        <h1 className="text-2xl md:text-3xl font-bold tracking-widest text-amber-400 break-words">
          {site.name.toUpperCase()}
        </h1>
        {site.address && (
          <p className="text-gray-500 text-xs mt-2">{site.address}</p>
        )}
      </div>

      {/* Guard on shift */}
      <section>
        <h2 className="text-amber-400 font-bold tracking-widest text-sm mb-3">GUARD ON SHIFT</h2>
        {presentGuards.length === 0 ? (
          <p className="text-gray-500 text-sm">No guard currently on shift.</p>
        ) : (
          <ul className="divide-y divide-[#1A3050] border-y border-[#1A3050]">
            {presentGuards.map((g) => {
              const hoursWorked = (Date.now() - new Date(g.clocked_in_at).getTime()) / 3_600_000;
              return (
                <li key={g.id} className="py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex items-center gap-3">
                    <div className="min-w-0">
                      <p className="text-gray-200 text-sm">{g.name}</p>
                      <p className="text-gray-500 text-xs mt-0.5 font-mono">
                        Clocked in {fmtTime(g.clocked_in_at)}
                      </p>
                    </div>
                    <Link
                      href={`/admin/chat?siteId=${siteId}&guardId=${g.id}`}
                      className="text-xs tracking-widest text-amber-400 hover:underline whitespace-nowrap"
                    >
                      CHAT →
                    </Link>
                  </div>
                  <p className="text-gray-400 text-xs shrink-0">{hoursWorked.toFixed(1)}h</p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Upcoming shifts (next 7 days, grouped by day) */}
      <section>
        <div className="flex items-center justify-between mb-3 gap-3">
          <h2 className="text-amber-400 font-bold tracking-widest text-sm">UPCOMING SHIFTS — NEXT 7 DAYS</h2>
          <Link
            href={`/admin/shifts?newShift=1&siteId=${siteId}`}
            className="text-xs tracking-widest text-amber-400 hover:underline whitespace-nowrap"
          >
            MANAGE SCHEDULE →
          </Link>
        </div>
        {shiftsByDay.length === 0 ? (
          <p className="text-gray-500 text-sm">No upcoming shifts in the next 7 days.</p>
        ) : (
          <div className="border-y border-[#1A3050] divide-y divide-[#1A3050]">
            {shiftsByDay.map((day) => (
              <div key={day.key}>
                <div className="py-2 text-gray-500 text-xs tracking-widest font-mono">
                  {day.label}
                </div>
                <ul className="divide-y divide-[#1A3050] border-t border-[#1A3050]">
                  {day.rows.map((s) => (
                    <li key={s.id} className="py-3 flex items-center justify-between gap-3">
                      <span className="text-gray-400 text-xs font-mono shrink-0">
                        {fmtTime(s.scheduled_start)} → {fmtTime(s.scheduled_end)}
                      </span>
                      {s.guard_name ? (
                        <span className="text-gray-200 text-sm text-right">{s.guard_name}</span>
                      ) : (
                        <span className="text-amber-400 tracking-widest text-xs font-bold text-right">
                          — UNASSIGNED —
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
