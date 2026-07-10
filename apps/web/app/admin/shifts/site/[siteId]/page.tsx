'use client';
/**
 * Admin — Site Shifts Drill-In (/admin/shifts/site/[siteId])
 *
 * Reached from the site cards on /admin/shifts?view=site. Shows the same
 * rolling 2-week window as the parent grid, filtered to a single site,
 * as an ascending-date table. Local SCHEDULE SHIFT and ASSIGN GUARD
 * modals share components with the parent page (see
 * apps/web/components/admin/ScheduleShiftModal.tsx and
 * AssignGuardModal.tsx). Site dropdown in the schedule modal is pre-
 * filled + limited to this site — an admin who needs a different site
 * navigates back to the grid.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { adminGet } from '../../../../../lib/adminApi';
import InactiveSiteBadge from '../../../../../components/InactiveSiteBadge';
import ScheduleShiftModal from '../../../../../components/admin/ScheduleShiftModal';
import AssignGuardModal, { AssignableShift } from '../../../../../components/admin/AssignGuardModal';
import { fmtDateShort, fmtDuration, fmtTime } from '../../../../../lib/shiftFormat';

interface Site {
  id:             string;
  name:           string;
  address?:       string;
  radius_meters?: number | null;
  is_active?:     boolean;
  company_name?:  string;
}

interface Shift {
  id:               string;
  guard_id:         string | null;
  site_id:          string;
  guard_name:       string | null;
  site_name:        string;
  site_is_active?:  boolean;
  scheduled_start:  string;
  scheduled_end:    string;
  status:           'unassigned' | 'scheduled' | 'active' | 'completed' | 'cancelled' | 'missed';
}

interface Guard { id: string; name: string; badge_number: string; is_active?: boolean }

const STATUS_STYLES: Record<string, string> = {
  unassigned: 'bg-amber-400/20 text-amber-400 border border-amber-400/40',
  scheduled:  'bg-blue-500/20 text-blue-400 border border-blue-500/40',
  active:     'bg-green-500/20 text-green-400 border border-green-500/40',
  completed:  'bg-gray-700/40 text-gray-500 border border-gray-600/40',
  cancelled:  'bg-gray-700/40 text-gray-400 border border-gray-600/50',
  missed:     'bg-red-900/30 text-red-400 border border-red-700/40',
};

export default function SiteShiftsPage() {
  const params = useParams<{ siteId: string }>();
  const siteId = params?.siteId ?? '';

  const [site,    setSite]    = useState<Site | null>(null);
  const [shifts,  setShifts]  = useState<Shift[]>([]);
  const [guards,  setGuards]  = useState<Guard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const [showModal,   setShowModal]   = useState(false);
  const [assignShift, setAssignShift] = useState<Shift | null>(null);

  const today = useMemo(() => new Date(), []);
  const { twoWeekStart, twoWeekEnd } = useMemo(() => {
    const s = new Date(today); s.setHours(0, 0, 0, 0);
    const e = new Date(s); e.setDate(s.getDate() + 14); e.setHours(23, 59, 59, 999);
    return { twoWeekStart: s, twoWeekEnd: e };
  }, [today]);

  const load = useCallback(async () => {
    if (!siteId) return;
    try {
      const [siteData, shiftData, guardData] = await Promise.all([
        adminGet<Site>(`/api/sites/${siteId}`),
        adminGet<Shift[]>('/api/shifts'),
        adminGet<Guard[]>('/api/guards'),
      ]);
      setSite(siteData);
      setShifts(shiftData);
      setGuards(guardData);
      setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [siteId]);

  useEffect(() => { load(); }, [load]);

  const siteShifts = useMemo(() => {
    return shifts
      .filter((s) =>
        s.site_id === siteId &&
        s.status !== 'cancelled' &&
        new Date(s.scheduled_start) >= twoWeekStart &&
        new Date(s.scheduled_start) <= twoWeekEnd
      )
      .sort((a, b) => new Date(a.scheduled_start).getTime() - new Date(b.scheduled_start).getTime());
  }, [shifts, siteId, twoWeekStart, twoWeekEnd]);

  return (
    <div className="space-y-6">
      {/* Header + back */}
      <div>
        <Link href="/admin/shifts?view=site"
          className="text-gray-500 hover:text-amber-400 text-xs tracking-widest inline-flex items-center gap-1 mb-2">
          ← BACK TO SHIFTS
        </Link>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl md:text-3xl font-bold tracking-widest text-amber-400 break-words">
              SHIFTS AT {(site?.name ?? '…').toUpperCase()}
              <InactiveSiteBadge siteIsActive={site?.is_active} />
            </h1>
            {site && (
              <div className="text-gray-500 text-xs mt-2 flex flex-wrap gap-x-3 gap-y-1">
                {site.address && <span>{site.address}</span>}
                {site.radius_meters != null && (
                  <span className="text-gray-600">· geofence {site.radius_meters}m</span>
                )}
                {site.company_name && (
                  <span className="text-gray-600">· {site.company_name}</span>
                )}
              </div>
            )}
          </div>
          <button
            onClick={() => setShowModal(true)}
            className="bg-amber-400 text-gray-900 font-bold tracking-widest text-sm px-4 py-2 rounded-lg hover:bg-amber-300 transition-colors"
          >
            + SCHEDULE SHIFT
          </button>
        </div>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      {/* Shifts table */}
      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-gray-500 text-sm">Loading…</div>
        ) : siteShifts.length === 0 ? (
          <div className="p-10 text-center text-gray-500 text-sm">No shifts in the next 2 weeks at this site.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-xs tracking-widest border-b border-[#1A3050]">
                  <th className="text-left p-4">DATE</th>
                  <th className="text-left p-4">TIME</th>
                  <th className="text-left p-4">ASSIGNED GUARD</th>
                  <th className="text-center p-4">STATUS</th>
                  <th className="text-right p-4"></th>
                </tr>
              </thead>
              <tbody>
                {siteShifts.map((s) => (
                  <tr key={s.id} className="border-b border-[#1A3050] last:border-b-0 hover:bg-[#0B1526] transition-colors">
                    <td className="p-4 text-gray-300 text-xs font-mono whitespace-nowrap">{fmtDateShort(s.scheduled_start)}</td>
                    <td className="p-4 text-gray-400 text-xs font-mono whitespace-nowrap">
                      {fmtTime(s.scheduled_start)} → {fmtTime(s.scheduled_end)}
                      <span className="text-gray-600 ml-2">({fmtDuration(s.scheduled_start, s.scheduled_end)})</span>
                    </td>
                    <td className="p-4">
                      {s.guard_name ? (
                        <span className="text-gray-200 text-sm">{s.guard_name}</span>
                      ) : (
                        <span className="text-amber-400 tracking-widest text-xs font-bold">— UNASSIGNED —</span>
                      )}
                    </td>
                    <td className="p-4 text-center">
                      <span className={`inline-block text-xs tracking-widest font-medium px-2 py-0.5 rounded ${STATUS_STYLES[s.status] ?? 'text-gray-500'}`}>
                        {s.status.toUpperCase()}
                      </span>
                    </td>
                    <td className="p-4 text-right">
                      {!s.guard_id && (
                        <button
                          onClick={() => setAssignShift(s)}
                          className="text-xs text-amber-400 tracking-widest hover:underline whitespace-nowrap"
                        >
                          ASSIGN GUARD
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Shared modals — Schedule modal is pre-filled + limited to this site */}
      <ScheduleShiftModal
        open={showModal}
        onClose={() => setShowModal(false)}
        onCreated={load}
        guards={guards}
        sites={site ? [{ id: site.id, name: site.name }] : []}
        prefilledSiteId={siteId}
      />
      <AssignGuardModal
        shift={assignShift as AssignableShift | null}
        guards={guards}
        onClose={() => setAssignShift(null)}
        onAssigned={load}
      />
    </div>
  );
}
