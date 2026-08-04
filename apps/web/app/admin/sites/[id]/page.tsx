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
import { useParams, useRouter } from 'next/navigation';
import { adminFetch, adminGet, adminPatch, adminPost, triggerBlobDownload } from '../../../../lib/adminApi';
import { fmtTime } from '../../../../lib/shiftFormat';
import { formatHoursHHMM } from '../../../../lib/formatHours';

interface Site {
  id:       string;
  name:     string;
  address:  string;
  timezone: string;   // IANA zone (sites.timezone, NOT NULL) — CSV timestamps render in it
}

interface LiveGuard {
  id:               string;
  name:             string;
  site_name:        string;
  clocked_in_at:    string;
  // Populated by /api/admin/live-guards via JOIN shifts. Optional so
  // future consumers of the LiveGuard type without these fields still
  // compile; in practice they're always set (shift_sessions.shift_id
  // is NOT NULL and shifts.scheduled_start/end are NOT NULL).
  scheduled_start?: string | null;
  scheduled_end?:   string | null;
}

interface Shift {
  id:               string;
  site_id:          string;
  guard_name:       string | null;
  scheduled_start:  string;
  scheduled_end:    string;
  status:           'unassigned' | 'scheduled' | 'active' | 'completed' | 'cancelled' | 'missed';
}

interface Checkpoint {
  id:              string;
  site_id:         string;
  label:           string;
  code_value:      string | null;
  code_type:       string | null;
  lat:             number | null;
  lng:             number | null;
  // GPS accuracy at the linking scan. Nullable even on a linked row — the
  // v44 CHECK constraint only ties code_value/lat/lng together.
  link_accuracy_m: number | null;
  linked_at:       string | null;
  radius_meters:   number;
  sort_order:      number;
  is_active:       boolean;
  created_at:      string;
  linked:          boolean;
}

interface CheckpointScan {
  id:               string;
  checkpoint_id:    string;
  checkpoint_label: string;
  guard_name:       string;
  scanned_at:       string;
  distance_m:       number;
}

const EMPTY_CP_FORM = { label: '', radius_meters: '50', sort_order: '0', is_active: true };

const ANCHOR_DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles',
});

// Same Pacific anchoring as the page's existing DAY_LABEL / DATE_KEY.
const SCAN_TS = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  hour12: false, timeZone: 'America/Los_Angeles',
});

/** YYYY-MM-DD for <input type="date">, offset by `days` from today. */
function dateInputValue(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

const MAX_RANGE_DAYS = 92;

// ── CSV helpers (C5) ─────────────────────────────────────────────────────────
// Client-built by design: the export must be exactly the rows on screen.
// No client-side CSV utility exists in apps/web (the API's rowsToCsv isn't
// importable here), so escaping is implemented fresh:
//   • every field is quoted; embedded quotes doubled (commas/newlines safe)
//   • CSV-injection guard: fields starting with = + - @ tab or CR get a
//     leading apostrophe — labels are admin-entered and open in Excel.
function csvField(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
}

const DAY_LABEL = new Intl.DateTimeFormat('en-US', {
  weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles',
});
const DATE_KEY = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Los_Angeles',
});

