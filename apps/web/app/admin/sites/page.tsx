'use client';
/**
 * Admin — Sites Management (/admin/sites)
 *
 * Compact rows matching the Guards page pattern: search + status chips
 * (ENABLED / DISABLED / ALL) in the header, alphabetical uniform-height
 * rows, and a right-side "Details ▾" pill that expands each row inline
 * to reveal geofence, instructions, client-access-until, data-deletion,
 * and client-portal controls. All create/geofence/PDF/deactivate modals
 * are preserved verbatim.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { adminGet, adminPatch, adminPost } from '../../../lib/adminApi';
import {
  centroidOf,
  boundingRadiusMeters,
  isSelfIntersecting,
  looksLikeCircleSynth,
  circlePolygon,
  type LatLng,
} from '../../../lib/geofenceMath';

const GeofenceMapEditor = dynamic(() => import('../../../components/GeofenceMapEditor'), {
  ssr: false,
  loading: () => (
    <div className="h-[400px] w-full rounded-lg border border-[#1A3050] bg-[#0B1526] flex items-center justify-center text-gray-500 text-sm">
      Loading map…
    </div>
  ),
});

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
function getAdminToken() {
  if (typeof document === 'undefined') return '';
  return document.cookie.match(/guard_admin_access=([^;]+)/)?.[1] ?? '';
}

interface Site {
  id:                          string;
  name:                        string;
  address:                     string;
  contract_start:              string;
  contract_end:                string | null;      // FIX 2: nullable, grandfathered for existing rows
  timezone:                    string;
  is_active:                   boolean;
  client_access_disabled_at:   string | null;
  client_star_access_until:    string | null;
  data_delete_at:              string | null;
  has_geofence:                boolean;
  center_lat:                  number | null;
  center_lng:                  number | null;
  radius_meters:               number | null;
  polygon_coordinates:         LatLng[] | null;
  instructions_pdf_url:        string | null;
  company_name?:               string;
  geocoded_lat?:               number | null;      // FIX 4: geocoded on NEW SITE address blur
  geocoded_lng?:               number | null;
}

interface DeactivatePreview {
  scheduled_shifts:   number;
  active_sessions:    number;
  open_assignments:   number;
}

// Session C — client account management inside expanded site row.
interface Client {
  id:                   string;
  site_id:              string;
  name:                 string;
  email:                string;
  is_active:            boolean;
  must_change_password: boolean;
  created_at:           string;
  last_login_at:        string | null;
}

interface CredentialsBanner {
  email:         string;
  temp_password: string;
  mode:          'created' | 'reset';
}

// Session S6 — site scheduling profiles.
interface ProfileShift {
  id?:                 string;   // present when fetched from server
  clientKey?:          string;   // client-side stable React key for new rows
  day_of_week:         number;   // 0=Sun … 6=Sat
  shift_start_time:    string;   // "HH:MM" or "HH:MM:SS"
  shift_length_hours:  number;   // e.g. 8, 12, 8.5
  guards_needed:       number;   // 1-10
  active:              boolean;
}

interface Profile {
  id:            string;
  site_id:       string;
  profile_name:  string;
  is_active:     boolean;
  created_at:    string;
  updated_at:    string;
  shifts:        ProfileShift[];
}

interface CoverageStatus {
  site_id:            string;
  has_active_profile: boolean;
  required:           number;
  scheduled:          number;
  gaps:               number;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let __shiftKeyCounter = 0;
function nextShiftKey() { return `s${++__shiftKeyCounter}`; }
function makeShiftDraft(dow: number, prev?: ProfileShift): ProfileShift {
  if (prev) return { ...prev, id: undefined, clientKey: nextShiftKey(), day_of_week: dow };
  return {
    clientKey:          nextShiftKey(),
    day_of_week:        dow,
    shift_start_time:   '08:00',
    shift_length_hours: 8,
    guards_needed:      1,
    active:             true,
  };
}

// Cryptographically secure temp password for the ADD CLIENT modal. Same
// alphabet as apps/api/src/utils/tempPassword.ts (no 0/O/I/l/1 confusion).
const TEMP_PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function generateTempPasswordClient(length = 12): string {
  const bytes = new Uint8Array(length);
  if (typeof window === 'undefined' || !window.crypto?.getRandomValues) {
    // Node/SSR fallback — Math.random is acceptable here because this path
    // is only ever hit during server rendering of the initial form; the
    // real value is regenerated in a useEffect once we're client-side.
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  } else {
    window.crypto.getRandomValues(bytes);
  }
  let out = '';
  for (let i = 0; i < length; i++) out += TEMP_PW_ALPHABET[bytes[i] % TEMP_PW_ALPHABET.length];
  return out;
}

// "3 days ago" / "Never logged in" for the client row's last-login line.
function relativeTime(iso: string | null): string {
  if (!iso) return 'Never logged in';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000)                return 'just now';
  if (diff < 3_600_000)             return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000)            return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 30)                    return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12)                  return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

type GeoMode = 'radius' | 'draw';
type StatusFilter = 'enabled' | 'disabled' | 'all';

// Keep in sync with ALLOWED_TIMEZONES in apps/api/src/routes/sites.ts.
const TIMEZONE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'America/Los_Angeles', label: 'Pacific — Los Angeles (PT)' },
  { value: 'America/Denver',      label: 'Mountain — Denver (MT)' },
  { value: 'America/Phoenix',     label: 'Mountain — Phoenix (no DST)' },
  { value: 'America/Chicago',     label: 'Central — Chicago (CT)' },
  { value: 'America/New_York',    label: 'Eastern — New York (ET)' },
  { value: 'Pacific/Honolulu',    label: 'Hawaii — Honolulu (HST)' },
  { value: 'UTC',                 label: 'UTC' },
];

// FIX 2: contract_end removed from the create form entirely. Existing DB
// rows with a value stay untouched (grandfathered — display still shows
// "start → end" when a value is present).
const EMPTY_FORM = {
  name: '',
  address: '',
  contract_start: '',
  timezone: 'America/Los_Angeles',
};

// FIX 4: address-geocode lookup state. `ok` means we have lat/lng ready to
// send to POST /api/sites; `error` shows an inline message; `idle` renders
// nothing. Reset to idle whenever the modal opens or the admin edits the
// address again.
type GeoLookup =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok';    lat: number; lng: number; formatted_address: string }
  | { status: 'error'; message: string };
const EMPTY_GEO  = { center_lat: '', center_lng: '', radius_meters: '' };

const STATUS_CHIPS: StatusFilter[] = ['enabled', 'disabled', 'all'];

export default function SitesPage() {
  const [sites,        setSites]        = useState<Site[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState('');

  // Redesign state
  const [search,       setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('enabled');
  const [expanded,     setExpanded]     = useState<Set<string>>(new Set());

  // create-site modal
  const [showCreate,   setShowCreate]   = useState(false);
  const [form,         setForm]         = useState(EMPTY_FORM);
  const [saving,       setSaving]       = useState(false);
  const [formError,    setFormError]    = useState('');
  const [pdfFile,      setPdfFile]      = useState<File | null>(null);
  const [geoLookup,    setGeoLookup]    = useState<GeoLookup>({ status: 'idle' });

  // geofence modal
  const [geoSite,      setGeoSite]      = useState<Site | null>(null);
  const [geo,          setGeo]          = useState(EMPTY_GEO);
  const [geoMode,      setGeoMode]      = useState<GeoMode>('radius');
  const [drawnPolygon, setDrawnPolygon] = useState<LatLng[]>([]);
  const [geoSaving,    setGeoSaving]    = useState(false);
  const [geoError,     setGeoError]     = useState('');

  // Session A2 — address-search-inside-geofence-modal state.
  //   geoSearch{Input,Status,Result,Error}: driven by the search bar in the
  //     modal's left column. `result` is retained after success so the
  //     "Recenter map" button has something to fly to.
  //   focusPoint: passed to GeofenceMapEditor. New object literal per fly
  //     request — the map's useEffect keys on referential equality.
  //   polygonOffsetWarnDismissed: once dismissed for the current modal open,
  //     stays dismissed until modal reopen (openGeo resets it).
  const [geoSearchInput,  setGeoSearchInput]  = useState('');
  const [geoSearchStatus, setGeoSearchStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [geoSearchResult, setGeoSearchResult] = useState<{ lat: number; lng: number; formatted_address: string } | null>(null);
  const [geoSearchError,  setGeoSearchError]  = useState('');
  const [focusPoint,      setFocusPoint]      = useState<LatLng | null>(null);
  const [polygonOffsetWarnDismissed, setPolygonOffsetWarnDismissed] = useState(false);

  const [toggling,     setToggling]     = useState<string | null>(null);

  // deactivate flow
  const [deactivateSite,     setDeactivateSite]     = useState<Site | null>(null);
  const [deactivatePreview,  setDeactivatePreview]  = useState<DeactivatePreview | null>(null);
  const [deactivateBusy,     setDeactivateBusy]     = useState(false);
  const [deactivateError,    setDeactivateError]    = useState('');
  const [activeToggling,     setActiveToggling]     = useState<string | null>(null);

  // PDF modal
  const [pdfSite,      setPdfSite]      = useState<Site | null>(null);
  const [replacePdf,   setReplacePdf]   = useState<File | null>(null);
  const [pdfSaving,    setPdfSaving]    = useState(false);
  const [pdfError,     setPdfError]     = useState('');
  const pdfInputRef                     = useRef<HTMLInputElement>(null);

  // Session C — client management state.
  //   clientsPerSite: lazy-fetched on first expand of a site row.
  //   clientBanner: green banner shown after CREATE or RESET-PASSWORD;
  //     dismissable, never auto-hides (admin must copy the temp password).
  //   clientModalMode: 'add' | 'edit' | null; drives which modal renders.
  const [clientsPerSite, setClientsPerSite] = useState<Record<string, Client[] | undefined>>({});
  const [clientBanner,   setClientBanner]   = useState<CredentialsBanner | null>(null);
  const [clientModalMode, setClientModalMode] = useState<'add' | 'edit' | null>(null);
  const [clientModalSite, setClientModalSite] = useState<string | null>(null);
  const [editingClient,   setEditingClient]   = useState<Client | null>(null);
  const [clientForm,     setClientForm]     = useState({ name: '', email: '', password: '' });
  const [clientSaving,   setClientSaving]   = useState(false);
  const [clientFormError, setClientFormError] = useState('');
  const [clientToggling, setClientToggling] = useState<string | null>(null);

  // Session S6 — scheduling profiles state.
  const [profilesPerSite, setProfilesPerSite] = useState<Record<string, Profile[] | undefined>>({});
  const [coveragePerSite, setCoveragePerSite] = useState<Record<string, CoverageStatus | undefined>>({});
  const [profileModalMode, setProfileModalMode] = useState<'create' | 'edit' | null>(null);
  const [profileModalSiteId, setProfileModalSiteId] = useState<string | null>(null);
  const [editingProfile,   setEditingProfile]   = useState<Profile | null>(null);
  const [profileForm,      setProfileForm]      = useState<{
    profile_name: string;
    is_active:    boolean;
    shifts:       ProfileShift[];
  }>({ profile_name: '', is_active: true, shifts: [] });
  const [profileSaving,   setProfileSaving]   = useState(false);
  const [profileFormError, setProfileFormError] = useState('');
  const [profileToggling, setProfileToggling] = useState<string | null>(null);

  // Always fetch with include_inactive=1 so the chip toggle is a client-side
  // filter with no round-trip. Search across ALL sites regardless of chip.
  const load = useCallback(async () => {
    try {
      setSites(await adminGet<Site[]>('/api/sites?include_inactive=1'));
      setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Vishnu multi-company label — show company_name inline when the returned
  // set spans more than one company (same conditional pattern as Guards + Shifts).
  const showCompanyLabel = useMemo(() => {
    const set = new Set<string>();
    for (const s of sites) if (s.company_name) set.add(s.company_name);
    return set.size > 1;
  }, [sites]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sites
      .filter((s) =>
        statusFilter === 'all' ? true
        : statusFilter === 'enabled' ? s.is_active
        : !s.is_active
      )
      .filter((s) => {
        if (!q) return true;
        return s.name.toLowerCase().includes(q)
          || (s.address ?? '').toLowerCase().includes(q);
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [sites, search, statusFilter]);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        // Session C — lazy-fetch clients on first expand.
        if (clientsPerSite[id]  === undefined) fetchClientsForSite(id);
        // Session S6 — lazy-fetch scheduling profiles + coverage snapshot.
        if (profilesPerSite[id] === undefined) fetchProfilesForSite(id);
      }
      return next;
    });
  }

  // ── Session S6 — scheduling profiles handlers ──────────────────────────
  async function fetchProfilesForSite(siteId: string) {
    try {
      const [prof, cov] = await Promise.all([
        adminGet<{ profiles: Profile[] }>(`/api/scheduling/site/${siteId}`),
        adminGet<CoverageStatus>(`/api/scheduling/site/${siteId}/coverage-status`),
      ]);
      setProfilesPerSite((prev) => ({ ...prev, [siteId]: prof.profiles }));
      setCoveragePerSite((prev) => ({ ...prev, [siteId]: cov }));
    } catch (e: any) {
      setProfilesPerSite((prev) => ({ ...prev, [siteId]: [] }));
      setError(e?.message ?? 'Failed to load scheduling profiles');
    }
  }

  function openCreateProfileModal(siteId: string) {
    setProfileModalMode('create');
    setProfileModalSiteId(siteId);
    setEditingProfile(null);
    setProfileForm({ profile_name: '', is_active: true, shifts: [] });
    setProfileFormError('');
  }

  function openEditProfileModal(siteId: string, profile: Profile) {
    setProfileModalMode('edit');
    setProfileModalSiteId(siteId);
    setEditingProfile(profile);
    setProfileForm({
      profile_name: profile.profile_name,
      is_active:    profile.is_active,
      shifts:       profile.shifts.map((s) => ({ ...s, clientKey: nextShiftKey() })),
    });
    setProfileFormError('');
  }

  function closeProfileModal() {
    setProfileModalMode(null);
    setProfileModalSiteId(null);
    setEditingProfile(null);
    setProfileForm({ profile_name: '', is_active: true, shifts: [] });
    setProfileFormError('');
  }

  function addShiftToDay(dow: number) {
    setProfileForm((f) => ({ ...f, shifts: [...f.shifts, makeShiftDraft(dow)] }));
  }
  function updateShiftAt(idx: number, patch: Partial<ProfileShift>) {
    setProfileForm((f) => ({
      ...f,
      shifts: f.shifts.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    }));
  }
  function removeShiftAt(idx: number) {
    setProfileForm((f) => ({ ...f, shifts: f.shifts.filter((_, i) => i !== idx) }));
  }
  function copyMondayToWeekdays() {
    setProfileForm((f) => {
      const mondayShifts = f.shifts.filter((s) => s.day_of_week === 1);
      if (mondayShifts.length === 0) return f;
      const keepOthers = f.shifts.filter((s) => s.day_of_week === 0 || s.day_of_week === 1 || s.day_of_week === 6);
      const copies: ProfileShift[] = [];
      for (const dow of [2, 3, 4, 5]) {
        for (const src of mondayShifts) copies.push(makeShiftDraft(dow, src));
      }
      return { ...f, shifts: [...keepOthers, ...copies] };
    });
  }
  function copyFromPreviousDay(dow: number) {
    setProfileForm((f) => {
      const src = f.shifts.filter((s) => s.day_of_week === dow - 1);
      if (src.length === 0) return f;
      const removed = f.shifts.filter((s) => s.day_of_week !== dow);
      const copies  = src.map((s) => makeShiftDraft(dow, s));
      return { ...f, shifts: [...removed, ...copies] };
    });
  }

  async function saveProfile() {
    const name = profileForm.profile_name.trim();
    if (name.length < 2) { setProfileFormError('Profile name must be at least 2 characters'); return; }
    if (profileForm.shifts.length === 0) { setProfileFormError('Add at least one shift somewhere in the week'); return; }
    const cleanShifts = profileForm.shifts.map((s) => ({
      day_of_week:        s.day_of_week,
      shift_start_time:   s.shift_start_time.length === 5 ? `${s.shift_start_time}:00` : s.shift_start_time,
      shift_length_hours: Number(s.shift_length_hours),
      guards_needed:      Number(s.guards_needed),
      active:             s.active,
    }));
    setProfileSaving(true); setProfileFormError('');
    try {
      const siteId = profileModalSiteId!;
      if (profileModalMode === 'create') {
        await adminPost(`/api/scheduling/site/${siteId}/profile`, {
          profile_name: name,
          is_active:    profileForm.is_active,
          shifts:       cleanShifts,
        });
      } else if (editingProfile) {
        await adminPatch(`/api/scheduling/profile/${editingProfile.id}`, {
          profile_name: name,
          is_active:    profileForm.is_active,
          shifts:       cleanShifts,
        });
      }
      closeProfileModal();
      await fetchProfilesForSite(siteId);
    } catch (e: any) { setProfileFormError(e?.message ?? 'Failed to save profile'); }
    finally { setProfileSaving(false); }
  }

  async function toggleProfileActive(profile: Profile, siteId: string) {
    const msg = profile.is_active
      ? `Deactivate profile "${profile.profile_name}"?`
      : `Activate profile "${profile.profile_name}"? Any currently active profile at this site will be deactivated.`;
    if (!confirm(msg)) return;
    setProfileToggling(profile.id);
    try {
      await adminPatch(`/api/scheduling/profile/${profile.id}`, { is_active: !profile.is_active });
      await fetchProfilesForSite(siteId);
    } catch (e: any) { setError(e?.message ?? 'Failed to toggle profile'); }
    finally { setProfileToggling(null); }
  }

  async function deleteProfile(profile: Profile, siteId: string) {
    if (!confirm(`Delete profile "${profile.profile_name}"? This can't be undone.`)) return;
    try {
      await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/api/scheduling/profile/${profile.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type':  'application/json',
          Authorization:   `Bearer ${document.cookie.match(/guard_admin_access=([^;]+)/)?.[1] ?? ''}`,
        },
      }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error ?? 'Delete failed'); });
      await fetchProfilesForSite(siteId);
    } catch (e: any) { setError(e?.message ?? 'Failed to delete profile'); }
  }

  // Derived — coverage summary shown in the CREATE/EDIT modal footer.
  const profileFormSummary = useMemo(() => {
    const active = profileForm.shifts.filter((s) => s.active);
    const shiftsWeek  = active.length;
    const hoursWeek   = active.reduce((sum, s) => sum + s.shift_length_hours, 0);
    const guardsWeek  = active.reduce((sum, s) => sum + s.guards_needed, 0);
    return { shiftsWeek, hoursWeek, guardsWeek };
  }, [profileForm.shifts]);

  // ── Session C — client management handlers ─────────────────────────────
  async function fetchClientsForSite(siteId: string) {
    try {
      const list = await adminGet<Client[]>(`/api/clients/${siteId}`);
      setClientsPerSite((prev) => ({ ...prev, [siteId]: list }));
    } catch (e: any) {
      // Set to empty so we don't retry infinitely; surface inline error.
      setClientsPerSite((prev) => ({ ...prev, [siteId]: [] }));
      setError(e?.message ?? 'Failed to load clients');
    }
  }

  function openAddClientModal(siteId: string) {
    setClientModalMode('add');
    setClientModalSite(siteId);
    setEditingClient(null);
    setClientForm({ name: '', email: '', password: generateTempPasswordClient(12) });
    setClientFormError('');
  }

  function openEditClientModal(siteId: string, client: Client) {
    setClientModalMode('edit');
    setClientModalSite(siteId);
    setEditingClient(client);
    setClientForm({ name: client.name, email: client.email, password: '' });
    setClientFormError('');
  }

  function closeClientModal() {
    setClientModalMode(null);
    setClientModalSite(null);
    setEditingClient(null);
    setClientForm({ name: '', email: '', password: '' });
    setClientFormError('');
  }

  function regenerateTempPassword() {
    setClientForm((f) => ({ ...f, password: generateTempPasswordClient(12) }));
  }

  async function saveNewClient() {
    if (!clientModalSite) return;
    const name  = clientForm.name.trim();
    const email = clientForm.email.trim().toLowerCase();
    if (name.length < 2) { setClientFormError('Full name must be at least 2 characters'); return; }
    if (!email.includes('@')) { setClientFormError('Enter a valid email address'); return; }
    setClientSaving(true); setClientFormError('');
    try {
      const r = await adminPost<{ client: Client; temp_password?: string }>('/api/clients', {
        site_id: clientModalSite,
        name,
        email,
        password: clientForm.password,
      });
      // Client generated the password locally, so surface it in the banner
      // rather than r.temp_password (which the server only echoes back on
      // auto-generate).
      setClientBanner({ email: r.client.email, temp_password: clientForm.password, mode: 'created' });
      const targetSite = clientModalSite;
      closeClientModal();
      if (targetSite) fetchClientsForSite(targetSite);
    } catch (e: any) { setClientFormError(e?.message ?? 'Failed to create client'); }
    finally { setClientSaving(false); }
  }

  async function saveEditedClient() {
    if (!editingClient) return;
    const name  = clientForm.name.trim();
    const email = clientForm.email.trim().toLowerCase();
    const changes: Record<string, unknown> = {};
    if (name  !== editingClient.name)  changes.name  = name;
    if (email !== editingClient.email) changes.email = email;
    if (Object.keys(changes).length === 0) { closeClientModal(); return; }
    setClientSaving(true); setClientFormError('');
    try {
      await adminPatch(`/api/clients/${editingClient.id}`, changes);
      const targetSite = clientModalSite;
      closeClientModal();
      if (targetSite) fetchClientsForSite(targetSite);
    } catch (e: any) { setClientFormError(e?.message ?? 'Failed to save client'); }
    finally { setClientSaving(false); }
  }

  async function resetClientPassword() {
    if (!editingClient) return;
    if (!confirm(`Reset password for ${editingClient.email}? Their current session ends immediately.`)) return;
    setClientSaving(true); setClientFormError('');
    try {
      const r = await adminPost<{ temp_password: string; email: string }>(
        `/api/clients/${editingClient.id}/reset-password`, {},
      );
      setClientBanner({ email: r.email, temp_password: r.temp_password, mode: 'reset' });
      const targetSite = clientModalSite;
      closeClientModal();
      if (targetSite) fetchClientsForSite(targetSite);
    } catch (e: any) { setClientFormError(e?.message ?? 'Failed to reset password'); }
    finally { setClientSaving(false); }
  }

  async function toggleClientActive(client: Client, siteId: string) {
    const msg = client.is_active
      ? `Deactivate ${client.email}? Their session will end immediately.`
      : `Reactivate ${client.email}? They'll need to log in again.`;
    if (!confirm(msg)) return;
    setClientToggling(client.id);
    try {
      await adminPatch(`/api/clients/${client.id}`, { is_active: !client.is_active });
      await fetchClientsForSite(siteId);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to update client');
    } finally { setClientToggling(null); }
  }

  function copyCredentialsToClipboard(b: CredentialsBanner) {
    const text = `Portal: https://netraops.com/portal\nEmail: ${b.email}\nPassword: ${b.temp_password}`;
    navigator.clipboard?.writeText(text).catch(() => { /* ignore */ });
  }

  /* ── Modal handlers (unchanged from previous version) ────────────── */
  async function openDeactivate(site: Site) {
    setDeactivateSite(site);
    setDeactivatePreview(null);
    setDeactivateError('');
    try {
      const preview = await adminGet<DeactivatePreview>(
        `/api/sites/${site.id}/deactivate-preview`,
      );
      setDeactivatePreview(preview);
    } catch (e: any) {
      setDeactivateError(e.message);
    }
  }

  async function confirmDeactivate() {
    if (!deactivateSite) return;
    setDeactivateBusy(true);
    setDeactivateError('');
    try {
      await adminPatch(`/api/sites/${deactivateSite.id}/active`, { active: false });
      setDeactivateSite(null);
      setDeactivatePreview(null);
      await load();
    } catch (e: any) {
      setDeactivateError(e.message);
    } finally {
      setDeactivateBusy(false);
    }
  }

  async function reactivateSite(id: string) {
    setActiveToggling(id);
    try {
      await adminPatch(`/api/sites/${id}/active`, { active: true });
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActiveToggling(null);
    }
  }

  async function uploadPdfToSite(siteId: string, file: File): Promise<void> {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${API}/api/sites/${siteId}/instructions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getAdminToken()}` },
      body: fd,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as any).error ?? 'PDF upload failed');
    }
  }

  async function createSite() {
    if (!form.name || !form.address || !form.contract_start) {
      setFormError('Site name, address, and contract start are required'); return;
    }
    setSaving(true); setFormError('');
    try {
      // FIX 4: if the address geocoded successfully, ship those coords with
      // the create call so they land in sites.geocoded_lat/lng and can
      // pre-fill the geofence editor later.
      const body: Record<string, unknown> = { ...form };
      if (geoLookup.status === 'ok') {
        body.geocoded_lat = geoLookup.lat;
        body.geocoded_lng = geoLookup.lng;
      }
      const site = await adminPost<{ id: string }>('/api/sites', body);
      if (pdfFile) {
        try { await uploadPdfToSite(site.id, pdfFile); }
        catch (e: any) { setFormError(`Site created but PDF upload failed: ${e.message}`); }
      }
      setShowCreate(false); setForm(EMPTY_FORM); setPdfFile(null); setGeoLookup({ status: 'idle' });
      await load();
    } catch (e: any) { setFormError(e.message); }
    finally { setSaving(false); }
  }

  // FIX 4: called on address-field blur in the NEW SITE modal. Returns
  // silently if the address is too short to be worth a lookup.
  async function lookupAddress() {
    const addr = form.address.trim();
    if (addr.length < 5) { setGeoLookup({ status: 'idle' }); return; }
    setGeoLookup({ status: 'loading' });
    try {
      const r = await adminPost<{ lat: number; lng: number; formatted_address: string }>(
        '/api/geocode',
        { address: addr },
      );
      setGeoLookup({ status: 'ok', lat: r.lat, lng: r.lng, formatted_address: r.formatted_address });
    } catch (e: any) {
      setGeoLookup({ status: 'error', message: e?.message ?? 'Coordinates not found for this address.' });
    }
  }

  async function savePdf() {
    if (!replacePdf) { setPdfError('Select a PDF file first'); return; }
    setPdfSaving(true); setPdfError('');
    try {
      await uploadPdfToSite(pdfSite!.id, replacePdf);
      setPdfSite(null); setReplacePdf(null);
      await load();
    } catch (e: any) { setPdfError(e.message); }
    finally { setPdfSaving(false); }
  }

  function openGeo(site: Site) {
    setGeoSite(site);
    const raw = site.polygon_coordinates;
    const existing: LatLng[] = Array.isArray(raw) ? raw : [];
    const validExisting = existing.length >= 3;
    const defaultMode: GeoMode = validExisting && !looksLikeCircleSynth(existing) ? 'draw' : 'radius';
    if (site.has_geofence && !validExisting) {
      // eslint-disable-next-line no-console
      console.warn('[geofence] site marked has_geofence=true but polygon missing/short — defaulting to Radius mode', {
        siteId: site.id, rawType: typeof raw, isArray: Array.isArray(raw), length: Array.isArray(raw) ? raw.length : null,
      });
    }
    setGeoMode(defaultMode);
    setDrawnPolygon(validExisting ? existing : []);
    // FIX 4: pre-populate with the actual fence centre if one exists;
    // otherwise fall back to the geocoded coords captured on site creation.
    // Radius has no analogous fallback — admin picks that.
    setGeo({
      center_lat:    site.center_lat    != null ? String(site.center_lat)
                   : site.geocoded_lat  != null ? String(site.geocoded_lat)
                   : '',
      center_lng:    site.center_lng    != null ? String(site.center_lng)
                   : site.geocoded_lng  != null ? String(site.geocoded_lng)
                   : '',
      radius_meters: site.radius_meters != null ? String(site.radius_meters) : '',
    });
    setGeoError('');
    // Session A2 — reset all search-bar state on each modal open.
    setGeoSearchInput('');
    setGeoSearchStatus('idle');
    setGeoSearchResult(null);
    setGeoSearchError('');
    setFocusPoint(null);
    setPolygonOffsetWarnDismissed(false);
  }

  // Session A2 — search handler for the geofence modal's inline address bar.
  // On success: fills LATITUDE + LONGITUDE inputs, flies the map to the
  // result (via a new focusPoint reference), and keeps the result handy for
  // the "Recenter map" button.
  async function searchGeofenceAddress() {
    const q = geoSearchInput.trim();
    if (q.length < 3) return;
    setGeoSearchStatus('loading');
    setGeoSearchError('');
    try {
      const r = await adminPost<{ lat: number; lng: number; formatted_address: string }>(
        '/api/geocode',
        { address: q },
      );
      setGeoSearchStatus('ok');
      setGeoSearchResult(r);
      setGeo((g) => ({ ...g, center_lat: String(r.lat), center_lng: String(r.lng) }));
      setFocusPoint({ lat: r.lat, lng: r.lng });
      setPolygonOffsetWarnDismissed(false);
    } catch (e: any) {
      setGeoSearchStatus('error');
      setGeoSearchError(e?.message ?? 'Search failed');
    }
  }

  function recenterMapOnSearch() {
    if (!geoSearchResult) return;
    setGeo((g) => ({
      ...g,
      center_lat: String(geoSearchResult.lat),
      center_lng: String(geoSearchResult.lng),
    }));
    // Fresh object literal — GeofenceMapEditor's FlyTo useEffect keys on
    // referential equality, so this fires flyTo even when lat/lng haven't
    // changed since the last fly.
    setFocusPoint({ lat: geoSearchResult.lat, lng: geoSearchResult.lng });
  }

  // Map server-side error strings to concise UI copy per spec.
  function mapGeoSearchError(msg: string): string {
    const lower = msg.toLowerCase();
    if (lower.includes('not configured')) return 'Address search not configured — enter coordinates manually.';
    if (lower.includes('not found') || lower.includes('zero_results')) return 'Address not found — try a more specific query.';
    if (lower.includes('upstream') || lower.includes('request failed') || lower.includes('temporarily')) {
      return 'Search temporarily unavailable — try again in a moment.';
    }
    return msg;
  }

  function handlePolygonChange(poly: LatLng[]) {
    setDrawnPolygon(poly);
    if (poly.length >= 3) {
      const c = centroidOf(poly);
      const r = boundingRadiusMeters(c, poly);
      setGeo({
        center_lat:    c.lat.toFixed(6),
        center_lng:    c.lng.toFixed(6),
        radius_meters: String(r),
      });
    }
  }

  async function saveGeofence() {
    const lat = parseFloat(geo.center_lat);
    const lng = parseFloat(geo.center_lng);
    const rad = parseInt(geo.radius_meters, 10);
    if (isNaN(lat) || isNaN(lng) || isNaN(rad) || rad <= 0) {
      setGeoError('Enter valid latitude, longitude and radius (metres)'); return;
    }
    if (lat < -90 || lat > 90)  { setGeoError('Latitude must be between -90 and 90');   return; }
    if (lng < -180 || lng > 180){ setGeoError('Longitude must be between -180 and 180'); return; }

    let polygon: LatLng[];
    if (geoMode === 'draw') {
      if (drawnPolygon.length < 3) {
        setGeoError('Draw a polygon with at least 3 vertices first.'); return;
      }
      if (isSelfIntersecting(drawnPolygon)) {
        setGeoError('Polygon edges cross. Re-draw without self-intersections.'); return;
      }
      polygon = drawnPolygon;
    } else {
      polygon = circlePolygon(lat, lng, rad);
    }

    setGeoSaving(true); setGeoError('');
    try {
      await adminPatch(`/api/sites/${geoSite!.id}/geofence`, {
        center_lat:          lat,
        center_lng:          lng,
        radius_meters:       rad,
        polygon_coordinates: polygon,
      });
      setGeoSite(null);
      await load();
    } catch (e: any) { setGeoError(e.message); }
    finally { setGeoSaving(false); }
  }

  async function toggleClientAccess(id: string, enabled: boolean) {
    setToggling(id);
    try { await adminPatch(`/api/sites/${id}/client-access`, { enabled }); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setToggling(null); }
  }

  // Session B — mint a 30-min read-only preview token and open /client
  // in a new tab. clientApi.getToken() reads ?preview=<jwt>, sets the
  // cookie, and PreviewBootstrap scrubs the URL after mount.
  async function previewAsClient(siteId: string) {
    try {
      const r = await adminPost<{ access_token: string; expires_in: number }>(
        `/api/admin/sites/${siteId}/preview-client-token`,
        {},
      );
      window.open(`/client?preview=${encodeURIComponent(r.access_token)}`, '_blank', 'noopener');
    } catch (e: any) {
      setError(e.message ?? 'Preview failed');
    }
  }

  function fmtDate(iso: string | null) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function daysUntil(iso: string | null) {
    if (!iso) return null;
    return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl md:text-3xl font-bold tracking-widest text-amber-400">SITES</h1>
        <div className="flex flex-wrap gap-3 items-center">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search sites or address…"
            className="bg-[#0F1E35] border border-[#1A3050] text-gray-200 text-sm rounded-lg px-3 py-2 min-w-[220px] focus:outline-none focus:border-amber-400"
          />
          <div className="flex items-center gap-1 bg-[#0F1E35] border border-[#1A3050] rounded-lg p-1">
            {STATUS_CHIPS.map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 rounded text-xs tracking-widest transition-colors ${
                  statusFilter === s ? 'bg-amber-500 text-black font-bold' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {s.toUpperCase()}
              </button>
            ))}
          </div>
          <button
            onClick={() => { setShowCreate(true); setFormError(''); setForm(EMPTY_FORM); }}
            className="bg-amber-400 text-gray-900 font-bold tracking-widest text-sm px-4 py-2 rounded-lg hover:bg-amber-300 transition-colors min-h-[40px]"
          >
            + NEW SITE
          </button>
        </div>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      {/* Session C — credentials banner after CREATE or RESET-PASSWORD.
          Doesn't auto-hide: admin must copy the temp password before
          navigating away. */}
      {clientBanner && (
        <div className="bg-green-900/40 border border-green-500 text-green-300 text-sm rounded-lg px-4 py-3 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-green-200 font-medium mb-1">
              {clientBanner.mode === 'created' ? 'Client created.' : 'New temp password ready.'} Share these credentials:
            </p>
            <p className="text-sm leading-6">
              Portal: <span className="font-mono text-green-100">https://netraops.com/portal</span><br />
              Email: <span className="font-mono text-green-100">{clientBanner.email}</span><br />
              Password: <span className="font-mono text-green-100 font-bold">{clientBanner.temp_password}</span>
            </p>
            <p className="text-green-400 text-xs mt-2">Client will be prompted to change the password on first login.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => copyCredentialsToClipboard(clientBanner)}
              className="text-xs text-green-300 hover:text-green-100 tracking-widest border border-green-500/40 rounded px-3 py-1 hover:bg-green-500/10"
            >
              COPY
            </button>
            <button
              onClick={() => setClientBanner(null)}
              aria-label="Dismiss"
              className="text-green-400 hover:text-green-200 text-lg leading-none"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Compact list */}
      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
        {loading && <p className="p-8 text-center text-gray-500">Loading…</p>}
        {!loading && visible.length === 0 && (
          <p className="p-8 text-center text-gray-500">No sites match your criteria.</p>
        )}
        {!loading && visible.map((site) => {
          const isExpanded    = expanded.has(site.id);
          const isDeactivated = !site.is_active;
          const clientEnabled = !site.client_access_disabled_at;
          const accessIn      = daysUntil(site.client_star_access_until);
          const deleteIn      = daysUntil(site.data_delete_at);
          return (
            <div key={site.id} className={`border-b border-[#1A3050] last:border-b-0 ${isDeactivated ? 'opacity-60' : ''}`}>
              {/* Collapsed row — uniform height */}
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-4 px-4 py-3 hover:bg-[#0B1526] transition-colors">
                <div className="min-w-0">
                  <p className="text-gray-200 font-medium truncate">{site.name}</p>
                  {site.address && <p className="text-gray-500 text-xs truncate">{site.address}</p>}
                  {showCompanyLabel && site.company_name && (
                    <p className="text-gray-600 text-[10px] tracking-widest mt-0.5">{site.company_name.toUpperCase()}</p>
                  )}
                </div>
                {/* FIX 2: no "no end date" filler. When contract_end is null,
                    show just the start date; when present, show start → end. */}
                <div className="text-gray-400 text-xs text-right whitespace-nowrap hidden md:block">
                  {fmtDate(site.contract_start)}
                  {site.contract_end && (
                    <>
                      <span className="text-gray-600"> → </span>
                      {fmtDate(site.contract_end)}
                    </>
                  )}
                </div>
                {site.is_active ? (
                  <span className="text-xs tracking-widest text-green-400 bg-green-400/10 border border-green-400/30 px-2 py-0.5 rounded">ENABLED</span>
                ) : (
                  <span className="text-xs tracking-widest text-red-400 bg-red-400/10 border border-red-400/30 px-2 py-0.5 rounded">DISABLED</span>
                )}
                <button
                  onClick={() => toggleExpand(site.id)}
                  className="px-2.5 py-1 rounded-full text-[11px] font-bold tracking-widest bg-blue-500/20 border border-blue-500/40 text-blue-300 hover:bg-blue-500/30 transition-colors"
                >
                  DETAILS {isExpanded ? '▲' : '▾'}
                </button>
              </div>

              {/* Expanded detail section */}
              {isExpanded && (
                <div className="bg-[#0B1526] px-4 py-4 border-t border-[#1A3050] space-y-4">
                  {/* Contract dates — mirrored inside for mobile where they were hidden on the row */}
                  <div className="md:hidden">
                    <p className="text-gray-500 text-xs tracking-widest mb-1">CONTRACT</p>
                    <p className="text-gray-300 text-sm">
                      {fmtDate(site.contract_start)}
                      {site.contract_end && (
                        <>
                          <span className="text-gray-600"> → </span>
                          {fmtDate(site.contract_end)}
                        </>
                      )}
                    </p>
                  </div>

                  {/* GEOFENCE */}
                  <div>
                    <p className="text-gray-500 text-xs tracking-widest mb-1">GEOFENCE</p>
                    {site.has_geofence ? (
                      <div className="flex items-center flex-wrap gap-3">
                        <span className="inline-flex items-center gap-1.5 text-xs text-green-400">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
                          SET
                        </span>
                        <span className="text-gray-500 text-xs font-mono">
                          {site.center_lat?.toFixed(5)}, {site.center_lng?.toFixed(5)}
                        </span>
                        <span className="text-gray-500 text-xs">{site.radius_meters}m radius</span>
                        <button
                          onClick={() => openGeo(site)}
                          className="text-xs text-amber-400 hover:text-amber-300 underline"
                        >
                          Edit
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => openGeo(site)}
                        className="text-xs text-red-400 border border-red-700 px-2 py-1 rounded hover:border-amber-400 hover:text-amber-400 transition-colors"
                      >
                        NOT SET — Configure
                      </button>
                    )}
                  </div>

                  {/* INSTRUCTIONS */}
                  <div>
                    <p className="text-gray-500 text-xs tracking-widest mb-1">INSTRUCTIONS</p>
                    {site.instructions_pdf_url ? (
                      <div className="flex items-center gap-3">
                        <a href={site.instructions_pdf_url} target="_blank" rel="noopener noreferrer"
                           className="text-xs text-cyan-400 underline">View PDF</a>
                        <button onClick={() => { setPdfSite(site); setReplacePdf(null); setPdfError(''); }}
                                className="text-xs text-amber-400 hover:text-amber-300 underline">Replace</button>
                      </div>
                    ) : (
                      <button onClick={() => { setPdfSite(site); setReplacePdf(null); setPdfError(''); }}
                              className="text-xs text-gray-400 border border-[#1A3050] px-2 py-1 rounded hover:border-amber-400 hover:text-amber-400 transition-colors">
                        + Upload
                      </button>
                    )}
                  </div>

                  {/* CLIENT ACCESS UNTIL */}
                  <div>
                    <p className="text-gray-500 text-xs tracking-widest mb-1">CLIENT ACCESS UNTIL</p>
                    {site.client_star_access_until ? (
                      <span className={`text-xs ${accessIn !== null && accessIn <= 14 ? 'text-red-400' : 'text-gray-300'}`}>
                        {fmtDate(site.client_star_access_until)}
                        {accessIn !== null && accessIn <= 30 && (
                          <span className="ml-1 text-red-400">({accessIn}d)</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-gray-600 text-xs">—</span>
                    )}
                  </div>

                  {/* DATA DELETION */}
                  <div>
                    <p className="text-gray-500 text-xs tracking-widest mb-1">DATA DELETION</p>
                    {site.data_delete_at ? (
                      <span className={`text-xs ${deleteIn !== null && deleteIn <= 30 ? 'text-red-400' : 'text-gray-300'}`}>
                        {fmtDate(site.data_delete_at)}
                        {deleteIn !== null && deleteIn <= 30 && (
                          <span className="ml-1">({deleteIn}d)</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-gray-600 text-xs">—</span>
                    )}
                  </div>

                  {/* CLIENT PORTAL — status pill + verb-form action button.
                      FIX 1: pill shows ENABLED/DISABLED at a glance; the
                      button label is a verb ("DISABLE PORTAL" / "ENABLE PORTAL")
                      so the admin can't mistake it for the whole-site toggle. */}
                  <div>
                    <p className="text-gray-500 text-xs tracking-widest mb-1">CLIENT PORTAL</p>
                    <div className="flex items-center gap-3 flex-wrap">
                      {isDeactivated ? (
                        <button
                          onClick={() => reactivateSite(site.id)}
                          disabled={activeToggling === site.id}
                          className="text-xs tracking-widest px-3 py-1 rounded transition-colors bg-[#0B1526] text-gray-400 border border-[#1A3050] hover:border-amber-400 hover:text-amber-400 disabled:opacity-40"
                        >
                          {activeToggling === site.id ? '…' : 'REACTIVATE SITE'}
                        </button>
                      ) : (
                        <>
                          {clientEnabled ? (
                            <span className="inline-flex items-center gap-1.5 text-xs tracking-widest text-green-400 bg-green-400/10 border border-green-400/30 px-2 py-0.5 rounded">
                              <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
                              ENABLED
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-xs tracking-widest text-red-400 bg-red-400/10 border border-red-400/30 px-2 py-0.5 rounded">
                              <span className="w-1.5 h-1.5 rounded-full bg-red-400 inline-block" />
                              DISABLED
                            </span>
                          )}
                          <button
                            onClick={() => toggleClientAccess(site.id, !clientEnabled)}
                            disabled={toggling === site.id}
                            className={`text-xs tracking-widest px-3 py-1 rounded transition-colors bg-[#0B1526] text-gray-400 border border-[#1A3050] disabled:opacity-40 ${
                              clientEnabled
                                ? 'hover:border-red-500 hover:text-red-400'
                                : 'hover:border-green-500 hover:text-green-400'
                            }`}
                          >
                            {toggling === site.id ? '…' : clientEnabled ? 'DISABLE PORTAL' : 'ENABLE PORTAL'}
                          </button>
                          <button
                            onClick={() => previewAsClient(site.id)}
                            title="Opens the client portal in a new tab as read-only for 30 minutes."
                            className="text-xs tracking-widest px-3 py-1 rounded bg-[#0B1526] text-cyan-400 border border-cyan-500/40 hover:bg-cyan-500/10 hover:border-cyan-500 transition-colors"
                          >
                            PREVIEW AS CLIENT ↗
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Session C — CLIENTS AT THIS SITE. Lazy-fetched on
                      expand. Empty state shows a single ADD button.
                      Active clients render first, then inactive; within
                      each group sort is alphabetical by email. */}
                  <div>
                    <p className="text-gray-500 text-xs tracking-widest mb-2">CLIENTS AT THIS SITE</p>
                    {(() => {
                      const list = clientsPerSite[site.id];
                      if (list === undefined) {
                        return <p className="text-gray-600 text-xs">Loading…</p>;
                      }
                      if (list.length === 0) {
                        return (
                          <div className="space-y-2">
                            <p className="text-gray-600 text-xs">No clients configured for this site yet.</p>
                            <button
                              onClick={() => openAddClientModal(site.id)}
                              disabled={isDeactivated}
                              className="text-xs text-amber-400 tracking-widest border border-amber-400/40 rounded px-3 py-1.5 hover:bg-amber-400/10 hover:border-amber-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              + ADD CLIENT
                            </button>
                          </div>
                        );
                      }
                      return (
                        <div className="space-y-2">
                          {list.map((c) => (
                            <div key={c.id}
                              className={`bg-[#0F1E35] border border-[#1A3050] rounded-lg px-3 py-2 flex items-center gap-3 flex-wrap ${!c.is_active ? 'opacity-60' : ''}`}>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-gray-200 font-medium text-sm truncate">{c.email}</span>
                                  {c.is_active ? (
                                    <span className="text-[10px] tracking-widest text-green-400 bg-green-400/10 border border-green-400/30 px-1.5 py-0.5 rounded">ACTIVE</span>
                                  ) : (
                                    <span className="text-[10px] tracking-widest text-red-400 bg-red-400/10 border border-red-400/30 px-1.5 py-0.5 rounded">INACTIVE</span>
                                  )}
                                </div>
                                <p className="text-gray-500 text-xs mt-0.5 truncate">
                                  {c.name} <span className="text-gray-600">·</span> Last login: {relativeTime(c.last_login_at)}
                                </p>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <button
                                  onClick={() => openEditClientModal(site.id, c)}
                                  disabled={isDeactivated}
                                  className="text-xs text-gray-400 hover:text-amber-400 tracking-widest disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  EDIT
                                </button>
                                <button
                                  onClick={() => toggleClientActive(c, site.id)}
                                  disabled={clientToggling === c.id || isDeactivated}
                                  className={`text-xs tracking-widest disabled:opacity-40 disabled:cursor-not-allowed ${
                                    c.is_active
                                      ? 'text-red-400 hover:text-red-300'
                                      : 'text-green-400 hover:text-green-300'
                                  }`}
                                >
                                  {clientToggling === c.id ? '…' : c.is_active ? 'DEACTIVATE' : 'REACTIVATE'}
                                </button>
                              </div>
                            </div>
                          ))}
                          <button
                            onClick={() => openAddClientModal(site.id)}
                            disabled={isDeactivated}
                            className="text-xs text-amber-400 tracking-widest border border-amber-400/40 rounded px-3 py-1.5 hover:bg-amber-400/10 hover:border-amber-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            + ADD CLIENT
                          </button>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Session S6 — SCHEDULING PROFILES. Lazy-fetched with
                      clients on expand. Shows one row per profile with an
                      active/inactive pill, summary line, and EDIT / toggle /
                      delete controls. Coverage summary at bottom lights up
                      only when an active profile exists AND the coverage
                      status is loaded. */}
                  <div>
                    <p className="text-gray-500 text-xs tracking-widest mb-2">SCHEDULING PROFILES</p>
                    {(() => {
                      const list = profilesPerSite[site.id];
                      if (list === undefined) return <p className="text-gray-600 text-xs">Loading…</p>;
                      const activeProfile = list.find((p) => p.is_active);
                      const cov = coveragePerSite[site.id];
                      if (list.length === 0) {
                        return (
                          <div className="space-y-2">
                            <p className="text-gray-600 text-xs">No scheduling profile configured for this site.</p>
                            <button
                              onClick={() => openCreateProfileModal(site.id)}
                              disabled={isDeactivated}
                              className="text-xs text-amber-400 tracking-widest border border-amber-400/40 rounded px-3 py-1.5 hover:bg-amber-400/10 hover:border-amber-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              + CREATE PROFILE
                            </button>
                          </div>
                        );
                      }
                      return (
                        <div className="space-y-2">
                          {list.map((p) => {
                            const activeShifts = p.shifts.filter((s) => s.active);
                            const shiftsWeek   = activeShifts.length;
                            const hoursWeek    = activeShifts.reduce((s, sh) => s + Number(sh.shift_length_hours), 0);
                            const guardsWeek   = activeShifts.reduce((s, sh) => s + sh.guards_needed, 0);
                            const daysCovered  = new Set(activeShifts.map((s) => s.day_of_week)).size;
                            return (
                              <div key={p.id}
                                className={`bg-[#0F1E35] border border-[#1A3050] rounded-lg px-3 py-2 ${!p.is_active ? 'opacity-70' : ''}`}>
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-gray-200 font-medium text-sm">{p.profile_name}</span>
                                  {p.is_active ? (
                                    <span className="text-[10px] tracking-widest text-green-400 bg-green-400/10 border border-green-400/30 px-1.5 py-0.5 rounded">ACTIVE</span>
                                  ) : (
                                    <span className="text-[10px] tracking-widest text-gray-500 bg-gray-500/10 border border-gray-500/30 px-1.5 py-0.5 rounded">INACTIVE</span>
                                  )}
                                  <div className="ml-auto flex items-center gap-2 shrink-0">
                                    <button
                                      onClick={() => openEditProfileModal(site.id, p)}
                                      disabled={isDeactivated}
                                      className="text-xs text-gray-400 hover:text-amber-400 tracking-widest disabled:opacity-40"
                                    >
                                      EDIT
                                    </button>
                                    <button
                                      onClick={() => toggleProfileActive(p, site.id)}
                                      disabled={profileToggling === p.id || isDeactivated}
                                      className={`text-xs tracking-widest disabled:opacity-40 ${
                                        p.is_active ? 'text-gray-400 hover:text-gray-200' : 'text-green-400 hover:text-green-300'
                                      }`}
                                    >
                                      {profileToggling === p.id ? '…' : p.is_active ? 'DEACTIVATE' : 'ACTIVATE'}
                                    </button>
                                    <button
                                      onClick={() => deleteProfile(p, site.id)}
                                      disabled={isDeactivated}
                                      className="text-xs text-red-400 hover:text-red-300 tracking-widest disabled:opacity-40"
                                    >
                                      DELETE
                                    </button>
                                  </div>
                                </div>
                                <p className="text-gray-500 text-xs mt-1">
                                  {shiftsWeek} shift{shiftsWeek === 1 ? '' : 's'}/week · {daysCovered} day{daysCovered === 1 ? '' : 's'} covered ·{' '}
                                  {hoursWeek.toFixed(hoursWeek % 1 === 0 ? 0 : 1)}h coverage ·{' '}
                                  {guardsWeek} guard{guardsWeek === 1 ? '' : 's'} needed/week
                                </p>
                              </div>
                            );
                          })}
                          <button
                            onClick={() => openCreateProfileModal(site.id)}
                            disabled={isDeactivated}
                            className="text-xs text-amber-400 tracking-widest border border-amber-400/40 rounded px-3 py-1.5 hover:bg-amber-400/10 hover:border-amber-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            + CREATE PROFILE
                          </button>
                          {activeProfile && cov && (
                            <div className="mt-2 flex items-center gap-3 flex-wrap text-xs">
                              <span className="text-gray-500 tracking-widest">COVERAGE NEXT 2 WEEKS</span>
                              <span className="text-gray-300 font-mono">{cov.scheduled} / {cov.required} scheduled</span>
                              {cov.gaps > 0 ? (
                                <span className="text-red-400 tracking-widest text-[11px] bg-red-500/10 border border-red-500/40 px-2 py-0.5 rounded">
                                  ⚠ {cov.gaps} shift{cov.gaps === 1 ? '' : 's'} unassigned
                                </span>
                              ) : (
                                <span className="text-green-400 tracking-widest text-[11px] bg-green-500/10 border border-green-500/40 px-2 py-0.5 rounded">
                                  ✓ Fully covered
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>

                  {/* FIX 1: DEACTIVATE SITE — its own section, destructive red,
                      only shown for active sites. Reactivate is handled inside
                      CLIENT PORTAL above. */}
                  {!isDeactivated && (
                    <div className="pt-3 border-t border-[#1A3050]">
                      <p className="text-gray-500 text-xs tracking-widest mb-2">SITE STATUS</p>
                      <button
                        onClick={() => openDeactivate(site)}
                        className="text-xs tracking-widest px-3 py-1.5 rounded bg-red-500/10 text-red-400 border border-red-500/40 hover:bg-red-500/20 hover:border-red-500 transition-colors"
                      >
                        ⚠ DEACTIVATE SITE
                      </button>
                      <p className="text-gray-600 text-[10px] mt-1">Cancels future shifts, closes client portal, marks the site inactive. History stays visible.</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Create Site Modal ─────────────────────────────────────────── */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">NEW SITE</h2>
              <button onClick={() => { setShowCreate(false); setGeoLookup({ status: 'idle' }); }} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            {formError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{formError}</div>}
            <div className="space-y-4">
              {/* NAME */}
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">SITE NAME <span className="text-amber-400">*</span></label>
                <input
                  type="text" placeholder="e.g. Westfield Shopping Centre"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                />
              </div>

              {/* ADDRESS — FIX 4: geocode on blur; status shown inline below */}
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">ADDRESS <span className="text-amber-400">*</span></label>
                <input
                  type="text" placeholder="Full address"
                  value={form.address}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, address: e.target.value }));
                    // Any edit invalidates the last lookup — force a re-geocode on next blur.
                    setGeoLookup({ status: 'idle' });
                  }}
                  onBlur={lookupAddress}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                />
                {geoLookup.status === 'loading' && (
                  <p className="text-gray-500 text-xs mt-1">Looking up coordinates…</p>
                )}
                {geoLookup.status === 'ok' && (
                  <p className="text-green-400 text-xs mt-1">
                    ✓ Coordinates found: {geoLookup.lat.toFixed(5)}, {geoLookup.lng.toFixed(5)}
                    <span className="text-gray-500"> — {geoLookup.formatted_address}</span>
                  </p>
                )}
                {geoLookup.status === 'error' && (
                  <p className="text-amber-400/80 text-xs mt-1">
                    {geoLookup.message} You can still create the site and set the geofence manually.
                  </p>
                )}
              </div>

              {/* CONTRACT START */}
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">CONTRACT START <span className="text-amber-400">*</span></label>
                <input
                  type="date"
                  value={form.contract_start}
                  onChange={(e) => setForm((f) => ({ ...f, contract_start: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                />
              </div>

              {/* TIMEZONE — CONTRACT END field removed per FIX 2 */}
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">
                  TIMEZONE <span className="text-amber-400">*</span>
                </label>
                <select
                  value={form.timezone}
                  onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                >
                  {TIMEZONE_OPTIONS.map((tz) => (
                    <option key={tz.value} value={tz.value}>{tz.label}</option>
                  ))}
                </select>
                <p className="text-gray-500 text-xs mt-1">Used for shift-time display, breach/report/missed-shift emails, and daily reports.</p>
              </div>
            </div>
            <div className="mt-4">
              <label className="block text-gray-500 text-xs tracking-widest mb-1">
                SITE INSTRUCTIONS <span className="text-gray-600 text-xs normal-case">(PDF, optional)</span>
              </label>
              <input
                type="file" accept="application/pdf,.pdf"
                onChange={(e) => setPdfFile(e.target.files?.[0] ?? null)}
                className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400 file:mr-3 file:bg-amber-400 file:text-gray-900 file:border-0 file:rounded file:px-3 file:py-1 file:text-xs file:font-bold file:cursor-pointer"
              />
              {pdfFile && <p className="text-gray-400 text-xs mt-1">Selected: {pdfFile.name}</p>}
            </div>
            <p className="text-gray-500 text-xs mt-3 mb-5">
              <span className="text-amber-400/70">You can set the geofence boundary after creating the site.</span>
            </p>
            <div className="flex gap-3">
              <button onClick={() => { setShowCreate(false); setGeoLookup({ status: 'idle' }); }} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
              <button onClick={createSite} disabled={saving} className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors">
                {saving ? 'CREATING…' : 'CREATE SITE'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── PDF Instructions Modal ───────────────────────────────────── */}
      {pdfSite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">SITE INSTRUCTIONS</h2>
              <button onClick={() => setPdfSite(null)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            <p className="text-gray-500 text-xs mb-4">Site: <span className="text-gray-300">{pdfSite.name}</span></p>

            {pdfSite.instructions_pdf_url && (
              <div className="bg-[#0B1526] border border-[#1A3050] rounded-lg p-3 mb-4">
                <p className="text-gray-400 text-xs mb-1">Current instructions PDF:</p>
                <a href={pdfSite.instructions_pdf_url} target="_blank" rel="noopener noreferrer"
                   className="text-cyan-400 text-sm underline break-all">
                  View instructions.pdf ↗
                </a>
              </div>
            )}

            {pdfError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{pdfError}</div>}

            <div className="mb-5">
              <label className="block text-gray-500 text-xs tracking-widest mb-1">
                {pdfSite.instructions_pdf_url ? 'REPLACE PDF' : 'UPLOAD PDF'} <span className="text-amber-400">*</span>
              </label>
              <input ref={pdfInputRef} type="file" accept="application/pdf,.pdf"
                onChange={(e) => setReplacePdf(e.target.files?.[0] ?? null)}
                className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400 file:mr-3 file:bg-amber-400 file:text-gray-900 file:border-0 file:rounded file:px-3 file:py-1 file:text-xs file:font-bold file:cursor-pointer"
              />
              {replacePdf && <p className="text-gray-400 text-xs mt-1">Selected: {replacePdf.name}</p>}
            </div>

            <div className="flex gap-3">
              <button onClick={() => setPdfSite(null)} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
              <button onClick={savePdf} disabled={pdfSaving || !replacePdf} className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors">
                {pdfSaving ? 'UPLOADING…' : 'UPLOAD PDF'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Set Geofence Modal ──────────────────────────────────────────
          FIX 3: DRAW mode uses a two-column layout on md+ — left column
          holds instructions + inputs + preview, right column holds the
          map and its vertex counter. RADIUS mode has no map, so it stays
          single-column. Mobile falls back to a single-column stack for
          both modes. Modal width jumps from max-w-3xl → max-w-6xl to
          accommodate the split. */}
      {geoSite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 overflow-y-auto py-8">
          <div className="w-full max-w-6xl bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">SET GEOFENCE</h2>
              <button onClick={() => setGeoSite(null)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            <p className="text-gray-500 text-xs mb-4">
              Site: <span className="text-gray-300">{geoSite.name}</span>
            </p>

            <div className="flex gap-2 mb-5" role="radiogroup" aria-label="Geofence mode">
              <button
                type="button"
                role="radio"
                aria-checked={geoMode === 'radius'}
                onClick={() => setGeoMode('radius')}
                className={`flex-1 px-4 py-2 rounded-lg text-xs tracking-widest border transition-colors ${
                  geoMode === 'radius'
                    ? 'bg-amber-400 text-gray-900 border-amber-400 font-bold'
                    : 'bg-[#0B1526] text-gray-400 border-[#1A3050] hover:border-amber-400/50'
                }`}
              >
                RADIUS (CURRENT)
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={geoMode === 'draw'}
                onClick={() => setGeoMode('draw')}
                className={`flex-1 px-4 py-2 rounded-lg text-xs tracking-widest border transition-colors ${
                  geoMode === 'draw'
                    ? 'bg-amber-400 text-gray-900 border-amber-400 font-bold'
                    : 'bg-[#0B1526] text-gray-400 border-[#1A3050] hover:border-amber-400/50'
                }`}
              >
                DRAW BOUNDARY
              </button>
            </div>

            {geoMode === 'radius' ? (
              // Single-column layout for RADIUS mode — no map to place.
              <div className="space-y-4">
                {/* Session A2 — address search bar. Auto-fills LATITUDE +
                    LONGITUDE inputs on success. RECENTER button is
                    map-specific → not shown here (RADIUS has no map). */}
                <div>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">SEARCH ADDRESS</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={geoSearchInput}
                      placeholder="Type address, landmark, or place…"
                      onChange={(e) => setGeoSearchInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); searchGeofenceAddress(); } }}
                      className="flex-1 bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                    />
                    <button
                      type="button"
                      onClick={searchGeofenceAddress}
                      disabled={geoSearchStatus === 'loading' || geoSearchInput.trim().length < 3}
                      aria-label="Search address"
                      className="bg-[#0B1526] border border-[#1A3050] text-gray-400 hover:border-amber-400 hover:text-amber-400 rounded-lg px-3 py-2 text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      🔍
                    </button>
                  </div>
                  {geoSearchStatus === 'loading' && <p className="text-gray-500 text-xs mt-1">Searching…</p>}
                  {geoSearchStatus === 'ok' && geoSearchResult && (
                    <p className="text-green-400 text-xs mt-1">✓ Found: <span className="text-gray-300">{geoSearchResult.formatted_address}</span></p>
                  )}
                  {geoSearchStatus === 'error' && (
                    <p className="text-amber-400/80 text-xs mt-1">{mapGeoSearchError(geoSearchError)}</p>
                  )}
                </div>

                <div className="bg-[#0B1526] border border-[#1A3050] rounded-lg p-4 text-xs text-gray-400 space-y-1">
                  <p className="text-amber-400 font-bold tracking-widest mb-2">HOW TO GET COORDINATES</p>
                  <p>1. Open <span className="text-white">Google Maps</span> and search for the site address.</p>
                  <p>2. Right-click on the exact centre of the building/property.</p>
                  <p>3. Click the coordinates that appear at the top of the menu — they are copied automatically.</p>
                  <p>4. Paste them below (they look like: <span className="text-white font-mono">37.7749, -122.4194</span>).</p>
                  <p className="pt-1">Set the radius to cover the full property boundary — e.g. <span className="text-white">50m</span> for a small building, <span className="text-white">200m</span> for a large campus.</p>
                </div>

                {geoError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2">{geoError}</div>}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-gray-500 text-xs tracking-widest mb-1">LATITUDE <span className="text-amber-400">*</span></label>
                    <input
                      type="number" step="any" placeholder="e.g. 37.7749"
                      value={geo.center_lat}
                      onChange={(e) => setGeo((g) => ({ ...g, center_lat: e.target.value }))}
                      className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                    />
                  </div>
                  <div>
                    <label className="block text-gray-500 text-xs tracking-widest mb-1">LONGITUDE <span className="text-amber-400">*</span></label>
                    <input
                      type="number" step="any" placeholder="e.g. -122.4194"
                      value={geo.center_lng}
                      onChange={(e) => setGeo((g) => ({ ...g, center_lng: e.target.value }))}
                      className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">RADIUS (METRES) <span className="text-amber-400">*</span></label>
                  <input
                    type="number" min="10" max="10000" placeholder="e.g. 100"
                    value={geo.radius_meters}
                    onChange={(e) => setGeo((g) => ({ ...g, radius_meters: e.target.value }))}
                    className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                  />
                  <p className="text-gray-600 text-xs mt-1">
                    Guards outside this radius will trigger a geofence violation alert. A 16-point circular boundary is auto-generated from your centre + radius.
                  </p>
                </div>

                {geo.center_lat && geo.center_lng && geo.radius_meters && (
                  <div className="bg-[#0B1526] border border-amber-400/30 rounded-lg p-3 text-xs text-gray-400">
                    <p className="text-amber-400 font-bold tracking-widest mb-1">PREVIEW</p>
                    <p>Centre: <span className="text-white font-mono">{geo.center_lat}, {geo.center_lng}</span></p>
                    <p>Boundary radius: <span className="text-white">{geo.radius_meters}m</span>
                      {Number(geo.radius_meters) > 0 && (
                        <span className="ml-2 text-gray-500">
                          (~{(Number(geo.radius_meters) * 2).toFixed(0)}m diameter)
                        </span>
                      )}
                    </p>
                    <a
                      href={`https://www.google.com/maps?q=${geo.center_lat},${geo.center_lng}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-amber-400 underline mt-1 inline-block"
                    >
                      Verify on Google Maps ↗
                    </a>
                  </div>
                )}
              </div>
            ) : (
              // Two-halves for DRAW mode on md+; single-column below.
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* LEFT half — instructions + inputs + preview */}
                <div className="space-y-4">
                  {/* Session A2 — address search bar. Auto-fills LATITUDE +
                      LONGITUDE inputs AND flies the map to the result. Once
                      a result is captured, a "RECENTER MAP" button lets the
                      admin jump the viewport back to the searched address
                      after they've panned around. */}
                  <div>
                    <label className="block text-gray-500 text-xs tracking-widest mb-1">SEARCH ADDRESS</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={geoSearchInput}
                        placeholder="Type address, landmark, or place…"
                        onChange={(e) => setGeoSearchInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); searchGeofenceAddress(); } }}
                        className="flex-1 bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                      />
                      <button
                        type="button"
                        onClick={searchGeofenceAddress}
                        disabled={geoSearchStatus === 'loading' || geoSearchInput.trim().length < 3}
                        aria-label="Search address"
                        className="bg-[#0B1526] border border-[#1A3050] text-gray-400 hover:border-amber-400 hover:text-amber-400 rounded-lg px-3 py-2 text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        🔍
                      </button>
                    </div>
                    {geoSearchStatus === 'loading' && <p className="text-gray-500 text-xs mt-1">Searching…</p>}
                    {geoSearchStatus === 'ok' && geoSearchResult && (
                      <p className="text-green-400 text-xs mt-1">✓ Found: <span className="text-gray-300">{geoSearchResult.formatted_address}</span></p>
                    )}
                    {geoSearchStatus === 'error' && (
                      <p className="text-amber-400/80 text-xs mt-1">{mapGeoSearchError(geoSearchError)}</p>
                    )}
                    {geoSearchStatus === 'ok' && geoSearchResult && (
                      <button
                        type="button"
                        onClick={recenterMapOnSearch}
                        className="mt-2 text-xs text-amber-400 tracking-widest hover:text-amber-300 underline"
                      >
                        RECENTER MAP ON THIS ADDRESS
                      </button>
                    )}
                  </div>

                  {/* Dismissable warning when a search fires after a polygon
                      is already drawn — the drawing may now be off-centre. */}
                  {geoSearchStatus === 'ok' && drawnPolygon.length >= 3 && !polygonOffsetWarnDismissed && (
                    <div className="bg-amber-400/10 border border-amber-400/40 rounded-lg px-3 py-2 flex items-start gap-2">
                      <span className="text-amber-400 text-sm leading-tight">⚠</span>
                      <span className="text-amber-300 text-xs flex-1 leading-tight">Polygon is no longer centered on the new address — redraw if needed.</span>
                      <button
                        type="button"
                        onClick={() => setPolygonOffsetWarnDismissed(true)}
                        aria-label="Dismiss warning"
                        className="text-amber-400 hover:text-amber-200 text-sm leading-tight"
                      >✕</button>
                    </div>
                  )}

                  <div className="bg-[#0B1526] border border-[#1A3050] rounded-lg p-4 text-xs text-gray-400 space-y-1">
                    <p className="text-amber-400 font-bold tracking-widest mb-2">HOW TO DRAW</p>
                    <p>1. Use the polygon tool in the map to click each corner of the property.</p>
                    <p>2. Click the first point again to close the boundary.</p>
                    <p>3. Drag the vertices to adjust. Use the edit/delete tools to revise.</p>
                    <p className="pt-1">Centre and radius auto-fill from your drawing — you can override them. Radius is the GPS-drift fallback if the polygon ever loads incorrectly on a guard's device.</p>
                  </div>

                  {geoError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2">{geoError}</div>}

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-gray-500 text-xs tracking-widest mb-1">LATITUDE <span className="text-amber-400">*</span></label>
                      <input
                        type="number" step="any" placeholder="e.g. 37.7749"
                        value={geo.center_lat}
                        onChange={(e) => setGeo((g) => ({ ...g, center_lat: e.target.value }))}
                        className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                      />
                    </div>
                    <div>
                      <label className="block text-gray-500 text-xs tracking-widest mb-1">LONGITUDE <span className="text-amber-400">*</span></label>
                      <input
                        type="number" step="any" placeholder="e.g. -122.4194"
                        value={geo.center_lng}
                        onChange={(e) => setGeo((g) => ({ ...g, center_lng: e.target.value }))}
                        className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-gray-500 text-xs tracking-widest mb-1">RADIUS (METRES) <span className="text-amber-400">*</span></label>
                    <input
                      type="number" min="10" max="10000" placeholder="e.g. 100"
                      value={geo.radius_meters}
                      onChange={(e) => setGeo((g) => ({ ...g, radius_meters: e.target.value }))}
                      className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                    />
                    <p className="text-gray-600 text-xs mt-1">
                      Radius is the GPS-drift fallback — guards inside the polygon OR within this radius are considered on-post.
                    </p>
                  </div>

                  {geo.center_lat && geo.center_lng && geo.radius_meters && (
                    <div className="bg-[#0B1526] border border-amber-400/30 rounded-lg p-3 text-xs text-gray-400">
                      <p className="text-amber-400 font-bold tracking-widest mb-1">PREVIEW</p>
                      <p>Centre: <span className="text-white font-mono">{geo.center_lat}, {geo.center_lng}</span></p>
                      <p>Boundary radius: <span className="text-white">{geo.radius_meters}m</span>
                        {Number(geo.radius_meters) > 0 && (
                          <span className="ml-2 text-gray-500">
                            (~{(Number(geo.radius_meters) * 2).toFixed(0)}m diameter)
                          </span>
                        )}
                      </p>
                      <p>Polygon: <span className="text-white">{drawnPolygon.length} vertices</span></p>
                      <a
                        href={`https://www.google.com/maps?q=${geo.center_lat},${geo.center_lng}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-amber-400 underline mt-1 inline-block"
                      >
                        Verify on Google Maps ↗
                      </a>
                    </div>
                  )}
                </div>

                {/* RIGHT half — map + vertex count */}
                <div>
                  <GeofenceMapEditor
                    initialPolygon={drawnPolygon}
                    initialCentre={
                      geoSite.center_lat != null && geoSite.center_lng != null
                        ? { lat: geoSite.center_lat, lng: geoSite.center_lng }
                        : null
                    }
                    centreOverride={
                      geo.center_lat && geo.center_lng && !isNaN(parseFloat(geo.center_lat)) && !isNaN(parseFloat(geo.center_lng))
                        ? { lat: parseFloat(geo.center_lat), lng: parseFloat(geo.center_lng) }
                        : null
                    }
                    focusPoint={focusPoint}
                    onChange={handlePolygonChange}
                  />
                  <p className="text-gray-600 text-xs mt-1">
                    Vertices: <span className="text-gray-300">{drawnPolygon.length}</span>
                    {drawnPolygon.length > 0 && drawnPolygon.length < 3 && (
                      <span className="text-red-400 ml-2">need ≥ 3</span>
                    )}
                    {drawnPolygon.length >= 4 && isSelfIntersecting(drawnPolygon) && (
                      <span className="text-red-400 ml-2">edges cross — re-draw</span>
                    )}
                  </p>
                </div>
              </div>
            )}

            <div className="flex gap-3 mt-6">
              <button onClick={() => setGeoSite(null)} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
              <button onClick={saveGeofence} disabled={geoSaving} className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors">
                {geoSaving ? 'SAVING…' : 'SAVE GEOFENCE'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Deactivate Site Modal ────────────────────────────────────── */}
      {deactivateSite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md bg-[#0F1E35] border border-red-700/50 rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-red-400 font-bold tracking-widest text-lg">DEACTIVATE SITE</h2>
              <button onClick={() => { setDeactivateSite(null); setDeactivatePreview(null); setDeactivateError(''); }} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            <p className="text-gray-400 text-xs mb-1">Site</p>
            <p className="text-gray-200 font-medium mb-4">{deactivateSite.name}</p>

            {!deactivatePreview && !deactivateError && (
              <p className="text-gray-500 text-sm mb-4">Loading preview…</p>
            )}

            {deactivateError && (
              <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{deactivateError}</div>
            )}

            {deactivatePreview && (
              <>
                <div className="bg-[#0B1526] border border-[#1A3050] rounded-lg p-4 mb-4 space-y-2">
                  <p className="text-gray-500 text-xs tracking-widest mb-2">WHAT WILL HAPPEN</p>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Future shifts to cancel</span>
                    <span className="text-gray-200 font-mono">{deactivatePreview.scheduled_shifts}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Active guard sessions</span>
                    <span className="text-gray-200 font-mono">{deactivatePreview.active_sessions}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Open guard assignments to close</span>
                    <span className="text-gray-200 font-mono">{deactivatePreview.open_assignments}</span>
                  </div>
                </div>
                <p className="text-gray-500 text-xs mb-4 leading-relaxed">
                  Client portal access will be disabled. Historical rows (shift
                  sessions, reports, hours, billing) stay intact and continue to
                  appear with an <span className="text-gray-400">[INACTIVE]</span> label.
                  Active guard sessions are not interrupted — they finish
                  normally.
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={() => { setDeactivateSite(null); setDeactivatePreview(null); }}
                    className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors"
                  >
                    BACK
                  </button>
                  <button
                    onClick={confirmDeactivate}
                    disabled={deactivateBusy}
                    className="flex-1 bg-red-500 text-white font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-red-400 disabled:opacity-40 transition-colors"
                  >
                    {deactivateBusy
                      ? 'DEACTIVATING…'
                      : deactivatePreview.scheduled_shifts > 0
                        ? 'CANCEL SHIFTS + DEACTIVATE'
                        : 'DEACTIVATE'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Session C — Add / Edit Client Modal ─────────────────────────── */}
      {clientModalMode !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">
                {clientModalMode === 'add' ? 'ADD CLIENT' : 'EDIT CLIENT'}
              </h2>
              <button onClick={closeClientModal} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            {clientFormError && (
              <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{clientFormError}</div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">FULL NAME <span className="text-amber-400">*</span></label>
                <input
                  type="text" placeholder="e.g. Property Manager"
                  value={clientForm.name}
                  onChange={(e) => setClientForm((f) => ({ ...f, name: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                />
              </div>

              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">EMAIL <span className="text-amber-400">*</span></label>
                <input
                  type="email" placeholder="e.g. owner@property.com"
                  value={clientForm.email}
                  onChange={(e) => setClientForm((f) => ({ ...f, email: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                />
                {clientModalMode === 'edit' && editingClient && clientForm.email.trim().toLowerCase() !== editingClient.email && (
                  <p className="text-amber-400/80 text-xs mt-1">
                    Changing email will require the client to log in with the new address.
                  </p>
                )}
              </div>

              {clientModalMode === 'add' && (
                <div>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">TEMPORARY PASSWORD <span className="text-amber-400">*</span></label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={clientForm.password}
                      className="flex-1 bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm font-mono focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={regenerateTempPassword}
                      title="Regenerate"
                      aria-label="Regenerate password"
                      className="bg-[#0B1526] border border-[#1A3050] text-gray-400 hover:border-amber-400 hover:text-amber-400 rounded-lg px-3 py-2 text-sm transition-colors"
                    >
                      🔄
                    </button>
                  </div>
                  <p className="text-gray-500 text-xs mt-1">Client will be prompted to change on first login.</p>
                </div>
              )}

              {clientModalMode === 'edit' && (
                <div>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">PASSWORD</label>
                  <button
                    type="button"
                    onClick={resetClientPassword}
                    disabled={clientSaving}
                    className="text-xs text-cyan-400 tracking-widest border border-cyan-500/40 rounded px-3 py-1.5 hover:bg-cyan-500/10 hover:border-cyan-500 transition-colors disabled:opacity-40"
                  >
                    RESET PASSWORD
                  </button>
                  <p className="text-gray-500 text-xs mt-1">Generates a new temp password and ends the client's current session.</p>
                </div>
              )}
            </div>

            <p className="text-gray-500 text-xs mt-4 mb-5 leading-relaxed">
              Portal URL: <span className="font-mono text-gray-300">https://netraops.com/portal</span><br />
              Client uses their email address to log in.
            </p>

            <div className="flex gap-3">
              <button
                onClick={closeClientModal}
                className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors"
              >
                CANCEL
              </button>
              <button
                onClick={clientModalMode === 'add' ? saveNewClient : saveEditedClient}
                disabled={clientSaving}
                className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors"
              >
                {clientSaving ? 'SAVING…' : clientModalMode === 'add' ? 'ADD CLIENT' : 'SAVE'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Session S6 — Create / Edit Scheduling Profile Modal ─────────── */}
      {profileModalMode !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 overflow-y-auto py-8">
          <div className="w-full max-w-3xl bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">
                {profileModalMode === 'create' ? 'CREATE PROFILE' : 'EDIT PROFILE'}
              </h2>
              <button onClick={closeProfileModal} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            {profileFormError && (
              <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{profileFormError}</div>
            )}

            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
                <div>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">PROFILE NAME <span className="text-amber-400">*</span></label>
                  <input
                    type="text" placeholder="e.g. Regular, Holiday, Special Event"
                    value={profileForm.profile_name}
                    onChange={(e) => setProfileForm((f) => ({ ...f, profile_name: e.target.value }))}
                    className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                  />
                </div>
                <label className="flex items-center gap-2 text-xs tracking-widest text-gray-400 select-none cursor-pointer min-h-[40px]">
                  <input
                    type="checkbox" className="accent-amber-400 w-4 h-4"
                    checked={profileForm.is_active}
                    onChange={(e) => setProfileForm((f) => ({ ...f, is_active: e.target.checked }))}
                  />
                  SET AS ACTIVE
                </label>
              </div>

              <div>
                <p className="text-gray-500 text-xs tracking-widest mb-2">WEEKLY SHIFT PATTERN</p>
                <div className="bg-[#0B1526] border border-[#1A3050] rounded-lg p-3 space-y-3">
                  {DAY_NAMES.map((dayName, dow) => {
                    const dayShifts = profileForm.shifts
                      .map((s, i) => ({ s, i }))
                      .filter(({ s }) => s.day_of_week === dow);
                    return (
                      <div key={dow} className="border-b border-[#1A3050] last:border-b-0 pb-3 last:pb-0">
                        <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                          <span className="text-gray-300 text-xs font-bold tracking-widest w-24 shrink-0">
                            {dayName.toUpperCase()}
                          </span>
                          <div className="flex items-center gap-2 flex-wrap ml-auto">
                            <button
                              type="button"
                              onClick={() => addShiftToDay(dow)}
                              className="text-[11px] text-amber-400 tracking-widest border border-amber-400/40 rounded px-2 py-0.5 hover:bg-amber-400/10 hover:border-amber-400 transition-colors"
                            >
                              + Add shift
                            </button>
                            {dow === 1 && dayShifts.length > 0 && (
                              <button
                                type="button"
                                onClick={copyMondayToWeekdays}
                                className="text-[11px] text-cyan-400 tracking-widest border border-cyan-500/40 rounded px-2 py-0.5 hover:bg-cyan-500/10 transition-colors"
                              >
                                Copy to Tue-Fri
                              </button>
                            )}
                            {dow > 0 && (
                              <button
                                type="button"
                                onClick={() => copyFromPreviousDay(dow)}
                                className="text-[11px] text-gray-400 tracking-widest border border-[#1A3050] rounded px-2 py-0.5 hover:border-gray-500 hover:text-gray-200 transition-colors"
                              >
                                Copy from {DAY_SHORT[dow - 1]}
                              </button>
                            )}
                          </div>
                        </div>
                        {dayShifts.length === 0 ? (
                          <p className="text-gray-600 text-xs italic ml-24">No shifts</p>
                        ) : (
                          <div className="space-y-1.5 ml-24">
                            {dayShifts.map(({ s, i }) => (
                              <div key={s.clientKey ?? s.id ?? i} className="flex items-center gap-2 flex-wrap">
                                <input
                                  type="time"
                                  value={s.shift_start_time.slice(0, 5)}
                                  onChange={(e) => updateShiftAt(i, { shift_start_time: e.target.value })}
                                  className="bg-[#070F1E] border border-[#1A3050] rounded px-2 py-1 text-gray-200 text-xs w-24"
                                />
                                <span className="text-gray-500 text-xs">×</span>
                                <input
                                  type="number" min="0.5" max="24" step="0.25"
                                  value={s.shift_length_hours}
                                  onChange={(e) => updateShiftAt(i, { shift_length_hours: Number(e.target.value) })}
                                  className="bg-[#070F1E] border border-[#1A3050] rounded px-2 py-1 text-gray-200 text-xs w-16"
                                />
                                <span className="text-gray-500 text-xs">h ·</span>
                                <input
                                  type="number" min="1" max="10" step="1"
                                  value={s.guards_needed}
                                  onChange={(e) => updateShiftAt(i, { guards_needed: Number(e.target.value) })}
                                  className="bg-[#070F1E] border border-[#1A3050] rounded px-2 py-1 text-gray-200 text-xs w-12"
                                />
                                <span className="text-gray-500 text-xs">guard{s.guards_needed === 1 ? '' : 's'}</span>
                                <label className="text-gray-500 text-[10px] tracking-widest inline-flex items-center gap-1 ml-1 select-none cursor-pointer">
                                  <input
                                    type="checkbox" className="accent-amber-400 w-3 h-3"
                                    checked={s.active}
                                    onChange={(e) => updateShiftAt(i, { active: e.target.checked })}
                                  />
                                  ACTIVE
                                </label>
                                <button
                                  type="button"
                                  onClick={() => removeShiftAt(i)}
                                  aria-label="Remove shift"
                                  className="ml-auto text-red-400 hover:text-red-300 text-sm px-2"
                                >
                                  ✕
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Live coverage summary */}
              <div className="bg-[#0B1526] border border-amber-400/30 rounded-lg p-3 text-xs">
                <p className="text-amber-400 font-bold tracking-widest mb-1">COVERAGE SUMMARY</p>
                <p className="text-gray-300">
                  {profileFormSummary.shiftsWeek} shift{profileFormSummary.shiftsWeek === 1 ? '' : 's'}/week ·{' '}
                  {profileFormSummary.hoursWeek.toFixed(profileFormSummary.hoursWeek % 1 === 0 ? 0 : 1)}h coverage ·{' '}
                  {profileFormSummary.guardsWeek} guard{profileFormSummary.guardsWeek === 1 ? '' : 's'} needed/week
                </p>
                <p className="text-gray-600 mt-1">
                  Overnight shifts (start + length crossing midnight) are supported — pattern is by start time only.
                </p>
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={closeProfileModal}
                className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors"
              >
                CANCEL
              </button>
              <button
                onClick={saveProfile}
                disabled={profileSaving}
                className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors"
              >
                {profileSaving ? 'SAVING…' : profileModalMode === 'create' ? 'CREATE PROFILE' : 'SAVE'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
