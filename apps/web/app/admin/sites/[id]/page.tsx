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
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { adminFetch, adminGet, adminPatch, adminPost, triggerBlobDownload } from '../../../../lib/adminApi';
import { fmtTime } from '../../../../lib/shiftFormat';
import { formatHoursHHMM } from '../../../../lib/formatHours';

interface Site {
  id:       string;
  name:     string;
  address:  string;
  timezone: string;   // IANA zone (sites.timezone, NOT NULL) — CSV timestamps render in it
  // schema_v47 site toggles. checkpoints_enabled gates the guard QR
  // scanner; vehicle_inspection_required prompts (never blocks) a
  // post-clock-in inspection.
  checkpoints_enabled:         boolean;
  vehicle_inspection_required: boolean;
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
  // The round this scan belongs to: the site-local hour floor stored as a
  // UTC instant (schema_v44). Already on every row the API returns — the
  // /scans handler selects `cs.*` — this client just never read it before.
  round_window:     string;
}

/** One hourly round: its scans plus completeness against the CURRENT roster. */
interface Round {
  key:       string;   // normalized round_window ISO — the group key
  label:     string;   // "Aug 4, 5-6 PM", rendered in the site's zone
  scans:     CheckpointScan[];  // chronologically forward within the round
  scanned:   number;   // distinct currently-active+linked checkpoints scanned
  expected:  number;   // count of currently-active+linked checkpoints
  missing:   string[]; // labels of active+linked checkpoints with no scan
}

const EMPTY_CP_FORM = { label: '', radius_meters: '50', sort_order: '0', is_active: true };

// Vehicle roster (schema_v48) — per-site patrol vehicles for inspections.
interface Vehicle {
  id:            string;
  site_id:       string;
  label:         string;
  plate:         string | null;
  make_model:    string | null;
  odometer_unit: 'mi' | 'km';
  is_active:     boolean;
  created_at:    string;
}

const EMPTY_VEHICLE_FORM = { label: '', plate: '', make_model: '', odometer_unit: 'mi' as 'mi' | 'km' };

const ANCHOR_DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles',
});

/**
 * Scan timestamps render in the SITE's zone, built per site rather than fixed
 * at module scope.
 *
 * This column was previously pinned to America/Los_Angeles like the page's
 * other formatters. Round grouping makes that untenable: the round header is
 * necessarily site-local, so a Pacific scan time under it reads as a flat
 * contradiction — a Kolkata round labelled "5-6 PM" listing a scan at "04:39".
 * exportScansCsv() already formatted in site.timezone, so this brings the table
 * into line with the file it exports rather than inventing a new convention.
 */
function makeScanTsFormat(timeZone: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone,
  });
}

const ROUND_MS = 60 * 60 * 1000;

/**
 * Builds a round labeller for one site: "Aug 4, 5-6 PM".
 *
 * round_window is the site-local hour floor stored as its UTC instant, and a
 * round is [w, w + 1h). Both ends are rendered in the SITE's zone, never the
 * browser's — an admin in New York reading a Phoenix site must see Phoenix
 * hours or the log means nothing.
 *
 * NOTE: the schema_v44 DDL comment describes round_window as an
 * America/Los_Angeles floor. That comment is stale — the API computes it with
 * `AT TIME ZONE s.timezone` per site (ROUND_WINDOW_SQL in routes/checkpoints.ts),
 * so it is genuinely per-site and hardcoding Pacific here would be wrong.
 *
 * The meridiem is printed once when both ends share it ("5-6 PM") and on both
 * ends when they differ ("11 AM-12 PM"). The date is always the round's START
 * date, so a 11 PM-12 AM round stays filed under the day it began.
 */
function makeRoundLabeller(timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', hour12: true, timeZone,
  });
  const partsOf = (d: Date) => {
    const parts = fmt.formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return { month: get('month'), day: get('day'), hour: get('hour'), period: get('dayPeriod') };
  };
  return (windowStartIso: string): string => {
    const start = new Date(windowStartIso);
    if (Number.isNaN(start.getTime())) return 'Unknown round';
    const s = partsOf(start);
    const e = partsOf(new Date(start.getTime() + ROUND_MS));
    const startHour = s.period === e.period ? s.hour : `${s.hour} ${s.period}`;
    return `${s.month} ${s.day}, ${startHour}-${e.hour} ${e.period}`;
  };
}

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

