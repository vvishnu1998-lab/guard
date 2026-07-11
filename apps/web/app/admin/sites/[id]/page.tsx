'use client';
/**
 * Admin — Site Detail (/admin/sites/[id])
 *
 * Read-only summary of one site: info block, present guards, and upcoming
 * shifts (next 7 days). All edits happen on /admin/sites (list page) —
 * this page is the drill-in linked from ActiveSitesTable rows.
 *
 * Data sources (see AUDIT — Phase 0):
 *   • GET /api/sites/:id                 — full site row
 *   • GET /api/admin/live-guards         — company-wide; filtered client-side by site_name
 *     (no site_id filter on the endpoint; guards.site_name === site.name is the
 *     match. Tiny collision risk if two sites share a name — acceptable for MVP.)
 *   • GET /api/shifts                    — newest 100 for the company; filtered
 *     client-side to (site_id === id) & (next 7 days) & (!cancelled). Matches
 *     the existing pattern in /admin/shifts/site/[siteId]/page.tsx.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { adminGet } from '../../../../lib/adminApi';
import InactiveSiteBadge from '../../../../components/InactiveSiteBadge';
import { fmtTime, fmtDuration } from '../../../../lib/shiftFormat';

interface Site {
  id:                          string;
  name:                        string;
  address:                     string;
  timezone:                    string;
  is_active:                   boolean;
  company_name?:               string;
  contract_start:              string;
  contract_end:                string | null;
  has_geofence:                boolean;
  center_lat:                  number | null;
  center_lng:                  number | null;
  radius_meters:               number | null;
  polygon_coordinates:         Array<{ lat: number; lng: number }> | null;
  photo_limit_override:        number | null;
  ping_interval_minutes:       number | null;
  instructions_pdf_url:        string | null;
  client_access_disabled_at:   string | null;
  client_star_access_until:    string | null;
}

interface LiveGuard {
  id:              string;
  name:            string;
  badge_number:    string;
  site_name:       string;
  clocked_in_at:   string;
  last_ping_type:  'gps_only' | 'gps_photo' | 'clock_in' | 'break_start' | 'break_end' | null;
  has_violation:   boolean;
}

interface Shift {
  id:               string;
  guard_id:         string | null;
  site_id:          string;
  guard_name:       string | null;
  scheduled_start:  string;
  scheduled_end:    string;
  status:           'unassigned' | 'scheduled' | 'active' | 'completed' | 'cancelled' | 'missed';
}

const STATUS_STYLES: Record<string, string> = {
  unassigned: 'bg-amber-400/20 text-amber-400 border border-amber-400/40',
  scheduled:  'bg-blue-500/20 text-blue-400 border border-blue-500/40',
  active:     'bg-green-500/20 text-green-400 border border-green-500/40',
  completed:  'bg-gray-700/40 text-gray-500 border border-gray-600/40',
  cancelled:  'bg-gray-700/40 text-gray-400 border border-gray-600/50',
  missed:     'bg-red-900/30 text-red-400 border border-red-700/40',
};

const DAY_LABEL = new Intl.DateTimeFormat('en-US', {
  weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles',
});
const DATE_KEY = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Los_Angeles',
});

function fmtContractDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles',
  });
}

function geofenceSummary(site: Site): string {
  if (!site.has_geofence) return 'Not configured';
  if (site.polygon_coordinates?.length) {
    return `Polygon · ${site.polygon_coordinates.length} points`;
  }
  if (site.radius_meters != null) {
    return `Circle · ${site.radius_meters}m radius`;
  }
  return 'Configured';
}

function clientPortalSummary(site: Site): string {
  if (site.client_access_disabled_at) return 'Disabled';
  if (!site.client_star_access_until) return 'Not configured';
  const until = new Date(site.client_star_access_until);
  if (until.getTime() < Date.now()) return `Expired ${fmtContractDate(site.client_star_access_until)}`;
  return `Enabled until ${fmtContractDate(site.client_star_access_until)}`;
}

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
    return (
      <div className="p-10 text-center text-gray-500 text-sm">Loading site…</div>
    );
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
    <div className="space-y-6">
      {/* Header + back link */}
      <div>
        <Link
          href="/admin/sites"
          className="text-gray-500 hover:text-amber-400 text-xs tracking-widest inline-flex items-center gap-1 mb-2"
        >
          ← BACK TO SITES
        </Link>
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl md:text-3xl font-bold tracking-widest text-amber-400 break-words">
              {site.name.toUpperCase()}
              <InactiveSiteBadge siteIsActive={site.is_active} />
            </h1>
            <div className="text-gray-500 text-xs mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {site.address && <span>{site.address}</span>}
              {site.company_name && <span className="text-gray-600">· {site.company_name}</span>}
            </div>
          </div>
          <span
            className={`inline-block text-xs tracking-widest font-medium px-2 py-1 rounded ${
              site.is_active
                ? 'bg-green-500/20 text-green-400 border border-green-500/40'
                : 'bg-gray-700/40 text-gray-400 border border-gray-600/50'
            }`}
          >
            {site.is_active ? 'ACTIVE' : 'INACTIVE'}
          </span>
        </div>
      </div>

      {/* Site info block */}
      <section className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
        <div className="p-4 border-b border-[#1A3050]">
          <h2 className="text-amber-400 font-bold tracking-widest text-sm">SITE INFO</h2>
        </div>
        <dl className="divide-y divide-[#1A3050]">
          <InfoRow label="Contract"      value={`${fmtContractDate(site.contract_start)} → ${site.contract_end ? fmtContractDate(site.contract_end) : 'No end date'}`} />
          <InfoRow label="Timezone"      value={site.timezone || '—'} />
          <InfoRow label="Geofence"      value={geofenceSummary(site)} />
          <InfoRow label="Ping interval" value={site.ping_interval_minutes ? `${site.ping_interval_minutes} min` : 'Default'} />
          <InfoRow label="Photo limit"   value={site.photo_limit_override != null ? `${site.photo_limit_override}/shift (override)` : 'Company default'} />
          <InfoRow label="Client portal" value={clientPortalSummary(site)} />
          <InfoRow
            label="Instructions"
            value={
              site.instructions_pdf_url ? (
                <a
                  href={site.instructions_pdf_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-amber-400 hover:underline"
                >
                  View PDF
                </a>
              ) : (
                'None'
              )
            }
          />
        </dl>
      </section>

      {/* Present guards */}
      <section className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
        <div className="p-4 border-b border-[#1A3050] flex justify-between items-center">
          <h2 className="text-amber-400 font-bold tracking-widest text-sm">GUARDS ON DUTY</h2>
          <span className="text-green-400 text-xs">{presentGuards.length} ACTIVE</span>
        </div>
        <div className="divide-y divide-[#1A3050]">
          {presentGuards.length === 0 ? (
            <p className="text-center text-gray-500 py-8 text-sm">No guards on duty.</p>
          ) : (
            presentGuards.map((g) => {
              const hoursWorked = g.clocked_in_at
                ? (Date.now() - new Date(g.clocked_in_at).getTime()) / 3_600_000
                : 0;
              const onBreak = g.last_ping_type === 'break_start';
              return (
                <div key={g.id} className="p-4 flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="text-gray-200 font-medium text-sm">{g.name}</p>
                    <p className="text-gray-500 text-xs mt-0.5 font-mono">
                      Clocked in {fmtTime(g.clocked_in_at)}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-gray-400 text-xs">{hoursWorked.toFixed(1)}h</p>
                    <div className="flex gap-1 mt-1 justify-end">
                      {onBreak && (
                        <span className="text-xs bg-yellow-900 text-yellow-400 px-1.5 py-0.5 rounded">BREAK</span>
                      )}
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${
                          g.has_violation
                            ? 'bg-red-900 text-red-400'
                            : 'bg-green-900 text-green-400'
                        }`}
                      >
                        {g.has_violation ? 'VIOLATION' : 'IN ZONE'}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* Upcoming shifts (next 7 days, grouped by day) */}
      <section className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
        <div className="p-4 border-b border-[#1A3050] flex justify-between items-center">
          <h2 className="text-amber-400 font-bold tracking-widest text-sm">UPCOMING SHIFTS — NEXT 7 DAYS</h2>
          <Link
            href={`/admin/shifts/site/${siteId}`}
            className="text-xs text-amber-400 tracking-widest hover:underline"
          >
            VIEW ALL →
          </Link>
        </div>
        {shiftsByDay.length === 0 ? (
          <p className="text-center text-gray-500 py-8 text-sm">No upcoming shifts in the next 7 days.</p>
        ) : (
          <div>
            {shiftsByDay.map((day) => (
              <div key={day.key} className="border-b border-[#1A3050] last:border-b-0">
                <div className="px-4 py-2 bg-[#0B1526] text-gray-500 text-xs tracking-widest font-mono">
                  {day.label}
                </div>
                <div className="divide-y divide-[#1A3050]">
                  {day.rows.map((s) => (
                    <div key={s.id} className="px-4 py-3 flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-gray-400 text-xs font-mono">
                          {fmtTime(s.scheduled_start)} → {fmtTime(s.scheduled_end)}
                          <span className="text-gray-600 ml-2">
                            ({fmtDuration(s.scheduled_start, s.scheduled_end)})
                          </span>
                        </div>
                        <div className="mt-1">
                          {s.guard_name ? (
                            <span className="text-gray-200 text-sm">{s.guard_name}</span>
                          ) : (
                            <span className="text-amber-400 tracking-widest text-xs font-bold">
                              — UNASSIGNED —
                            </span>
                          )}
                        </div>
                      </div>
                      <span
                        className={`inline-block text-xs tracking-widest font-medium px-2 py-0.5 rounded shrink-0 ${STATUS_STYLES[s.status] ?? 'text-gray-500'}`}
                      >
                        {s.status.toUpperCase()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="px-4 py-3 flex items-start justify-between gap-4">
      <dt className="text-gray-500 text-xs tracking-widest uppercase w-40 shrink-0">{label}</dt>
      <dd className="text-gray-200 text-sm text-right break-words">{value}</dd>
    </div>
  );
}