export default function SiteDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const siteId = params?.id ?? '';

  const [site,    setSite]    = useState<Site | null>(null);
  const [guards,  setGuards]  = useState<LiveGuard[]>([]);
  const [shifts,  setShifts]  = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  // ── Checkpoints (C4a) ──────────────────────────────────────────────────
  const [checkpoints,  setCheckpoints]  = useState<Checkpoint[]>([]);
  const [cpLoading,    setCpLoading]    = useState(true);
  const [cpError,      setCpError]      = useState('');
  const [cpModalMode,  setCpModalMode]  = useState<'add' | 'edit' | null>(null);
  const [editingCp,    setEditingCp]    = useState<Checkpoint | null>(null);
  const [cpForm,       setCpForm]       = useState(EMPTY_CP_FORM);
  const [cpSaving,     setCpSaving]     = useState(false);
  const [cpFormError,  setCpFormError]  = useState('');
  const [unlinkCp,     setUnlinkCp]     = useState<Checkpoint | null>(null);
  const [unlinkBusy,   setUnlinkBusy]   = useState(false);
  const [unlinkError,  setUnlinkError]  = useState('');
  // deleteCp is set AFTER the first (confirm-less) DELETE call returns the
  // 409 carrying scan_count — the modal copy depends on that number.
  const [deleteCp,     setDeleteCp]     = useState<{ cp: Checkpoint; scanCount: number } | null>(null);
  const [deleteBusy,   setDeleteBusy]   = useState(false);
  const [deleteError,  setDeleteError]  = useState('');
  const [cpToggling,   setCpToggling]   = useState<string | null>(null);

  // ── Scan history (C4b) ─────────────────────────────────────────────────
  const [scanFrom,      setScanFrom]      = useState(() => dateInputValue(7));
  const [scanTo,        setScanTo]        = useState(() => dateInputValue(0));
  const [scans,         setScans]         = useState<CheckpointScan[]>([]);
  const [scansLoading,  setScansLoading]  = useState(true);
  const [scansError,    setScansError]    = useState('');
  const [scansTruncated, setScansTruncated] = useState(false);
  // Bumped after a confirmed delete so the history reflects the cascade.
  const [scanRefresh,   setScanRefresh]   = useState(0);

  // Client-side range validation — invalid ranges show a message instead of
  // firing a request the API would 400.
  const scanRangeError = useMemo(() => {
    if (!scanFrom || !scanTo) return 'Pick both dates.';
    const from = new Date(scanFrom);
    const to   = new Date(scanTo);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 'Invalid date.';
    if (from > to) return 'FROM must be on or before TO.';
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
      return `Range is limited to ${MAX_RANGE_DAYS} days — narrow the dates.`;
    }
    return '';
  }, [scanFrom, scanTo]);

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

  const loadCheckpoints = useCallback(async () => {
    if (!siteId) return;
    try {
      const rows = await adminGet<Checkpoint[]>(`/api/checkpoints?site_id=${siteId}`);
      setCheckpoints(rows);
      setCpError('');
    } catch (e: any) {
      setCpError(e.message ?? 'Failed to load checkpoints');
    } finally {
      setCpLoading(false);
    }
  }, [siteId]);

  useEffect(() => { loadCheckpoints(); }, [loadCheckpoints]);

  const awaitingCount = useMemo(
    () => checkpoints.filter((c) => c.is_active && !c.linked).length,
    [checkpoints],
  );

  // Gates the anchor-accuracy explainer: only worth showing once at least one
  // row actually displays an anchor accuracy figure.
  const anyAnchored = useMemo(
    () => checkpoints.some((c) => c.linked && Number.isFinite(c.link_accuracy_m)),
    [checkpoints],
  );

  useEffect(() => {
    if (!siteId || scanRangeError) return;
    let cancelled = false;
    (async () => {
      setScansLoading(true);
      try {
        // Whole-day bounds: FROM at 00:00 UTC, TO at end of day.
        const fromIso = `${scanFrom}T00:00:00.000Z`;
        const toIso   = `${scanTo}T23:59:59.999Z`;
        const data = await adminGet<{ scans: CheckpointScan[]; truncated: boolean }>(
          `/api/checkpoints/scans?site_id=${siteId}&from=${fromIso}&to=${toIso}`,
        );
        if (cancelled) return;
        setScans(data.scans);
        setScansTruncated(data.truncated);
        setScansError('');
      } catch (e: any) {
        if (!cancelled) setScansError(e.message ?? 'Failed to load scan history');
      } finally {
        if (!cancelled) setScansLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [siteId, scanFrom, scanTo, scanRangeError, scanRefresh]);

  // C5 — CSV export of exactly the rows on screen. Oldest first,
  // deliberately the reverse of the on-screen DESC order: a patrol log
  // handed to a property manager reads chronologically forward.
  // Timestamps render in the SITE's timezone with the zone abbreviation on
  // every value (not just the header) so rows crossing a DST flip stay
  // unambiguous. Distance is whole meters; the unit lives in the header.
  function exportScansCsv() {
    if (!site || scans.length === 0 || scansTruncated || !!scanRangeError) return;
    const tsFmt = new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: site.timezone, timeZoneName: 'short',
    });
    const header = ['Checkpoint', 'Guard', 'Scanned At', 'Distance (m)'].map(csvField).join(',');
    const rows = [...scans].reverse().map((s) =>
      [
        s.checkpoint_label,
        s.guard_name,
        tsFmt.format(new Date(s.scanned_at)),
        Math.round(s.distance_m),
      ].map(csvField).join(','),
    );
    // BOM so Excel decodes UTF-8 names correctly (this file's whole purpose
    // is being opened in Excel by a property manager).
    const csv = '\uFEFF' + [header, ...rows].join('\r\n') + '\r\n';
    const filename = `checkpoint-scans_${slugify(site.name)}_${scanFrom}_to_${scanTo}.csv`;
    triggerBlobDownload(new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename);
  }

  // ── Checkpoint modal handlers ──────────────────────────────────────────
  function openAddCpModal() {
    setCpModalMode('add');
    setEditingCp(null);
    setCpForm(EMPTY_CP_FORM);
    setCpFormError('');
  }
  function openEditCpModal(cp: Checkpoint) {
    setCpModalMode('edit');
    setEditingCp(cp);
    setCpForm({
      label: cp.label,
      radius_meters: String(cp.radius_meters),
      sort_order: String(cp.sort_order),
      is_active: cp.is_active,
    });
    setCpFormError('');
  }
  function closeCpModal() {
    setCpModalMode(null);
    setEditingCp(null);
    setCpFormError('');
  }

  async function saveCheckpoint() {
    const label = cpForm.label.trim();
    if (label.length < 1 || label.length > 120) {
      setCpFormError('Label is required (1-120 characters).');
      return;
    }
    const radius = Number(cpForm.radius_meters);
    if (!Number.isInteger(radius) || radius < 10 || radius > 500) {
      setCpFormError('Radius must be a whole number between 10 and 500 meters.');
      return;
    }
    setCpSaving(true);
    setCpFormError('');
    try {
      if (cpModalMode === 'add') {
        await adminPost(`/api/checkpoints`, { site_id: siteId, label, radius_meters: radius });
      } else if (editingCp) {
        const sortOrder = Number(cpForm.sort_order);
        if (!Number.isInteger(sortOrder)) {
          setCpFormError('Sort order must be a whole number.');
          setCpSaving(false);
          return;
        }
        // Only the four mutable fields — the API 400s on any link-state key.
        await adminPatch(`/api/checkpoints/${editingCp.id}`, {
          label, radius_meters: radius, sort_order: sortOrder, is_active: cpForm.is_active,
        });
      }
      closeCpModal();
      await loadCheckpoints();
    } catch (e: any) {
      setCpFormError(e.message ?? 'Save failed');
    } finally {
      setCpSaving(false);
    }
  }

  async function toggleCpActive(cp: Checkpoint) {
    setCpToggling(cp.id);
    try {
      await adminPatch(`/api/checkpoints/${cp.id}`, { is_active: !cp.is_active });
      await loadCheckpoints();
      setCpError('');
    } catch (e: any) {
      setCpError(e.message ?? 'Update failed');
    } finally {
      setCpToggling(null);
    }
  }

  async function confirmUnlink() {
    if (!unlinkCp) return;
    setUnlinkBusy(true);
    setUnlinkError('');
    try {
      await adminPost(`/api/checkpoints/${unlinkCp.id}/unlink`, {});
      setUnlinkCp(null);
      await loadCheckpoints();
    } catch (e: any) {
      setUnlinkError(e.message ?? 'Unlink failed');
    } finally {
      setUnlinkBusy(false);
    }
  }

  // Step 1 of the two-step delete: call WITHOUT the confirm param. The API
  // always answers 409 with scan_count; that number drives the modal copy.
  async function beginDelete(cp: Checkpoint) {
    setCpToggling(cp.id);
    setCpError('');
    try {
      const res = await adminFetch(`/api/checkpoints/${cp.id}`, { method: 'DELETE' });
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        setDeleteCp({ cp, scanCount: (body as any).scan_count ?? 0 });
        setDeleteError('');
      } else if (res.ok) {
        await loadCheckpoints(); // future-proofing: API deleted without confirm
      } else {
        const body = await res.json().catch(() => ({}));
        setCpError((body as any).error ?? `Delete failed: ${res.status}`);
      }
    } catch (e: any) {
      setCpError(e.message ?? 'Delete failed');
    } finally {
      setCpToggling(null);
    }
  }

  async function confirmDelete() {
    if (!deleteCp) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      const res = await adminFetch(
        `/api/checkpoints/${deleteCp.cp.id}?confirm=delete_scans`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as any).error ?? `Delete failed: ${res.status}`);
      }
      setDeleteCp(null);
      await loadCheckpoints();
      setScanRefresh((n) => n + 1); // cascade removed this checkpoint's scans
    } catch (e: any) {
      setDeleteError(e.message ?? 'Delete failed');
    } finally {
      setDeleteBusy(false);
    }
  }

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
        // Fix 4: only shifts that haven't started yet — anything already
        // in progress is handled by the GUARD ON SHIFT section above.
        new Date(s.scheduled_start) > now &&
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
        <button
          onClick={() => router.back()}
          className="text-gray-500 hover:text-amber-400 text-xs tracking-widest inline-flex items-center gap-1"
        >
          ← BACK
        </button>
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
        <button
          onClick={() => router.back()}
          className="text-gray-500 hover:text-amber-400 text-xs tracking-widest inline-flex items-center gap-1 mb-2"
        >
          ← BACK
        </button>
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
                      {g.scheduled_start && g.scheduled_end && (
                        <p className="text-gray-500 text-xs mt-0.5 font-mono">
                          Scheduled {fmtTime(g.scheduled_start)} → {fmtTime(g.scheduled_end)}
                        </p>
                      )}
                    </div>
                    <Link
                      href={`/admin/chat?siteId=${siteId}&guardId=${g.id}`}
                      className="text-xs tracking-widest text-amber-400 hover:underline whitespace-nowrap"
                    >
                      CHAT →
                    </Link>
                  </div>
                  <p className="text-gray-400 text-xs shrink-0">{formatHoursHHMM(hoursWorked)}</p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Upcoming shifts (next 7 days, grouped by day) */}
      <section>
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 md:gap-3 mb-3">
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

      {/* Checkpoints (C4a) */}
      <section>
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 md:gap-3 mb-3">
          <h2 className="text-amber-400 font-bold tracking-widest text-sm">CHECKPOINTS</h2>
          <button
            onClick={openAddCpModal}
            className="text-xs text-amber-400 tracking-widest border border-amber-400/40 rounded px-3 py-1.5 hover:bg-amber-400/10 hover:border-amber-400 transition-colors self-start md:self-auto"
          >
            + ADD CHECKPOINT
          </button>
        </div>

        {cpError && (
          <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-3">{cpError}</div>
        )}

        {/* Setup banner — derived from linked flags, no stored state. */}
        {!cpLoading && awaitingCount > 0 && (
          <div className="bg-amber-400/10 border border-amber-400/40 text-amber-300 text-sm rounded-lg px-4 py-3 mb-3">
            {awaitingCount} checkpoint{awaitingCount === 1 ? '' : 's'} awaiting setup. A guard on an
            active shift must scan each physical tag to anchor its location.
          </div>
        )}

        {/* Explains what the per-row anchor accuracy figure means. Section-level,
            not per row — the number is only interpretable alongside the radius
            and the guard's own GPS accuracy. Deliberately uncoloured and
            unbanded: there is no field data yet to say what a bad anchor is. */}
        {!cpLoading && anyAnchored && (
          <p className="text-gray-500 text-xs mb-3">
            A scan is accepted within roughly the radius plus the anchor accuracy plus the
            guard&apos;s own GPS accuracy at that moment — UNLINK a checkpoint to re-anchor it
            on a better fix.
          </p>
        )}

        {cpLoading ? (
          <p className="text-gray-500 text-sm">Loading checkpoints…</p>
        ) : checkpoints.length === 0 ? (
          <div className="space-y-3">
            <p className="text-gray-500 text-sm">
              Checkpoints are physical QR code or barcode tags guards scan on patrol rounds to prove presence.
              Add one here, then a guard on an active shift scans the tag once to anchor its location.
            </p>
            <button
              onClick={openAddCpModal}
              className="text-xs text-amber-400 tracking-widest border border-amber-400/40 rounded px-3 py-1.5 hover:bg-amber-400/10 hover:border-amber-400 transition-colors"
            >
              + ADD CHECKPOINT
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {checkpoints.map((cp) => (
              <div
                key={cp.id}
                className={`bg-[#0F1E35] border border-[#1A3050] rounded-lg px-3 py-2 flex flex-col md:flex-row md:items-center gap-2 md:gap-3 ${!cp.is_active ? 'opacity-60' : ''}`}
              >
                <div className="min-w-0 md:flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-gray-200 font-medium text-sm break-words">{cp.label}</span>
                    {cp.linked ? (
                      <span className="text-[10px] tracking-widest text-green-400 bg-green-400/10 border border-green-400/30 px-1.5 py-0.5 rounded">
                        LINKED
                      </span>
                    ) : (
                      <span className="text-[10px] tracking-widest text-amber-400 bg-amber-400/10 border border-amber-400/30 px-1.5 py-0.5 rounded">
                        AWAITING SETUP
                      </span>
                    )}
                    {!cp.is_active && (
                      <span className="text-[10px] tracking-widest text-red-400 bg-red-400/10 border border-red-400/30 px-1.5 py-0.5 rounded">
                        INACTIVE
                      </span>
                    )}
                  </div>
                  <p className="text-gray-500 text-xs mt-0.5">
                    {cp.radius_meters}m radius
                    {cp.linked && Number.isFinite(cp.link_accuracy_m) && (
                      <>
                        <span className="text-gray-600"> · </span>
                        ±{Math.round(cp.link_accuracy_m as number)}m anchor accuracy
                      </>
                    )}
                    {cp.linked && cp.linked_at && (
                      <>
                        <span className="text-gray-600"> · </span>
                        Anchored {ANCHOR_DATE.format(new Date(cp.linked_at))}
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-3 md:gap-2 md:shrink-0 flex-wrap">
                  <button
                    onClick={() => openEditCpModal(cp)}
                    className="text-xs text-gray-400 hover:text-amber-400 tracking-widest"
                  >
                    EDIT
                  </button>
                  {cp.linked && (
                    <button
                      onClick={() => { setUnlinkCp(cp); setUnlinkError(''); }}
                      className="text-xs text-amber-400 hover:text-amber-300 tracking-widest"
                    >
                      UNLINK
                    </button>
                  )}
                  <button
                    onClick={() => toggleCpActive(cp)}
                    disabled={cpToggling === cp.id}
                    className={`text-xs tracking-widest disabled:opacity-40 ${
                      cp.is_active ? 'text-red-400 hover:text-red-300' : 'text-green-400 hover:text-green-300'
                    }`}
                  >
                    {cpToggling === cp.id ? '…' : cp.is_active ? 'DEACTIVATE' : 'ACTIVATE'}
                  </button>
                  <button
                    onClick={() => beginDelete(cp)}
                    disabled={cpToggling === cp.id}
                    className="text-xs text-red-400 hover:text-red-300 tracking-widest disabled:opacity-40"
                  >
                    DELETE
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Scan history (C4b) */}
      <section>
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 md:gap-3 mb-3">
          <h2 className="text-amber-400 font-bold tracking-widest text-sm">SCAN HISTORY</h2>
          <button
            onClick={exportScansCsv}
            disabled={scans.length === 0 || scansLoading || scansTruncated || !!scanRangeError}
            title={
              scansTruncated
                ? 'Export is disabled while the view is capped at 1000 rows — narrow the date range.'
                : scans.length === 0 ? 'No scans in the current range.' : undefined
            }
            className="text-xs text-amber-400 tracking-widest border border-amber-400/40 rounded px-3 py-1.5 hover:bg-amber-400/10 hover:border-amber-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:border-amber-400/40 self-start md:self-auto"
          >
            EXPORT CSV
          </button>
        </div>

        {/* Date range — billing-page pattern: paired native date inputs. */}
        <div className="flex flex-wrap gap-4 mb-3">
          <div>
            <label className="block text-gray-500 text-xs tracking-widest mb-1">FROM</label>
            <input
              type="date" value={scanFrom} onChange={(e) => setScanFrom(e.target.value)}
              className="bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
            />
          </div>
          <div>
            <label className="block text-gray-500 text-xs tracking-widest mb-1">TO</label>
            <input
              type="date" value={scanTo} onChange={(e) => setScanTo(e.target.value)}
              className="bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
            />
          </div>
        </div>

        {scanRangeError && (
          <div className="bg-amber-400/10 border border-amber-400/40 text-amber-300 text-sm rounded-lg px-4 py-2 mb-3">
            {scanRangeError}
          </div>
        )}
        {scansError && (
          <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-3">{scansError}</div>
        )}
        {scansTruncated && (
          <div className="bg-amber-400/10 border border-amber-400/40 text-amber-300 text-sm rounded-lg px-4 py-2 mb-3">
            Showing the first 1000 scans in this range — narrow the dates to see the rest.
            CSV export is disabled while the view is capped, so a partial file is never
            handed off as a complete log.
          </div>
        )}

        {scansLoading && !scanRangeError ? (
          <p className="text-gray-500 text-sm">Loading scan history…</p>
        ) : !scanRangeError && scans.length === 0 ? (
          <p className="text-gray-500 text-sm">
            {checkpoints.length === 0
              ? 'This site has no checkpoints yet — history will appear once checkpoints are set up and scanned.'
              : 'No scans in this range.'}
          </p>
        ) : !scanRangeError && (
          <>
            {/* Desktop (md+): table. distance_m gets its own column — the
                anti-fraud signal. Plain number, no thresholds: there is no
                data yet to justify one. */}
            <div className="hidden md:block overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 text-xs tracking-widest border-b border-[#1A3050]">
                    <th className="py-2 pr-4 font-normal">CHECKPOINT</th>
                    <th className="py-2 pr-4 font-normal">GUARD</th>
                    <th className="py-2 pr-4 font-normal">SCANNED AT</th>
                    <th className="py-2 font-normal">DISTANCE (M)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1A3050]">
                  {scans.map((s) => (
                    <tr key={s.id}>
                      <td className="py-2.5 pr-4 text-gray-200">{s.checkpoint_label}</td>
                      <td className="py-2.5 pr-4 text-gray-300">{s.guard_name}</td>
                      <td className="py-2.5 pr-4 text-gray-400 font-mono text-xs">
                        {SCAN_TS.format(new Date(s.scanned_at))}
                      </td>
                      <td className="py-2.5 text-gray-300 font-mono text-xs">{Math.round(s.distance_m)} m</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile (<md): cards, per docs/mobile-responsive.md. */}
            <div className="md:hidden space-y-2">
              {scans.map((s) => (
                <div key={s.id} className="bg-[#0F1E35] border border-[#1A3050] rounded-lg px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-gray-200 text-sm font-medium break-words min-w-0">{s.checkpoint_label}</span>
                    <span className="text-gray-300 font-mono text-xs shrink-0">{Math.round(s.distance_m)} m</span>
                  </div>
                  <p className="text-gray-500 text-xs mt-0.5">
                    {s.guard_name}
                    <span className="text-gray-600"> · </span>
                    <span className="font-mono">{SCAN_TS.format(new Date(s.scanned_at))}</span>
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {/* ADD / EDIT checkpoint modal */}
      {cpModalMode !== null && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60">
          <div className="w-full sm:max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-t-2xl sm:rounded-2xl p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">
                {cpModalMode === 'add' ? 'ADD CHECKPOINT' : 'EDIT CHECKPOINT'}
              </h2>
              <button onClick={closeCpModal} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            {cpFormError && (
              <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{cpFormError}</div>
            )}
            <div className="space-y-4">
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">
                  LABEL <span className="text-amber-400">*</span>
                </label>
                <input
                  type="text" placeholder="e.g. North Gate"
                  value={cpForm.label}
                  onChange={(e) => setCpForm((f) => ({ ...f, label: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                />
              </div>
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">RADIUS (METERS)</label>
                <input
                  type="number" min={10} max={500}
                  value={cpForm.radius_meters}
                  onChange={(e) => setCpForm((f) => ({ ...f, radius_meters: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                />
                <p className="text-gray-600 text-[10px] mt-1">
                  How close a guard must be for a scan to count. 10–500, default 50.
                </p>
              </div>
              {cpModalMode === 'edit' && (
                <>
                  <div>
                    <label className="block text-gray-500 text-xs tracking-widest mb-1">SORT ORDER</label>
                    <input
                      type="number"
                      value={cpForm.sort_order}
                      onChange={(e) => setCpForm((f) => ({ ...f, sort_order: e.target.value }))}
                      className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                    />
                    <p className="text-gray-600 text-[10px] mt-1">Display position in lists. Lower numbers first.</p>
                  </div>
                  <label className="flex items-center gap-2 text-gray-300 text-sm">
                    <input
                      type="checkbox"
                      checked={cpForm.is_active}
                      onChange={(e) => setCpForm((f) => ({ ...f, is_active: e.target.checked }))}
                      className="accent-amber-400"
                    />
                    Active
                  </label>
                </>
              )}
              {cpModalMode === 'add' && (
                <p className="text-gray-500 text-xs">
                  You never enter a code or coordinates here. After adding the checkpoint, a guard on
                  an active shift scans the physical tag once — that scan anchors its code and location.
                </p>
              )}
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={closeCpModal}
                className="flex-1 bg-[#0B1526] border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors"
              >
                CANCEL
              </button>
              <button
                onClick={saveCheckpoint}
                disabled={cpSaving}
                className="flex-1 bg-amber-400 text-[#0B1526] font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 transition-colors disabled:opacity-50"
              >
                {cpSaving ? 'SAVING…' : cpModalMode === 'add' ? 'ADD' : 'SAVE'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* UNLINK confirm modal */}
      {unlinkCp && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60">
          <div className="w-full sm:max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-t-2xl sm:rounded-2xl p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">UNLINK CHECKPOINT</h2>
              <button onClick={() => setUnlinkCp(null)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            {unlinkError && (
              <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{unlinkError}</div>
            )}
            <p className="text-gray-300 text-sm mb-2">
              Unlink <span className="text-gray-100 font-medium">{unlinkCp.label}</span>?
            </p>
            <p className="text-gray-500 text-xs mb-6">
              This clears the tag and its anchored location so a guard can re-scan it at the correct
              position. Past scans are kept — they remain valid history.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setUnlinkCp(null)}
                className="flex-1 bg-[#0B1526] border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors"
              >
                CANCEL
              </button>
              <button
                onClick={confirmUnlink}
                disabled={unlinkBusy}
                className="flex-1 bg-amber-400 text-[#0B1526] font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 transition-colors disabled:opacity-50"
              >
                {unlinkBusy ? 'UNLINKING…' : 'UNLINK'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DELETE confirm modal — copy depends on the 409's scan_count */}
      {deleteCp && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60">
          <div className="w-full sm:max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-t-2xl sm:rounded-2xl p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-red-400 font-bold tracking-widest text-lg">DELETE CHECKPOINT</h2>
              <button onClick={() => setDeleteCp(null)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            {deleteError && (
              <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{deleteError}</div>
            )}
            <p className="text-gray-300 text-sm mb-2">
              Delete <span className="text-gray-100 font-medium">{deleteCp.cp.label}</span>?
            </p>
            {deleteCp.scanCount > 0 ? (
              <p className="text-red-300 text-xs mb-6">
                This permanently destroys {deleteCp.scanCount} scan record{deleteCp.scanCount === 1 ? '' : 's'} for
                this checkpoint. If you only want to retire it, use DEACTIVATE instead — that keeps
                the scan history.
              </p>
            ) : (
              <p className="text-gray-500 text-xs mb-6">
                This checkpoint has no scans. Deleting it cannot be undone.
              </p>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteCp(null)}
                className="flex-1 bg-[#0B1526] border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors"
              >
                CANCEL
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleteBusy}
                className="flex-1 bg-red-500/90 text-white font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-red-500 transition-colors disabled:opacity-50"
              >
                {deleteBusy ? 'DELETING…' : deleteCp.scanCount > 0 ? `DELETE ${deleteCp.scanCount} SCANS` : 'DELETE'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