/** "3 of 5" for a round. Green when the round is whole, amber when it isn't —
 *  the same LINKED / AWAITING SETUP colour language the checkpoint list uses. */
function RoundCount({ scanned, expected }: { scanned: number; expected: number }) {
  const complete = expected > 0 && scanned >= expected;
  return (
    <span
      title="Measured against the current checkpoint list, not the list as it stood during this round."
      className={
        'text-[10px] tracking-widest px-1.5 py-0.5 rounded border shrink-0 ' +
        (complete
          ? 'text-green-400 bg-green-400/10 border-green-400/30'
          : 'text-amber-400 bg-amber-400/10 border-amber-400/30')
      }
    >
      {scanned} OF {expected}
    </span>
  );
}

/** Marks a scan whose checkpoint has since been deactivated or unlinked. The
 *  row still counts as history but not toward the round's numerator, so
 *  without this tag "3 rows but 2 of 5" would look like an arithmetic bug. */
function NotInRosterTag() {
  return (
    <span
      title="This checkpoint is no longer active and linked, so it is not counted in this round's total."
      className="ml-2 text-[10px] tracking-widest text-gray-500 border border-gray-600 px-1.5 py-0.5 rounded whitespace-nowrap"
    >
      NOT IN CURRENT LIST
    </span>
  );
}

/**
 * Tab model. State lives in `?tab=`, never in React state, so a tab is a
 * shareable URL and Back works — the same contract as /admin/shifts?view=.
 * An unknown or absent slug falls back to `overview` rather than rendering
 * an empty page.
 */
const TABS = [
  ['overview',     'OVERVIEW'],
  ['checkpoints',  'CHECKPOINTS'],
  ['schedule',     'SCHEDULE'],
  ['scan-history', 'SCAN HISTORY'],
] as const;

type TabSlug = (typeof TABS)[number][0];

/**
 * useSearchParams() opts the subtree into client-side rendering, which Next 14
 * rejects at build time unless a Suspense boundary sits above it. Same wrapper
 * the shifts page uses for the same reason.
 */
export default function SiteDetailPage() {
  return (
    <Suspense fallback={<div className="p-10 text-center text-gray-500 text-sm">Loading site…</div>}>
      <SiteDetailPageInner />
    </Suspense>
  );
}

