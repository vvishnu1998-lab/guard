'use client';
/**
 * Admin — Guards Management (/admin/guards)
 * List guards, add new guard (with temp password), assign to site, deactivate, reactivate.
 */
import { useCallback, useEffect, useState } from 'react';
import { adminGet, adminPost, adminPatch, adminFetch, adminDelete } from '../../../lib/adminApi';

interface Assignment {
  id:             string;
  site_id:        string;
  site_name:      string;
  assigned_from:  string;
  assigned_until: string | null;
}

interface Guard {
  id:           string;
  name:         string;
  email:        string;
  badge_number: string;
  is_active:    boolean;
  created_at:   string;
  assignments:  Assignment[] | null;
}

interface Site { id: string; name: string; }

interface ImpactReport { future_shift_count: number; sample_dates: string[] }

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

export default function GuardsPage() {
  const [guards,     setGuards]     = useState<Guard[]>([]);
  const [sites,      setSites]      = useState<Site[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [showAdd,    setShowAdd]    = useState(false);
  const [showAssign, setShowAssign] = useState<Guard | null>(null);
  const [form,       setForm]       = useState({ name: '', email: '', badge_number: '', temp_password: '' });
  const [assignForm, setAssignForm] = useState({ site_id: '', assigned_from: '', assigned_until: '' });
  const [saving,     setSaving]     = useState(false);
  const [formError,  setFormError]  = useState('');
  const [showInactive, setShowInactive] = useState(false);

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
    const { name, email, badge_number, temp_password } = form;
    if (!name || !email || !badge_number || !temp_password) { setFormError('All fields required'); return; }
    setSaving(true); setFormError('');
    try {
      await adminPost('/api/guards', form);
      setShowAdd(false); setForm({ name: '', email: '', badge_number: '', temp_password: '' });
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
    // Empty input means "open-ended" → send null. Otherwise send the
    // YYYY-MM-DD string and let the server validate it against the
    // assignment's start + Pacific today.
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

  const visible = guards.filter((g) => showInactive || g.is_active);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl md:text-3xl font-bold tracking-widest text-amber-400">GUARDS</h1>
        <div className="flex flex-wrap gap-3 items-center">
          <label className="flex items-center gap-2 text-gray-400 text-xs tracking-widest cursor-pointer select-none min-h-[44px] px-2">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="accent-amber-400 w-4 h-4" />
            SHOW INACTIVE
          </label>
          <button
            onClick={() => { setShowAdd(true); setFormError(''); }}
            className="bg-amber-400 text-gray-900 font-bold tracking-widest text-sm px-4 py-3 rounded-lg hover:bg-amber-300 transition-colors min-h-[44px]"
          >
            + ADD GUARD
          </button>
        </div>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      {/* Desktop table */}
      <div className="hidden md:block bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-xs tracking-widest border-b border-[#1A3050]">
              <th className="text-left p-4">GUARD</th>
              <th className="text-left p-4">BADGE</th>
              <th className="text-left p-4">ASSIGNED SITES</th>
              <th className="text-center p-4">STATUS</th>
              <th className="text-right p-4">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5} className="text-center text-gray-500 py-10">Loading…</td></tr>}
            {!loading && visible.length === 0 && <tr><td colSpan={5} className="text-center text-gray-500 py-10">No guards {showInactive ? '' : '— toggle "Show Inactive" to see deactivated guards'}</td></tr>}
            {visible.map((g) => (
              <tr key={g.id} className={`border-b border-[#1A3050] hover:bg-[#0B1526] transition-colors ${!g.is_active ? 'opacity-60' : ''}`}>
                <td className="p-4">
                  <p className="text-gray-200 font-medium">{g.name}</p>
                  <p className="text-gray-500 text-xs">{g.email}</p>
                </td>
                <td className="p-4 text-gray-400 font-mono text-xs">{g.badge_number}</td>
                <td className="p-4 align-top">
                  {g.assignments?.length ? (
                    <div className="space-y-2 max-w-md">
                      {g.assignments.map((a) => (
                        <div key={a.id} data-testid={`assignment-card-${a.id}`}
                          className="flex items-center justify-between gap-2 bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2">
                          <div className="min-w-0">
                            <p className="text-amber-400 text-sm font-medium truncate">{a.site_name}</p>
                            <p className="text-gray-500 text-xs font-mono">{fmtDateRange(a.assigned_from, a.assigned_until)}</p>
                          </div>
                          {g.is_active && (
                            <div className="flex items-center gap-2 shrink-0">
                              <button onClick={() => openEditModal(g, a)} title="Edit until-date"
                                className="text-gray-400 hover:text-amber-400 transition-colors px-2 py-1">✎</button>
                              <button onClick={() => openEndNowModal(g, a)} title="End now"
                                className="text-cyan-400 hover:text-cyan-300 text-xs tracking-widest hover:underline">END NOW</button>
                              <button onClick={() => openRemoveModal(g, a)} title="Remove assignment"
                                className="text-red-400 hover:text-red-300 transition-colors px-2 py-1">✕</button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : <span className="text-gray-600 text-xs">—</span>}
                </td>
                <td className="p-4 text-center">
                  {g.is_active ? (
                    <span className="text-xs tracking-widest text-green-400 bg-green-400/10 border border-green-400/30 px-2 py-0.5 rounded">ACTIVE</span>
                  ) : (
                    <span className="text-xs tracking-widest text-red-400 bg-red-400/10 border border-red-400/30 px-2 py-0.5 rounded">INACTIVE</span>
                  )}
                </td>
                <td className="p-4 text-right">
                  <div className="flex gap-3 justify-end">
                    {g.is_active && (
                      <button onClick={() => { setShowAssign(g); setFormError(''); }} className="text-xs text-amber-400 tracking-widest hover:underline min-h-[32px]">ASSIGN</button>
                    )}
                    {g.is_active ? (
                      <button onClick={() => deactivate(g.id)} className="text-xs text-red-400 tracking-widest hover:underline min-h-[32px]">DEACTIVATE</button>
                    ) : (
                      <button onClick={() => reactivate(g.id)} className="text-xs text-green-400 tracking-widest hover:underline min-h-[32px]">REACTIVATE</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile card list */}
      <div className="md:hidden space-y-3">
        {loading && <p className="text-center text-gray-500 py-10">Loading…</p>}
        {!loading && visible.length === 0 && (
          <p className="text-center text-gray-500 py-10">No guards {showInactive ? '' : '— toggle "Show Inactive" above'}</p>
        )}
        {visible.map((g) => (
          <div key={g.id} className={`bg-[#0F1E35] border border-[#1A3050] rounded-xl p-4 space-y-3 ${!g.is_active ? 'opacity-60' : ''}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-gray-100 font-semibold text-base">{g.name}</p>
                <p className="text-gray-500 text-sm">{g.email}</p>
                <p className="text-gray-500 text-xs font-mono mt-0.5">{g.badge_number}</p>
              </div>
              {g.is_active ? (
                <span className="text-xs tracking-widest text-green-400 bg-green-400/10 border border-green-400/30 px-2 py-0.5 rounded shrink-0">ACTIVE</span>
              ) : (
                <span className="text-xs tracking-widest text-red-400 bg-red-400/10 border border-red-400/30 px-2 py-0.5 rounded shrink-0">INACTIVE</span>
              )}
            </div>
            {g.assignments?.length ? (
              <div className="space-y-2">
                {g.assignments.map((a) => (
                  <div key={a.id} data-testid={`assignment-card-mobile-${a.id}`}
                    className="bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2">
                    <p className="text-amber-400 text-sm font-medium">{a.site_name}</p>
                    <p className="text-gray-500 text-xs font-mono mb-2">{fmtDateRange(a.assigned_from, a.assigned_until)}</p>
                    {g.is_active && (
                      <div className="flex gap-2">
                        <button onClick={() => openEditModal(g, a)}
                          className="flex-1 text-xs text-amber-400 tracking-widest border border-amber-400/30 rounded py-1.5 hover:bg-amber-400/10">EDIT</button>
                        <button onClick={() => openEndNowModal(g, a)}
                          className="flex-1 text-xs text-cyan-400 tracking-widest border border-cyan-400/30 rounded py-1.5 hover:bg-cyan-400/10">END NOW</button>
                        <button onClick={() => openRemoveModal(g, a)}
                          className="flex-1 text-xs text-red-400 tracking-widest border border-red-400/30 rounded py-1.5 hover:bg-red-400/10">REMOVE</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="flex gap-2 pt-1">
              {g.is_active && (
                <button onClick={() => { setShowAssign(g); setFormError(''); }}
                  className="flex-1 text-sm text-amber-400 tracking-widest border border-amber-400/30 rounded-lg py-2.5 hover:bg-amber-400/10 transition-colors">
                  ASSIGN
                </button>
              )}
              {g.is_active ? (
                <button onClick={() => deactivate(g.id)}
                  className="flex-1 text-sm text-red-400 tracking-widest border border-red-400/30 rounded-lg py-2.5 hover:bg-red-400/10 transition-colors">
                  DEACTIVATE
                </button>
              ) : (
                <button onClick={() => reactivate(g.id)}
                  className="flex-1 text-sm text-green-400 tracking-widest border border-green-400/30 rounded-lg py-2.5 hover:bg-green-400/10 transition-colors">
                  REACTIVATE
                </button>
              )}
            </div>
          </div>
        ))}
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
            <div className="space-y-4">
              {([
                ['name',          'FULL NAME',          'text',     'e.g. James Wilson'],
                ['email',         'EMAIL',              'email',    'guard@company.com'],
                ['badge_number',  'BADGE NUMBER',       'text',     'e.g. GRD-042'],
                ['temp_password', 'TEMPORARY PASSWORD', 'password', 'Min 6 characters'],
              ] as const).map(([key, label, type, ph]) => (
                <div key={key}>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">{label} <span className="text-amber-400">*</span></label>
                  <input type={type} placeholder={ph} value={(form as any)[key]}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, [key]: e.target.value }));
                      if (key === 'temp_password' && (e.target.value.length < 6 || e.target.value.length > 128)) {
                        setFormError('Minimum 6 characters.');
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
            <p className="text-amber-400 text-sm mb-1">{editAssignment.assignment.site_name}</p>
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
              <p className="text-amber-400 text-sm mb-1">{ctx.assignment.site_name}</p>
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
