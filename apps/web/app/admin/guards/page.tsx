'use client';
/**
 * Admin — Guards Management (/admin/guards)
 * Alphabetical list of compact guard rows with search + status chips.
 * Rows are uniform-height; site assignments hide behind an "N sites ▾"
 * pill that expands inline. Add / assign / deactivate / per-assignment
 * edit-end-remove flows preserved from the previous table layout.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminGet, adminPost, adminPatch, adminFetch, adminDelete } from '../../../lib/adminApi';
import InactiveSiteBadge from '../../../components/InactiveSiteBadge';

interface Assignment {
  id:              string;
  site_id:         string;
  site_name:       string;
  site_is_active?: boolean;
  assigned_from:   string;
  assigned_until:  string | null;
}

interface Guard {
  id:                    string;
  name:                  string;
  email:                 string;
  badge_number:          string;
  is_active:             boolean;
  must_change_password:  boolean;
  created_at:            string;
  company_name?:         string;       // present when Vishnu view spans multiple companies
  assignments:           Assignment[] | null;
}

interface Site { id: string; name: string; }

interface ImpactReport { future_shift_count: number; sample_dates: string[] }

interface CredentialsBanner {
  email:         string;
  temp_password: string;
  email_status:  'sent' | 'failed';
}

type StatusFilter = 'active' | 'inactive' | 'all';

// Pacific calendar date as YYYY-MM-DD. Used for the date-input min and for
// the End-now button payload so both UI and server agree on "today."
function pacificTodayStr(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function fmtDateRange(from: string, until: string | null): string {
  const f = String(from).slice(0, 10);
  return until ? `From ${f} to ${String(until).slice(0, 10)}` : `From ${f} (open)`;
}

// Avatar: deterministic color from a stable string hash, so a given guard
// keeps the same swatch across reloads.
const AVATAR_COLORS = [
  'bg-amber-500', 'bg-cyan-500', 'bg-emerald-500', 'bg-fuchsia-500',
  'bg-indigo-500', 'bg-rose-500', 'bg-teal-500', 'bg-violet-500',
];
function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = ((hash * 31) + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last  = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return ((first + last) || '?').toUpperCase();
}

// Case-insensitive match across name / email / badge / any assigned site name.
function matches(g: Guard, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  if (g.name.toLowerCase().includes(s)) return true;
  if (g.email.toLowerCase().includes(s)) return true;
  if (g.badge_number.toLowerCase().includes(s)) return true;
  return !!g.assignments?.some((a) => a.site_name.toLowerCase().includes(s));
}

export default function GuardsPage() {
  const [guards,     setGuards]     = useState<Guard[]>([]);
  const [sites,      setSites]      = useState<Site[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [showAdd,    setShowAdd]    = useState(false);
  const [showAssign, setShowAssign] = useState<Guard | null>(null);
  const [form,       setForm]       = useState({ name: '', email: '', temp_password: '' });
  const [addedBadge, setAddedBadge] = useState<string | null>(null);
  const [assignForm, setAssignForm] = useState({ site_id: '', assigned_from: '', assigned_until: '' });
  const [saving,     setSaving]     = useState(false);
  const [formError,  setFormError]  = useState('');
  const [credentialsBanner, setCredentialsBanner] = useState<CredentialsBanner | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);

  // ── Redesign state (Session 2) ─────────────────────────────────────────
  const [search,       setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [expanded,     setExpanded]     = useState<Set<string>>(new Set());

  // ── Phase B modal state ────────────────────────────────────────────────
  // editAssignment: target row + the guard it belongs to + the in-flight
  // assigned_until value. removeAssignment + endNowAssignment share the
  // same shape because both call /impact first then a destructive write.
  type AssignmentContext = { guard: Guard; assignment: Assignment };
  const [editAssignment,   setEditAssignment]   = useState<AssignmentContext | null>(null);
  const [removeAssignment, setRemoveAssignment] = useState<AssignmentContext | null>(null);
  const [endNowAssignment, setEndNowAssignment] = useState<AssignmentContext | null>(null);
  const [editUntil, setEditUntil]     = useState<string>(''); // empty string = "open-ended" (null)
  const [impact,    setImpact]        = useState<ImpactReport | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [editError, setEditError]     = useState('');

  const today = pacificTodayStr();

  const load = useCallback(async () => {
    try {
      const [g, s] = await Promise.all([
        adminGet<Guard[]>('/api/guards'),
        adminGet<Site[]>('/api/sites'),
      ]);
      setGuards(g); setSites(s); setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function addGuard() {
    const { name, email, temp_password } = form;
    if (!name || !email || !temp_password) { setFormError('All fields required'); return; }
    setSaving(true); setFormError('');
    try {
      const created = await adminPost<{ badge_number: string }>('/api/guards', form);
      setShowAdd(false);
      setForm({ name: '', email: '', temp_password: '' });
      setAddedBadge(created.badge_number);
      await load();
    } catch (e: any) { setFormError(e.message); }
    finally { setSaving(false); }
  }

  async function deactivate(id: string) {
    if (!confirm('Deactivate this guard? They will no longer be able to log in.')) return;
    try { await adminFetch(`/api/guards/${id}/deactivate`, { method: 'PATCH' }); await load(); }
    catch (e: any) { setError(e.message); }
  }

  async function reactivate(id: string) {
    if (!confirm('Reactivate this guard? They will be able to log in again.')) return;
    try { await adminFetch(`/api/guards/${id}/reactivate`, { method: 'PATCH' }); await load(); }
    catch (e: any) { setError(e.message); }
  }

  async function resendWelcome(g: Guard) {
    if (!confirm(`Resend welcome email to ${g.email}? A new temporary password will be generated and the old one will stop working.`)) return;
    setResendingId(g.id);
    try {
      const r = await adminPost<{ temp_password: string; email_status: 'sent' | 'failed' }>(
        `/api/guards/${g.id}/resend-welcome`, {},
      );
      setCredentialsBanner({ email: g.email, temp_password: r.temp_password, email_status: r.email_status });
      await load();
    } catch (e: any) { setError(e?.message ?? 'Failed to resend welcome email'); }
    finally { setResendingId(null); }
  }

  function copyCredentialsToClipboard(b: CredentialsBanner) {
    const text = `Email: ${b.email}\nPassword: ${b.temp_password}`;
    navigator.clipboard?.writeText(text).catch(() => { /* ignore */ });
  }

  async function assignGuard() {
    if (!showAssign || !assignForm.site_id || !assignForm.assigned_from) { setFormError('Site and start date required'); return; }
    setSaving(true); setFormError('');
    try {
      await adminPost(`/api/guards/${showAssign.id}/assign`, assignForm);
      setShowAssign(null); setAssignForm({ site_id: '', assigned_from: '', assigned_until: '' });
      await load();
    } catch (e: any) { setFormError(e.message); }
    finally { setSaving(false); }
  }

  // ── Phase B handlers ───────────────────────────────────────────────────
  async function fetchImpact(ctx: AssignmentContext): Promise<void> {
    setImpact(null);
    setImpactLoading(true);
    try {
      const r = await adminGet<ImpactReport>(`/api/guards/${ctx.guard.id}/assignments/${ctx.assignment.id}/impact`);
      setImpact(r);
    } catch { setImpact({ future_shift_count: 0, sample_dates: [] }); }
    finally { setImpactLoading(false); }
  }

  function openEditModal(g: Guard, a: Assignment) {
    setEditAssignment({ guard: g, assignment: a });
    setEditUntil(a.assigned_until ? String(a.assigned_until).slice(0, 10) : '');
    setEditError('');
  }
  function openRemoveModal(g: Guard, a: Assignment) {
    const ctx = { guard: g, assignment: a };
    setRemoveAssignment(ctx);
    fetchImpact(ctx);
  }
  function openEndNowModal(g: Guard, a: Assignment) {
    const ctx = { guard: g, assignment: a };
    setEndNowAssignment(ctx);
    fetchImpact(ctx);
  }

  async function saveEdit() {
    if (!editAssignment) return;
    const payload = { assigned_until: editUntil ? editUntil : null };
    setSaving(true); setEditError('');
    try {
      await adminPatch(`/api/guards/${editAssignment.guard.id}/assignments/${editAssignment.assignment.id}`, payload);
      setEditAssignment(null);
      await load();
    } catch (e: any) { setEditError(e.message); }
    finally { setSaving(false); }
  }

  async function confirmEndNow() {
    if (!endNowAssignment) return;
    setSaving(true); setEditError('');
    try {
      await adminPatch(`/api/guards/${endNowAssignment.guard.id}/assignments/${endNowAssignment.assignment.id}`, { assigned_until: today });
      setEndNowAssignment(null);
      await load();
    } catch (e: any) { setEditError(e.message); }
    finally { setSaving(false); }
  }

  async function confirmRemove() {
    if (!removeAssignment) return;
    setSaving(true); setEditError('');
    try {
      await adminDelete(`/api/guards/${removeAssignment.guard.id}/assignments/${removeAssignment.assignment.id}`);
      setRemoveAssignment(null);
      await load();
    } catch (e: any) { setEditError(e.message); }
    finally { setSaving(false); }
  }

  // ── Derived: cross-company detection + filter/sort pipeline ────────────
  // showCompanyLabel: true when the response spans >1 company (Vishnu view).
  // In that case each row shows the company name inline under email. In
  // single-tenant view the field is constant and there's nothing to say.
  const showCompanyLabel = useMemo(() => {
    const set = new Set<string>();
    for (const g of guards) if (g.company_name) set.add(g.company_name);
    return set.size > 1;
  }, [guards]);

  const visible = useMemo(() => {
    const q = search.trim();
    return guards
      .filter((g) => statusFilter === 'all' ? true : statusFilter === 'active' ? g.is_active : !g.is_active)
      .filter((g) => matches(g, q))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [guards, search, statusFilter]);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const STATUS_CHIPS: StatusFilter[] = ['active', 'inactive', 'all'];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl md:text-3xl font-bold tracking-widest text-amber-400">GUARDS</h1>
        <div className="flex flex-wrap gap-3 items-center">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search guards or sites…"
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
            onClick={() => { setShowAdd(true); setFormError(''); }}
            className="bg-amber-400 text-gray-900 font-bold tracking-widest text-sm px-4 py-2 rounded-lg hover:bg-amber-300 transition-colors min-h-[40px]"
          >
            + ADD GUARD
          </button>
        </div>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      {addedBadge && (
        <div className="bg-green-900/40 border border-green-500 text-green-300 text-sm rounded-lg px-4 py-3 flex items-center justify-between">
          <span>Guard added with badge <span className="font-mono font-bold text-green-200">{addedBadge}</span>.</span>
          <button onClick={() => setAddedBadge(null)} aria-label="Dismiss"
            className="text-green-400 hover:text-green-200 text-lg leading-none">✕</button>
        </div>
      )}

      {credentialsBanner && (
        <div className={`text-sm rounded-lg px-4 py-3 flex items-start justify-between gap-3 border ${
          credentialsBanner.email_status === 'sent'
            ? 'bg-green-900/40 border-green-500 text-green-300'
            : 'bg-amber-900/40 border-amber-500 text-amber-200'
        }`}>
          <div className="min-w-0 flex-1">
            <p className={`font-medium mb-1 ${credentialsBanner.email_status === 'sent' ? 'text-green-200' : 'text-amber-100'}`}>
              {credentialsBanner.email_status === 'sent'
                ? '✅ Welcome email sent. New temp password:'
                : '⚠️ Email delivery failed — share these credentials manually:'}
            </p>
            <p className="text-sm leading-6">
              Email: <span className="font-mono font-medium">{credentialsBanner.email}</span><br />
              Password: <span className="font-mono font-bold">{credentialsBanner.temp_password}</span>
            </p>
            <p className={`text-xs mt-2 ${credentialsBanner.email_status === 'sent' ? 'text-green-400' : 'text-amber-300'}`}>
              Guard will be required to change this password on first login.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => copyCredentialsToClipboard(credentialsBanner)}
              className={`text-xs tracking-widest border rounded px-3 py-1 ${
                credentialsBanner.email_status === 'sent'
                  ? 'text-green-300 hover:text-green-100 border-green-500/40 hover:bg-green-500/10'
                  : 'text-amber-200 hover:text-amber-50 border-amber-500/40 hover:bg-amber-500/10'
              }`}
            >
              COPY
            </button>
            <button
              onClick={() => setCredentialsBanner(null)}
              aria-label="Dismiss"
              className={`text-lg leading-none ${credentialsBanner.email_status === 'sent' ? 'text-green-400 hover:text-green-200' : 'text-amber-300 hover:text-amber-100'}`}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Desktop list */}
      <div className="hidden md:block bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
        {loading && <p className="p-8 text-center text-gray-500">Loading…</p>}
        {!loading && visible.length === 0 && (
          <p className="p-8 text-center text-gray-500">No guards match your criteria.</p>
        )}
        {!loading && visible.map((g) => {
          const isExpanded = expanded.has(g.id);
          const sitesCount = g.assignments?.length ?? 0;
          const first3    = g.assignments?.slice(0, 3).map((a) => a.site_name).join(', ') ?? '';
          const tooltip   = sitesCount === 0
            ? 'No sites assigned'
            : sitesCount > 3
              ? `${first3}, +${sitesCount - 3} more`
              : first3;
          return (
            <div key={g.id} className={`border-b border-[#1A3050] last:border-b-0 ${!g.is_active ? 'opacity-60' : ''}`}>
              {/* Collapsed row — uniform height regardless of assignment count */}
              <div className="grid grid-cols-[auto_minmax(0,1fr)_120px_140px_100px_auto] items-center gap-4 px-4 py-3 hover:bg-[#0B1526] transition-colors">
                {/* Avatar */}
                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0 ${avatarColor(g.id)}`}>
                  {initials(g.name)}
                </div>
                {/* Name + email + optional company */}
                <div className="min-w-0">
                  <p className="text-gray-200 font-medium truncate">{g.name}</p>
                  <p className="text-gray-500 text-xs truncate">
                    {g.email}
                    {showCompanyLabel && g.company_name && (
                      <span className="text-gray-600 ml-2">· {g.company_name}</span>
                    )}
                  </p>
                </div>
                {/* Badge */}
                <span className="text-gray-400 font-mono text-xs">{g.badge_number}</span>
                {/* Sites pill */}
                <button
                  onClick={() => sitesCount > 0 && toggleExpand(g.id)}
                  disabled={sitesCount === 0}
                  title={tooltip}
                  className={`justify-self-start px-2.5 py-1 rounded-full text-[11px] font-bold tracking-widest transition-colors ${
                    sitesCount === 0
                      ? 'bg-[#0B1526] border border-[#1A3050] text-gray-600 cursor-default'
                      : 'bg-blue-500/20 border border-blue-500/40 text-blue-300 hover:bg-blue-500/30'
                  }`}
                >
                  {sitesCount} {sitesCount === 1 ? 'SITE' : 'SITES'}{sitesCount > 0 && (isExpanded ? ' ▲' : ' ▾')}
                </button>
                {/* Status */}
                {g.is_active ? (
                  <span className="justify-self-center text-xs tracking-widest text-green-400 bg-green-400/10 border border-green-400/30 px-2 py-0.5 rounded">ACTIVE</span>
                ) : (
                  <span className="justify-self-center text-xs tracking-widest text-red-400 bg-red-400/10 border border-red-400/30 px-2 py-0.5 rounded">INACTIVE</span>
                )}
                {/* Actions */}
                <div className="flex gap-3 justify-end">
                  {g.is_active && (
                    <button onClick={() => { setShowAssign(g); setFormError(''); }} className="text-xs text-amber-400 tracking-widest hover:underline">ASSIGN</button>
                  )}
                  {g.is_active && g.must_change_password && (
                    <button
                      onClick={() => resendWelcome(g)}
                      disabled={resendingId === g.id}
                      className="text-xs text-cyan-400 tracking-widest hover:underline disabled:opacity-40"
                    >
                      {resendingId === g.id ? 'RESENDING…' : '↻ RESEND WELCOME'}
                    </button>
                  )}
                  {g.is_active ? (
                    <button onClick={() => deactivate(g.id)} className="text-xs text-red-400 tracking-widest hover:underline">DEACTIVATE</button>
                  ) : (
                    <button onClick={() => reactivate(g.id)} className="text-xs text-green-400 tracking-widest hover:underline">REACTIVATE</button>
                  )}
                </div>
              </div>

              {/* Expanded assignments — same content as before, laid out below the compact row */}
              {isExpanded && sitesCount > 0 && (
                <div className="bg-[#0B1526] px-4 py-3 border-t border-[#1A3050] space-y-1.5">
                  {g.assignments!.map((a) => (
                    <div key={a.id} data-testid={`assignment-card-${a.id}`}
                      className="flex items-center justify-between gap-3 py-1.5">
                      <div className="flex items-baseline gap-3 min-w-0">
                        <span className="text-gray-600">▪</span>
                        <span className="text-amber-400 text-sm font-medium truncate">
                          {a.site_name}
                          <InactiveSiteBadge siteIsActive={a.site_is_active} />
                        </span>
                        <span className="text-gray-500 text-xs font-mono">{fmtDateRange(a.assigned_from, a.assigned_until)}</span>
                      </div>
                      {g.is_active && (
                        <div className="flex items-center gap-2 shrink-0">
                          <button onClick={() => openEditModal(g, a)} title="Edit until-date"
                            className="text-gray-400 hover:text-amber-400 transition-colors px-2 py-0.5">✎</button>
                          <button onClick={() => openEndNowModal(g, a)} title="End now"
                            className="text-cyan-400 hover:text-cyan-300 text-xs tracking-widest hover:underline">END NOW ×</button>
                          <button onClick={() => openRemoveModal(g, a)} title="Remove assignment"
                            className="text-red-400 hover:text-red-300 transition-colors px-2 py-0.5">✕</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Mobile list */}
      <div className="md:hidden space-y-2">
        {loading && <p className="text-center text-gray-500 py-10">Loading…</p>}
        {!loading && visible.length === 0 && (
          <p className="text-center text-gray-500 py-10">No guards match your criteria.</p>
        )}
        {!loading && visible.map((g) => {
          const isExpanded = expanded.has(g.id);
          const sitesCount = g.assignments?.length ?? 0;
          return (
            <div key={g.id} className={`bg-[#0F1E35] border border-[#1A3050] rounded-xl ${!g.is_active ? 'opacity-60' : ''}`}>
              <div className="flex items-center gap-3 p-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0 ${avatarColor(g.id)}`}>
                  {initials(g.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-gray-100 font-semibold text-sm truncate">{g.name}</p>
                  <p className="text-gray-500 text-xs truncate">
                    {g.email}
                    {showCompanyLabel && g.company_name && (
                      <span className="text-gray-600"> · {g.company_name}</span>
                    )}
                  </p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-gray-600 text-[11px] font-mono">{g.badge_number}</span>
                    <button
                      onClick={() => sitesCount > 0 && toggleExpand(g.id)}
                      disabled={sitesCount === 0}
                      className={`text-[10px] font-bold tracking-widest px-2 py-0.5 rounded-full ${
                        sitesCount === 0
                          ? 'bg-[#0B1526] border border-[#1A3050] text-gray-600'
                          : 'bg-blue-500/20 border border-blue-500/40 text-blue-300'
                      }`}
                    >
                      {sitesCount} {sitesCount === 1 ? 'SITE' : 'SITES'}{sitesCount > 0 && (isExpanded ? ' ▲' : ' ▾')}
                    </button>
                  </div>
                </div>
                {g.is_active ? (
                  <span className="text-[9px] tracking-widest text-green-400 bg-green-400/10 border border-green-400/30 px-2 py-0.5 rounded shrink-0">ACTIVE</span>
                ) : (
                  <span className="text-[9px] tracking-widest text-red-400 bg-red-400/10 border border-red-400/30 px-2 py-0.5 rounded shrink-0">INACTIVE</span>
                )}
              </div>
              {isExpanded && sitesCount > 0 && (
                <div className="bg-[#0B1526] px-3 py-2 border-t border-[#1A3050] space-y-2">
                  {g.assignments!.map((a) => (
                    <div key={a.id} data-testid={`assignment-card-mobile-${a.id}`}
                      className="bg-[#0F1E35] border border-[#1A3050] rounded px-2 py-1.5">
                      <p className="text-amber-400 text-xs font-medium truncate">
                        {a.site_name}<InactiveSiteBadge siteIsActive={a.site_is_active} />
                      </p>
                      <p className="text-gray-500 text-[10px] font-mono mb-1">{fmtDateRange(a.assigned_from, a.assigned_until)}</p>
                      {g.is_active && (
                        <div className="flex gap-2">
                          <button onClick={() => openEditModal(g, a)}
                            className="flex-1 text-[10px] text-amber-400 tracking-widest border border-amber-400/30 rounded py-1 hover:bg-amber-400/10">EDIT</button>
                          <button onClick={() => openEndNowModal(g, a)}
                            className="flex-1 text-[10px] text-cyan-400 tracking-widest border border-cyan-400/30 rounded py-1 hover:bg-cyan-400/10">END NOW</button>
                          <button onClick={() => openRemoveModal(g, a)}
                            className="flex-1 text-[10px] text-red-400 tracking-widest border border-red-400/30 rounded py-1 hover:bg-red-400/10">REMOVE</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2 p-3 pt-0">
                {g.is_active && (
                  <button onClick={() => { setShowAssign(g); setFormError(''); }}
                    className="flex-1 text-xs text-amber-400 tracking-widest border border-amber-400/30 rounded-lg py-2 hover:bg-amber-400/10 transition-colors">
                    ASSIGN
                  </button>
                )}
                {g.is_active && g.must_change_password && (
                  <button onClick={() => resendWelcome(g)} disabled={resendingId === g.id}
                    className="flex-1 text-xs text-cyan-400 tracking-widest border border-cyan-400/30 rounded-lg py-2 hover:bg-cyan-400/10 transition-colors disabled:opacity-40">
                    {resendingId === g.id ? 'SENDING…' : '↻ RESEND'}
                  </button>
                )}
                {g.is_active ? (
                  <button onClick={() => deactivate(g.id)}
                    className="flex-1 text-xs text-red-400 tracking-widest border border-red-400/30 rounded-lg py-2 hover:bg-red-400/10 transition-colors">
                    DEACTIVATE
                  </button>
                ) : (
                  <button onClick={() => reactivate(g.id)}
                    className="flex-1 text-xs text-green-400 tracking-widest border border-green-400/30 rounded-lg py-2 hover:bg-green-400/10 transition-colors">
                    REACTIVATE
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Add Guard Modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60">
          <div className="w-full sm:max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-t-2xl sm:rounded-2xl p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">ADD GUARD</h2>
              <button onClick={() => setShowAdd(false)} className="text-gray-500 hover:text-gray-300 text-xl w-10 h-10 flex items-center justify-center">✕</button>
            </div>
            {formError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{formError}</div>}
            <p className="text-gray-500 text-xs mb-4">Badge number will be assigned automatically on creation (GRD####, per-company sequence).</p>
            <div className="space-y-4">
              {([
                ['name',          'FULL NAME',          'text',     'e.g. James Wilson'],
                ['email',         'EMAIL',              'email',    'guard@company.com'],
                ['temp_password', 'TEMPORARY PASSWORD', 'password', 'Min 8 characters'],
              ] as const).map(([key, label, type, ph]) => (
                <div key={key}>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">{label} <span className="text-amber-400">*</span></label>
                  <input type={type} placeholder={ph} value={(form as any)[key]}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, [key]: e.target.value }));
                      if (key === 'temp_password' && (e.target.value.length < 8 || e.target.value.length > 128)) {
                        setFormError('Minimum 8 characters.');
                      } else if (key === 'temp_password') {
                        setFormError('');
                      }
                    }}
                    className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-3 text-gray-200 text-base focus:outline-none focus:border-amber-400"
                  />
                </div>
              ))}
            </div>
            <p className="text-gray-600 text-xs mt-3 mb-5">Guard will be prompted to change their password on first login.</p>
            <div className="flex gap-3">
              <button onClick={() => setShowAdd(false)} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-3 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
              <button onClick={addGuard} disabled={saving} className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-3 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors">
                {saving ? 'ADDING…' : 'ADD GUARD'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assign to Site Modal */}
      {showAssign && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60">
          <div className="w-full sm:max-w-sm bg-[#0F1E35] border border-[#1A3050] rounded-t-2xl sm:rounded-2xl p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">ASSIGN SITE</h2>
              <button onClick={() => setShowAssign(null)} className="text-gray-500 hover:text-gray-300 text-xl w-10 h-10 flex items-center justify-center">✕</button>
            </div>
            <p className="text-gray-400 text-sm mb-4">{showAssign.name}</p>
            {formError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{formError}</div>}
            <div className="space-y-4">
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">SITE <span className="text-amber-400">*</span></label>
                <select value={assignForm.site_id} onChange={(e) => setAssignForm((f) => ({ ...f, site_id: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-3 text-gray-200 text-base focus:outline-none focus:border-amber-400">
                  <option value="">Select site…</option>
                  {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">FROM <span className="text-amber-400">*</span></label>
                <input type="date" value={assignForm.assigned_from} onChange={(e) => setAssignForm((f) => ({ ...f, assigned_from: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-3 text-gray-200 text-base focus:outline-none focus:border-amber-400" />
              </div>
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">UNTIL (OPTIONAL)</label>
                <input type="date" value={assignForm.assigned_until} onChange={(e) => setAssignForm((f) => ({ ...f, assigned_until: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-3 text-gray-200 text-base focus:outline-none focus:border-amber-400" />
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setShowAssign(null)} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-3 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
              <button onClick={assignGuard} disabled={saving} className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-3 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors">
                {saving ? 'SAVING…' : 'ASSIGN'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit-assignment modal (Phase B) ────────────────────────────── */}
      {editAssignment && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60" data-testid="edit-modal">
          <div className="w-full sm:max-w-sm bg-[#0F1E35] border border-[#1A3050] rounded-t-2xl sm:rounded-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">EDIT ASSIGNMENT</h2>
              <button onClick={() => setEditAssignment(null)} className="text-gray-500 hover:text-gray-300 text-xl w-10 h-10 flex items-center justify-center">✕</button>
            </div>
            <p className="text-gray-300 text-sm">{editAssignment.guard.name}</p>
            <p className="text-amber-400 text-sm mb-1">{editAssignment.assignment.site_name}<InactiveSiteBadge siteIsActive={editAssignment.assignment.site_is_active} /></p>
            <p className="text-gray-500 text-xs font-mono mb-4">{fmtDateRange(editAssignment.assignment.assigned_from, editAssignment.assignment.assigned_until)}</p>
            {editError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{editError}</div>}
            <div className="mb-4">
              <label className="block text-gray-500 text-xs tracking-widest mb-1">ASSIGNED UNTIL</label>
              <input type="date" value={editUntil}
                min={String(editAssignment.assignment.assigned_from).slice(0, 10) > today ? String(editAssignment.assignment.assigned_from).slice(0, 10) : today}
                onChange={(e) => setEditUntil(e.target.value)}
                className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-3 text-gray-200 text-base focus:outline-none focus:border-amber-400" />
              <button type="button" onClick={() => setEditUntil('')}
                className="text-cyan-400 text-xs tracking-widest hover:underline mt-2">CLEAR — KEEP OPEN-ENDED</button>
              <p className="text-gray-600 text-xs mt-1">Past dates rejected. Cannot precede start date.</p>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setEditAssignment(null)} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-3 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
              <button onClick={saveEdit} disabled={saving} className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-3 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors">
                {saving ? 'SAVING…' : 'SAVE'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirm modal shared by End-Now and Remove (Phase B) ───────── */}
      {(endNowAssignment || removeAssignment) && (() => {
        const isEnd = !!endNowAssignment;
        const ctx = (endNowAssignment ?? removeAssignment)!;
        return (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60"
            data-testid={isEnd ? 'end-now-modal' : 'remove-modal'}>
            <div className="w-full sm:max-w-sm bg-[#0F1E35] border border-[#1A3050] rounded-t-2xl sm:rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-amber-400 font-bold tracking-widest text-lg">{isEnd ? 'END ASSIGNMENT NOW' : 'REMOVE ASSIGNMENT'}</h2>
                <button onClick={() => { setEndNowAssignment(null); setRemoveAssignment(null); }}
                  className="text-gray-500 hover:text-gray-300 text-xl w-10 h-10 flex items-center justify-center">✕</button>
              </div>
              <p className="text-gray-300 text-sm">{ctx.guard.name}</p>
              <p className="text-amber-400 text-sm mb-1">{ctx.assignment.site_name}<InactiveSiteBadge siteIsActive={ctx.assignment.site_is_active} /></p>
              <p className="text-gray-500 text-xs font-mono mb-4">{fmtDateRange(ctx.assignment.assigned_from, ctx.assignment.assigned_until)}</p>
              {editError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{editError}</div>}
              {impactLoading && <p className="text-gray-500 text-xs mb-3">Checking future shifts…</p>}
              {!impactLoading && impact && impact.future_shift_count > 0 && (
                <div data-testid="impact-warning" className="bg-amber-400/10 border border-amber-400/40 rounded-lg px-3 py-2 mb-4">
                  <p className="text-amber-300 text-xs">
                    <strong>{ctx.guard.name}</strong> has <strong>{impact.future_shift_count}</strong> scheduled future shift{impact.future_shift_count === 1 ? '' : 's'} at <strong>{ctx.assignment.site_name}</strong>. {isEnd ? 'Ending this assignment' : 'Removing this assignment'} will not cancel them but you won't be able to schedule new ones. Continue?
                  </p>
                  {impact.sample_dates.length > 0 && (
                    <p className="text-gray-500 text-xs font-mono mt-2">Upcoming: {impact.sample_dates.join(', ')}</p>
                  )}
                </div>
              )}
              {!impactLoading && impact && impact.future_shift_count === 0 && (
                <p className="text-gray-500 text-xs mb-4">No future scheduled shifts will be affected.</p>
              )}
              {isEnd && (
                <p className="text-gray-500 text-xs mb-3">This sets <span className="font-mono text-gray-300">assigned_until</span> to today ({today}, Pacific).</p>
              )}
              <div className="flex gap-3">
                <button onClick={() => { setEndNowAssignment(null); setRemoveAssignment(null); }}
                  className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-3 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
                <button onClick={isEnd ? confirmEndNow : confirmRemove} disabled={saving || impactLoading}
                  className={`flex-1 font-bold rounded-lg py-3 text-sm tracking-widest disabled:opacity-40 transition-colors ${isEnd ? 'bg-cyan-400 text-gray-900 hover:bg-cyan-300' : 'bg-red-500 text-white hover:bg-red-400'}`}>
                  {saving ? 'SAVING…' : isEnd ? 'END NOW' : 'REMOVE'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