function SiteDetailPageInner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const siteId = params?.id ?? '';

  // ── Tab routing (?tab=) ────────────────────────────────────────────────
  // Read-only derivation: no useState, no effect. Every other searchParam is
  // carried through tabHref() so the scan-history date range (and any future
  // filter) survives a tab switch.
  const searchParams = useSearchParams();
  const tabParam = searchParams?.get('tab') ?? '';
  const tab: TabSlug = (TABS.some(([slug]) => slug === tabParam) ? tabParam : 'overview') as TabSlug;

  function tabHref(slug: TabSlug): string {
    const p = new URLSearchParams(searchParams?.toString() ?? '');
    p.set('tab', slug);
    return `/admin/sites/${siteId}?${p.toString()}`;
  }

  const [site,    setSite]    = useState<Site | null>(null);
  const [guards,  setGuards]  = useState<LiveGuard[]>([]);
  const [shifts,  setShifts]  = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  // ── Site toggles (schema_v47) ──────────────────────────────────────────
  // Which flag has a PATCH in flight ('' = none). Optimistic UI would hide
  // a failed write behind a lie — instead the switch disables while saving
  // and re-renders from the server's RETURNING row.
  const [toggleSaving, setToggleSaving] = useState<'' | 'checkpoints_enabled' | 'vehicle_inspection_required'>('');
  const [toggleError,  setToggleError]  = useState('');

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

  // ── Vehicle roster (schema_v48) ────────────────────────────────────────
  const [vehicles,        setVehicles]        = useState<Vehicle[]>([]);
  const [vehLoading,      setVehLoading]      = useState(true);
  const [vehError,        setVehError]        = useState('');
  const [vehModalMode,    setVehModalMode]    = useState<'add' | 'edit' | null>(null);
  const [editingVeh,      setEditingVeh]      = useState<Vehicle | null>(null);
  const [vehForm,         setVehForm]         = useState(EMPTY_VEHICLE_FORM);
  const [vehSaving,       setVehSaving]       = useState(false);
  const [vehFormError,    setVehFormError]    = useState('');
  const [vehToggling,     setVehToggling]     = useState<string | null>(null);

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

  const loadVehicles = useCallback(async () => {
    if (!siteId) return;
    try {
      const rows = await adminGet<Vehicle[]>(`/api/vehicles?site_id=${siteId}`);
      setVehicles(rows);
      setVehError('');
    } catch (e: any) {
      setVehError(e.message ?? 'Failed to load vehicles');
    } finally {
      setVehLoading(false);
    }
  }, [siteId]);

  useEffect(() => { loadVehicles(); }, [loadVehicles]);

  function openAddVehicleModal() {
    setVehForm(EMPTY_VEHICLE_FORM);
    setEditingVeh(null);
    setVehFormError('');
    setVehModalMode('add');
  }

  function openEditVehicleModal(v: Vehicle) {
    setVehForm({ label: v.label, plate: v.plate ?? '', make_model: v.make_model ?? '', odometer_unit: v.odometer_unit });
    setEditingVeh(v);
    setVehFormError('');
    setVehModalMode('edit');
  }

  function closeVehicleModal() {
    setVehModalMode(null);
    setEditingVeh(null);
  }

  async function saveVehicle() {
    const label = vehForm.label.trim();
    if (label.length < 1 || label.length > 120) {
      setVehFormError('Label is required (1-120 characters).');
      return;
    }
    if (vehForm.plate.trim().length > 20) {
      setVehFormError('Plate must be at most 20 characters.');
      return;
    }
    setVehSaving(true);
    setVehFormError('');
    try {
      const payload = {
        label,
        plate:         vehForm.plate.trim() || null,
        make_model:    vehForm.make_model.trim() || null,
        odometer_unit: vehForm.odometer_unit,
      };
      if (vehModalMode === 'add') {
        await adminPost(`/api/vehicles`, { ...payload, site_id: siteId });
      } else if (editingVeh) {
        await adminPatch(`/api/vehicles/${editingVeh.id}`, payload);
      }
      closeVehicleModal();
      await loadVehicles();
    } catch (e: any) {
      setVehFormError(e.message ?? 'Failed to save vehicle');
    } finally {
      setVehSaving(false);
    }
  }

  async function toggleVehicleActive(v: Vehicle) {
    setVehToggling(v.id);
    try {
      await adminPatch(`/api/vehicles/${v.id}`, { is_active: !v.is_active });
      await loadVehicles();
    } catch (e: any) {
      setVehError(e.message ?? 'Failed to update vehicle');
    } finally {
      setVehToggling(null);
    }
  }

  async function saveToggle(flag: 'checkpoints_enabled' | 'vehicle_inspection_required', value: boolean) {
    if (!site || toggleSaving) return;
    setToggleSaving(flag);
    setToggleError('');
    try {
      const updated = await adminPatch<{ id: string; checkpoints_enabled: boolean; vehicle_inspection_required: boolean }>(
        `/api/sites/${siteId}/toggles`, { [flag]: value },
      );
      setSite((s) => (s ? { ...s, checkpoints_enabled: updated.checkpoints_enabled, vehicle_inspection_required: updated.vehicle_inspection_required } : s));
    } catch (e: any) {
      setToggleError(e.message ?? 'Failed to save setting');
    } finally {
      setToggleSaving('');
    }
  }

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

  // ── Round grouping (C7) ────────────────────────────────────────────────
  // The scannable set, using the SERVER's own definition from windowCounter
  // in routes/checkpoints.ts: `is_active = true AND code_value IS NOT NULL`.
  // `linked` is exactly `(code_value IS NOT NULL)` as computed by GET
  // /api/checkpoints, so this is the same set, not a second definition.
  const activeLinked = useMemo(
    () => checkpoints.filter((c) => c.is_active && c.linked),
    [checkpoints],
  );

  const activeLinkedIds = useMemo(
    () => new Set(activeLinked.map((c) => c.id)),
    [activeLinked],
  );

  // Falls back to Pacific only while `site` is still loading; every rendered
  // row uses the real zone because the scan table renders under `site`.
  const scanTs = useMemo(
    () => makeScanTsFormat(site?.timezone ?? 'America/Los_Angeles'),
    [site?.timezone],
  );

  // Scans grouped into rounds, newest round first; scans within a round run
  // chronologically forward (the API hands them back DESC).
  //
  // Completeness is measured against the CURRENT roster — see the explainer
  // rendered above the table. `scanned` counts only checkpoints still in that
  // roster, matching windowCounter's `sc2.is_active = true` filter: if a scan
  // of a since-removed checkpoint counted toward a denominator built from the
  // current list, a round could read "6 of 5". Those scans still render as
  // rows (history stays visible) and are flagged inline so the arithmetic is
  // legible rather than mysterious.
  //
  // Rounds with zero scans cannot appear here — there is no row to group.
  // Surfacing them needs session-window enumeration in the API and is
  // deliberately out of scope for this commit.
  const rounds = useMemo<Round[]>(() => {
    if (scans.length === 0 || !site) return [];
    const labelFor = makeRoundLabeller(site.timezone);

    const byWindow = new Map<string, CheckpointScan[]>();
    for (const s of scans) {
      // Normalize through Date so any serialization drift in round_window
      // can't split one round across two groups.
      const parsed = new Date(s.round_window);
      const key = Number.isNaN(parsed.getTime()) ? String(s.round_window) : parsed.toISOString();
      const bucket = byWindow.get(key);
      if (bucket) bucket.push(s);
      else byWindow.set(key, [s]);
    }

    // Array.from, not spread: this tsconfig targets below ES2015, where
    // spreading a Map iterator needs --downlevelIteration.
    return Array.from(byWindow.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))   // newest round first
      .map(([key, group]) => {
        const ordered = [...group].sort(
          (a, b) => new Date(a.scanned_at).getTime() - new Date(b.scanned_at).getTime(),
        );
        const hitIds = new Set(
          ordered.map((s) => s.checkpoint_id).filter((id) => activeLinkedIds.has(id)),
        );
        return {
          key,
          label:    labelFor(key),
          scans:    ordered,
          scanned:  hitIds.size,
          expected: activeLinked.length,
          missing:  activeLinked.filter((c) => !hitIds.has(c.id)).map((c) => c.label),
        };
      });
  }, [scans, site, activeLinked, activeLinkedIds]);

  // C5/C7 — CSV export of exactly the rows on screen. Oldest first,
  // deliberately the reverse of the on-screen DESC order: a patrol log
  // handed to a property manager reads chronologically forward.
  // Timestamps render in the SITE's timezone with the zone abbreviation on
  // every value (not just the header) so rows crossing a DST flip stay
  // unambiguous. Distance is whole meters; the unit lives in the header.
  //
  // C7: one row per scan, with the round label repeated on every row of its
  // round. Repetition is deliberate — Excel sorts and filters a flat column
  // correctly, whereas a label printed once per group breaks the moment
  // anyone re-sorts the sheet.
  function exportScansCsv() {
    if (!site || scans.length === 0 || scansTruncated || !!scanRangeError) return;
    const tsFmt = new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: site.timezone, timeZoneName: 'short',
    });
    const header = ['Round', 'Checkpoint', 'Guard', 'Scanned At', 'Distance (m)'].map(csvField).join(',');
    // `rounds` is newest-first for the screen; the file reads oldest-first.
    // Scans are already chronological within each round.
    const rows = [...rounds].reverse().flatMap((r) =>
      r.scans.map((s) =>
        [
          r.label,
          s.checkpoint_label,
          s.guard_name,
          tsFmt.format(new Date(s.scanned_at)),
          Math.round(s.distance_m),
        ].map(csvField).join(','),
      ),
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

  // Toggle row (schema_v47) — same JSX as before the nesting move, extracted
  // so both rows share one copy. The gated feature block renders directly
  // beneath its row, inside SITE SETTINGS.
  function renderToggleRow(
    flag: 'checkpoints_enabled' | 'vehicle_inspection_required',
    label: string,
    desc: string,
    value: boolean,
  ) {
    return (
      <div className="flex items-center justify-between gap-3 pb-3">
        <div className="min-w-0">
          <p className="text-gray-200 text-sm tracking-wider">{label}</p>
          <p className="text-gray-500 text-xs mt-0.5">{desc}</p>
        </div>
        <button
          role="switch"
          aria-checked={value}
          aria-label={label}
          disabled={toggleSaving !== ''}
          onClick={() => saveToggle(flag, !value)}
          className={`relative shrink-0 w-12 h-6 rounded-full transition-colors border ${
            value ? 'bg-amber-400/80 border-amber-400' : 'bg-[#0F1E35] border-[#1A3050]'
          } ${toggleSaving === flag ? 'opacity-50' : ''} disabled:cursor-not-allowed`}
        >
          <span
            className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white transition-all ${
              value ? 'left-[26px]' : 'left-0.5'
            }`}
          />
        </button>
      </div>
    );
  }

  // Upcoming shifts (next 7 days, grouped by day). Extracted verbatim — the
  // tab split assigns this section to BOTH Overview and Schedule, so it is
  // rendered from one definition rather than duplicated. Same idiom as
  // renderToggleRow above.
  function renderUpcomingShifts() {
    return (
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
      {/* Tab bar. <Link replace scroll={false}> — replace so a tab switch does
          not stack history entries between the site list and this page, and
          scroll={false} so switching tabs holds position instead of jumping to
          the top. Anchors, not buttons: middle-click and copy-link work. */}
      <nav aria-label="Site sections" className="border-b border-[#1A3050] -mt-2">
        <ul className="flex gap-1 overflow-x-auto">
          {TABS.map(([slug, label]) => {
            const active = tab === slug;
            return (
              <li key={slug}>
                <Link
                  href={tabHref(slug)}
                  replace
                  scroll={false}
                  aria-current={active ? 'page' : undefined}
                  className={`block whitespace-nowrap px-3 md:px-4 py-2.5 text-xs tracking-widest border-b-2 -mb-px transition-colors ${
                    active
                      ? 'border-amber-400 text-amber-400 font-bold'
                      : 'border-transparent text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* OVERVIEW — live state first: who is on post now, what is scheduled next. */}
      {tab === 'overview' && (
      <>
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

      {renderUpcomingShifts()}
      </>
      )}

      {/* CHECKPOINTS — SITE SETTINGS moves here whole: both toggles and the two rosters nested under them. */}
      {tab === 'checkpoints' && (
      <>
      {/* Site settings — schema_v47 feature toggles */}
      <section>
        <h2 className="text-amber-400 font-bold tracking-widest text-sm mb-3">SITE SETTINGS</h2>
        {toggleError && (
          <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-3">{toggleError}</div>
        )}
        <div className="border-y border-[#1A3050] divide-y divide-[#1A3050]">
          <div className="py-3">
            {renderToggleRow('checkpoints_enabled', 'CHECKPOINT SCANNING',
              'Guards see the QR scanner and hourly patrol rounds at this site.',
              site.checkpoints_enabled)}
      {/* Checkpoints (C4a) — nested under its toggle; DISPLAY-gated on
          checkpoints_enabled (schema_v47). Purely presentational: rows stay
          in the DB and in this component's state (loadCheckpoints still
          runs), so flipping the toggle back shows the same roster intact,
          no reload. SCAN HISTORY (its own section below) is deliberately
          NOT gated — audit evidence. */}
      {site.checkpoints_enabled && (
      <div className="ml-1 mb-3 pl-3 md:pl-4 border-l-2 border-[#1A3050]">
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
      </div>
      )}
          </div>
          <div className="py-3">
            {renderToggleRow('vehicle_inspection_required', 'VEHICLE INSPECTION',
              'Guards are prompted (not blocked) to complete a vehicle inspection after clock-in.',
              site.vehicle_inspection_required)}
      {/* Vehicle roster (schema_v48) — nested under its toggle; DISPLAY-
          gated on vehicle_inspection_required, same non-destructive
          semantics as the checkpoints gate above. */}
      {site.vehicle_inspection_required && (
      <div className="ml-1 mb-3 pl-3 md:pl-4 border-l-2 border-[#1A3050]">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 md:gap-3 mb-3">
          <h2 className="text-amber-400 font-bold tracking-widest text-sm">VEHICLES</h2>
          <button
            onClick={openAddVehicleModal}
            className="text-xs text-amber-400 tracking-widest border border-amber-400/40 rounded px-3 py-1.5 hover:bg-amber-400/10 hover:border-amber-400 transition-colors self-start md:self-auto"
          >
            + ADD VEHICLE
          </button>
        </div>

        {vehError && (
          <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-3">{vehError}</div>
        )}

        {vehLoading ? (
          <p className="text-gray-500 text-sm">Loading vehicles…</p>
        ) : vehicles.length === 0 ? (
          <p className="text-gray-500 text-sm">
            No vehicles yet. Add the site&apos;s patrol vehicles so guards can select one for their inspection.
          </p>
        ) : (
          <div className="space-y-2">
            {vehicles.map((v) => (
              <div
                key={v.id}
                className={`bg-[#0F1E35] border border-[#1A3050] rounded-lg px-3 py-2 flex flex-col md:flex-row md:items-center gap-2 md:gap-3 ${!v.is_active ? 'opacity-60' : ''}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-gray-200 text-sm">
                    {v.label}
                    {!v.is_active && (
                      <span className="ml-2 text-[9px] tracking-widest font-bold px-1.5 py-0.5 rounded bg-gray-700/40 text-gray-400 border border-gray-600/40">
                        RETIRED
                      </span>
                    )}
                  </p>
                  <p className="text-gray-500 text-xs mt-0.5">
                    {v.plate ? <span className="font-mono">{v.plate}</span> : 'No plate'}
                    {v.make_model ? ` · ${v.make_model}` : ''}
                    {` · odometer in ${v.odometer_unit}`}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={() => openEditVehicleModal(v)}
                    className="text-xs tracking-widest text-amber-400 hover:underline"
                  >
                    EDIT
                  </button>
                  <button
                    onClick={() => toggleVehicleActive(v)}
                    disabled={vehToggling === v.id}
                    className={`text-xs tracking-widest hover:underline ${
                      v.is_active ? 'text-red-400 hover:text-red-300' : 'text-green-400 hover:text-green-300'
                    }`}
                  >
                    {vehToggling === v.id ? '…' : v.is_active ? 'RETIRE' : 'REACTIVATE'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      )}
          </div>
        </div>
      </section>
      </>
      )}

      {/* SCHEDULE — the MANAGE SCHEDULE entry point lives in this section's header. */}
      {tab === 'schedule' && renderUpcomingShifts()}

      {/* SCAN HISTORY — ungated on checkpoints_enabled, as before. */}
      {tab === 'scan-history' && (
      <>
      {/* Scan history (C4b) — NOT gated on checkpoints_enabled, on purpose:
          scans are audit evidence; turning the feature off must never hide
          what it already recorded. */}
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
            {/* The honesty note. Completeness is derived from the roster as it
                stands right now, not as it stood during the round — say so
                plainly rather than letting "3 of 5" imply a historical
                guarantee the data cannot support. Roster snapshotting is
                deferred Phase 2 work. */}
            <p className="text-gray-500 text-xs mb-3 leading-relaxed">
              Counts are measured against the <span className="text-gray-400">current checkpoint list</span>
              {' '}({activeLinked.length} active and linked). A checkpoint added, deactivated
              or unlinked later changes what past rounds appear to have missed.
            </p>

            {/* Desktop (md+): one tbody per round, each opened by a header row.
                distance_m keeps its own column — the anti-fraud signal. Plain
                number, no thresholds: there is no data yet to justify one. */}
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
                {rounds.map((r) => (
                  <tbody key={r.key} className="divide-y divide-[#1A3050]">
                    <tr>
                      <td colSpan={4} className="pt-4 pb-2">
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <span className="text-amber-400 font-bold tracking-widest text-xs">{r.label}</span>
                          <RoundCount scanned={r.scanned} expected={r.expected} />
                          {r.missing.length > 0 && (
                            <span className="text-gray-500 text-xs min-w-0 break-words">
                              Not scanned: <span className="text-gray-400">{r.missing.join(', ')}</span>
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {r.scans.map((s) => (
                      <tr key={s.id}>
                        <td className="py-2.5 pr-4 text-gray-200">
                          {s.checkpoint_label}
                          {!activeLinkedIds.has(s.checkpoint_id) && <NotInRosterTag />}
                        </td>
                        <td className="py-2.5 pr-4 text-gray-300">{s.guard_name}</td>
                        <td className="py-2.5 pr-4 text-gray-400 font-mono text-xs">
                          {scanTs.format(new Date(s.scanned_at))}
                        </td>
                        <td className="py-2.5 text-gray-300 font-mono text-xs">{Math.round(s.distance_m)} m</td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>

            {/* Mobile (<md): cards, per docs/mobile-responsive.md. At 375px the
                round header stacks — label on its own line, count beneath it,
                missing checkpoints wrapping below — so nothing is squeezed into
                a shared row and truncated. The header is a filled bar rather
                than a text line so the group boundary survives scrolling. */}
            <div className="md:hidden space-y-4">
              {rounds.map((r) => (
                <div key={r.key}>
                  <div className="bg-[#0F1E35] border border-[#1A3050] rounded-lg px-3 py-2 mb-2">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-amber-400 font-bold tracking-widest text-xs break-words min-w-0">
                        {r.label}
                      </span>
                      <RoundCount scanned={r.scanned} expected={r.expected} />
                    </div>
                    {r.missing.length > 0 && (
                      <p className="text-gray-500 text-xs mt-1 break-words">
                        Not scanned: <span className="text-gray-400">{r.missing.join(', ')}</span>
                      </p>
                    )}
                  </div>
                  <div className="space-y-2 pl-2 border-l border-[#1A3050]">
                    {r.scans.map((s) => (
                      <div key={s.id} className="bg-[#0F1E35] border border-[#1A3050] rounded-lg px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-gray-200 text-sm font-medium break-words min-w-0">
                            {s.checkpoint_label}
                            {!activeLinkedIds.has(s.checkpoint_id) && <NotInRosterTag />}
                          </span>
                          <span className="text-gray-300 font-mono text-xs shrink-0">{Math.round(s.distance_m)} m</span>
                        </div>
                        <p className="text-gray-500 text-xs mt-0.5">
                          {s.guard_name}
                          <span className="text-gray-600"> · </span>
                          <span className="font-mono">{scanTs.format(new Date(s.scanned_at))}</span>
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
      </>
      )}

      {/* Modals stay mounted on every tab: they are opened from the
          Checkpoints tab but must survive a re-render without being
          torn out of the tree mid-flight. */}
      {/* ADD / EDIT vehicle modal */}
      {vehModalMode !== null && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60">
          <div className="w-full sm:max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-t-2xl sm:rounded-2xl p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">
                {vehModalMode === 'add' ? 'ADD VEHICLE' : 'EDIT VEHICLE'}
              </h2>
              <button onClick={closeVehicleModal} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            {vehFormError && (
              <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{vehFormError}</div>
            )}
            <div className="space-y-4">
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">
                  LABEL <span className="text-amber-400">*</span>
                </label>
                <input
                  type="text" placeholder="e.g. Patrol Car 1"
                  value={vehForm.label}
                  onChange={(e) => setVehForm((f) => ({ ...f, label: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                />
              </div>
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">PLATE</label>
                <input
                  type="text" placeholder="e.g. 8ABC123"
                  value={vehForm.plate}
                  onChange={(e) => setVehForm((f) => ({ ...f, plate: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                />
                <p className="text-gray-600 text-[10px] mt-1">
                  Leave blank for unplated vehicles (golf carts, ATVs).
                </p>
              </div>
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">MAKE / MODEL</label>
                <input
                  type="text" placeholder="e.g. White Ford Explorer"
                  value={vehForm.make_model}
                  onChange={(e) => setVehForm((f) => ({ ...f, make_model: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                />
              </div>
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">ODOMETER UNIT</label>
                <select
                  value={vehForm.odometer_unit}
                  onChange={(e) => setVehForm((f) => ({ ...f, odometer_unit: e.target.value as 'mi' | 'km' }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                >
                  <option value="mi">Miles (mi)</option>
                  <option value="km">Kilometers (km)</option>
                </select>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={closeVehicleModal}
                className="flex-1 bg-[#0B1526] border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors"
              >
                CANCEL
              </button>
              <button
                onClick={saveVehicle}
                disabled={vehSaving}
                className="flex-1 bg-amber-400 text-[#0B1526] font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 transition-colors disabled:opacity-50"
              >
                {vehSaving ? 'SAVING…' : vehModalMode === 'add' ? 'ADD' : 'SAVE'}
              </button>
            </div>
          </div>
        </div>
      )}

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
