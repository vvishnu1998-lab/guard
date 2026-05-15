'use client';
/**
 * Admin — Guards Management (/admin/guards)
 * List guards, add new guard (with temp password), assign to site, deactivate, reactivate.
 */
import { useCallback, useEffect, useState } from 'react';
import { adminGet, adminPost, adminPatch, adminFetch } from '../../../lib/adminApi';

interface Guard {
  id:           string;
  name:         string;
  email:        string;
  badge_number: string;
  is_active:    boolean;
  created_at:   string;
  assignments:  { site_id: string; site_name: string; assigned_from: string; assigned_until: string | null }[] | null;
}

interface Site { id: string; name: string; }

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
                <td className="p-4">
                  {g.assignments?.length ? (
                    <div className="flex flex-wrap gap-1">
                      {g.assignments.map((a) => (
                        <span key={a.site_id} className="text-xs bg-[#0B1526] border border-[#1A3050] px-2 py-0.5 rounded text-amber-400">
                          {a.site_name}
                        </span>
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
              <div className="flex flex-wrap gap-1">
                {g.assignments.map((a) => (
                  <span key={a.site_id} className="text-xs bg-[#0B1526] border border-[#1A3050] px-2 py-0.5 rounded text-amber-400">{a.site_name}</span>
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
                      if (key === 'temp_password' && (e.target.value.length < 6 || e.target.value.length > 8)) {
                        setFormError('Temporary password must be 6–8 characters');
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
    </div>
  );
}
