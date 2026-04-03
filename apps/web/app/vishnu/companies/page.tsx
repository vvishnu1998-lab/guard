'use client';
/**
 * Vishnu — Company Management (/vishnu/companies)
 * Create companies, set per-company photo quotas, manage admins, toggle active.
 */
import { useCallback, useEffect, useState } from 'react';
import { vishnuGet, vishnuPost, vishnuPatch } from '../../../lib/vishnuApi';

interface Company {
  id:                  string;
  name:                string;
  default_photo_limit: number;
  is_active:           boolean;
  created_at:          string;
  active_sites:        string;
  active_guards:       string;
  admin_count:         string;
}

interface Admin {
  id:         string;
  name:       string;
  email:      string;
  is_primary: boolean;
  is_active:  boolean;
}

const EMPTY_FORM       = { name: '', default_photo_limit: '5' };
const EDIT_EMPTY       = { name: '', default_photo_limit: '' };
const ADMIN_FORM_EMPTY = { name: '', email: '', password: '' };

export default function CompaniesPage() {
  const [companies,   setCompanies]   = useState<Company[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [showCreate,  setShowCreate]  = useState(false);
  const [createForm,  setCreateForm]  = useState(EMPTY_FORM);
  const [saving,      setSaving]      = useState(false);
  const [formError,   setFormError]   = useState('');
  const [expanded,    setExpanded]    = useState<string | null>(null);
  const [admins,      setAdmins]      = useState<Record<string, Admin[]>>({});
  const [editId,      setEditId]      = useState<string | null>(null);
  const [editForm,    setEditForm]    = useState(EDIT_EMPTY);
  const [adminModal,  setAdminModal]  = useState<string | null>(null); // company id
  const [adminForm,   setAdminForm]   = useState(ADMIN_FORM_EMPTY);
  const [adminError,  setAdminError]  = useState('');
  const [adminSaving, setAdminSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setCompanies(await vishnuGet<Company[]>('/api/admin/companies'));
      setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function loadAdmins(companyId: string) {
    if (admins[companyId]) return;
    try {
      const a = await vishnuGet<Admin[]>(`/api/admin/companies/${companyId}/admins`);
      setAdmins((prev) => ({ ...prev, [companyId]: a }));
    } catch { /* silently ignore */ }
  }

  async function toggleExpand(id: string) {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    await loadAdmins(id);
  }

  async function createCompany() {
    if (!createForm.name.trim()) { setFormError('Name is required'); return; }
    const limit = parseInt(createForm.default_photo_limit);
    if (isNaN(limit) || limit < 1 || limit > 20) { setFormError('Photo limit must be 1–20'); return; }
    setSaving(true); setFormError('');
    try {
      await vishnuPost('/api/admin/companies', {
        name: createForm.name.trim(),
        default_photo_limit: limit,
      });
      setShowCreate(false); setCreateForm(EMPTY_FORM);
      await load();
    } catch (e: any) { setFormError(e.message); }
    finally { setSaving(false); }
  }

  async function saveEdit(id: string) {
    setSaving(true); setFormError('');
    try {
      const patch: Record<string, unknown> = {};
      if (editForm.name.trim())           patch.name = editForm.name.trim();
      if (editForm.default_photo_limit)   patch.default_photo_limit = parseInt(editForm.default_photo_limit);
      if (Object.keys(patch).length === 0) { setEditId(null); return; }
      await vishnuPatch(`/api/admin/companies/${id}`, patch);
      setEditId(null); setEditForm(EDIT_EMPTY);
      await load();
    } catch (e: any) { setFormError(e.message); }
    finally { setSaving(false); }
  }

  async function createAdmin(companyId: string) {
    if (!adminForm.name.trim() || !adminForm.email.trim() || !adminForm.password) {
      setAdminError('All fields are required'); return;
    }
    setAdminSaving(true); setAdminError('');
    try {
      const { vishnuPost: vp } = await import('../../../lib/vishnuApi');
      await vp(`/api/admin/companies/${companyId}/admins`, {
        name: adminForm.name.trim(),
        email: adminForm.email.trim(),
        password: adminForm.password,
      });
      setAdminModal(null); setAdminForm(ADMIN_FORM_EMPTY);
      // Refresh admin list for this company
      setAdmins((prev) => { const n = { ...prev }; delete n[companyId]; return n; });
      await loadAdmins(companyId);
      await load();
    } catch (e: any) { setAdminError(e.message); }
    finally { setAdminSaving(false); }
  }

  async function toggleActive(c: Company) {
    try {
      await vishnuPatch(`/api/admin/companies/${c.id}`, { is_active: !c.is_active });
      await load();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-widest text-gray-300">COMPANIES</h1>
        <button
          onClick={() => { setShowCreate(true); setFormError(''); setCreateForm(EMPTY_FORM); }}
          className="bg-gray-600 text-white text-xs tracking-widest font-bold px-4 py-2 rounded-lg hover:bg-gray-500 transition-colors"
        >
          + NEW COMPANY
        </button>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      <div className="space-y-3">
        {loading && <p className="text-center text-gray-500 py-10 text-sm">Loading…</p>}
        {!loading && companies.length === 0 && (
          <div className="bg-[#242436] border border-[#2E2E48] rounded-xl p-12 text-center">
            <p className="text-gray-500 text-sm">No companies yet. Create the first one.</p>
          </div>
        )}

        {companies.map((c) => (
          <div key={c.id} className={`bg-[#242436] border border-[#2E2E48] rounded-xl overflow-hidden ${!c.is_active ? 'opacity-60' : ''}`}>
            {/* Company row */}
            <div className="p-4 flex items-center gap-4">
              <button
                onClick={() => toggleExpand(c.id)}
                className="flex-1 text-left flex items-center gap-4"
              >
                <span className={`text-xs tracking-widest ${expanded === c.id ? 'text-gray-300' : 'text-gray-500'}`}>
                  {expanded === c.id ? '▼' : '▶'}
                </span>
                <div className="flex-1 min-w-0">
                  {editId === c.id ? (
                    <input
                      autoFocus
                      value={editForm.name}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                      placeholder={c.name}
                      className="bg-[#1A1A2E] border border-gray-600 rounded px-2 py-1 text-gray-200 text-sm focus:outline-none focus:border-gray-400 w-48"
                    />
                  ) : (
                    <p className="text-gray-200 font-medium">{c.name}</p>
                  )}
                  <p className="text-gray-600 text-xs font-mono mt-0.5">{c.id.slice(0, 12)}…</p>
                </div>
              </button>

              {/* Stats */}
              <div className="hidden sm:flex gap-6 text-center shrink-0">
                <div><p className="text-gray-200 font-bold">{c.active_sites}</p><p className="text-gray-600 text-xs">SITES</p></div>
                <div><p className="text-gray-200 font-bold">{c.active_guards}</p><p className="text-gray-600 text-xs">GUARDS</p></div>
                <div><p className="text-gray-200 font-bold">{c.admin_count}</p><p className="text-gray-600 text-xs">ADMINS</p></div>
              </div>

              {/* Photo limit */}
              <div className="text-center shrink-0">
                {editId === c.id ? (
                  <input
                    type="number" min={1} max={20}
                    value={editForm.default_photo_limit}
                    onChange={(e) => setEditForm((f) => ({ ...f, default_photo_limit: e.target.value }))}
                    placeholder={String(c.default_photo_limit)}
                    className="bg-[#1A1A2E] border border-gray-600 rounded px-2 py-1 text-gray-200 text-sm focus:outline-none w-14 text-center"
                  />
                ) : (
                  <div>
                    <p className="text-gray-300 font-bold">{c.default_photo_limit}</p>
                    <p className="text-gray-600 text-xs">PHOTOS/RPT</p>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex gap-2 shrink-0">
                {editId === c.id ? (
                  <>
                    <button onClick={() => saveEdit(c.id)} disabled={saving} className="text-xs text-green-400 border border-green-700 px-2 py-1 rounded hover:bg-green-900/30 transition-colors disabled:opacity-40">SAVE</button>
                    <button onClick={() => { setEditId(null); setEditForm(EDIT_EMPTY); }} className="text-xs text-gray-500 border border-[#2E2E48] px-2 py-1 rounded hover:border-gray-500 transition-colors">CANCEL</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => { setEditId(c.id); setEditForm({ name: c.name, default_photo_limit: String(c.default_photo_limit) }); }}
                      className="text-xs text-gray-400 border border-[#2E2E48] px-2 py-1 rounded hover:border-gray-500 hover:text-gray-200 transition-colors">
                      EDIT
                    </button>
                    <button onClick={() => toggleActive(c)}
                      className={`text-xs px-2 py-1 rounded border transition-colors ${c.is_active ? 'border-red-800 text-red-400 hover:bg-red-900/20' : 'border-green-800 text-green-400 hover:bg-green-900/20'}`}>
                      {c.is_active ? 'DEACTIVATE' : 'ACTIVATE'}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Expanded: admin list */}
            {expanded === c.id && (
              <div className="border-t border-[#2E2E48] px-4 pb-4 pt-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-gray-600 text-xs tracking-widest">ADMINS</p>
                  <button
                    onClick={() => { setAdminModal(c.id); setAdminForm(ADMIN_FORM_EMPTY); setAdminError(''); }}
                    className="text-xs text-gray-400 border border-[#2E2E48] px-2 py-0.5 rounded hover:border-gray-500 hover:text-gray-200 transition-colors"
                  >
                    + ADD ADMIN
                  </button>
                </div>
                {!admins[c.id] ? (
                  <p className="text-gray-600 text-xs">Loading…</p>
                ) : admins[c.id].length === 0 ? (
                  <p className="text-gray-600 text-xs">No admins yet — add one above.</p>
                ) : (
                  <div className="space-y-1">
                    {admins[c.id].map((a) => (
                      <div key={a.id} className="flex items-center gap-3 text-xs">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${a.is_active ? 'bg-green-500' : 'bg-gray-600'}`} />
                        <span className="text-gray-300">{a.name}</span>
                        <span className="text-gray-600">{a.email}</span>
                        {a.is_primary && (
                          <span className="text-gray-400 border border-gray-600 px-1.5 rounded text-xs tracking-widest">PRIMARY</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Create Admin Modal */}
      {adminModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md bg-[#242436] border border-[#2E2E48] rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-gray-300 font-bold tracking-widest text-lg">NEW ADMIN</h2>
              <button onClick={() => setAdminModal(null)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            {adminError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{adminError}</div>}
            <div className="space-y-4">
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">FULL NAME *</label>
                <input autoFocus type="text" value={adminForm.name}
                  onChange={(e) => setAdminForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. John Smith"
                  className="w-full bg-[#1A1A2E] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-gray-400"
                />
              </div>
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">EMAIL *</label>
                <input type="email" value={adminForm.email}
                  onChange={(e) => setAdminForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="admin@company.com"
                  className="w-full bg-[#1A1A2E] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-gray-400"
                />
              </div>
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">PASSWORD *</label>
                <input type="password" value={adminForm.password}
                  onChange={(e) => setAdminForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="Min 8 characters"
                  className="w-full bg-[#1A1A2E] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-gray-400"
                />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setAdminModal(null)} className="flex-1 border border-[#2E2E48] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
              <button onClick={() => createAdmin(adminModal)} disabled={adminSaving}
                className="flex-1 bg-gray-600 text-white font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-gray-500 disabled:opacity-40 transition-colors">
                {adminSaving ? 'CREATING…' : 'CREATE ADMIN'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Company Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md bg-[#242436] border border-[#2E2E48] rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-gray-300 font-bold tracking-widest text-lg">NEW COMPANY</h2>
              <button onClick={() => setShowCreate(false)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            {formError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{formError}</div>}
            <div className="space-y-4">
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">COMPANY NAME <span className="text-gray-400">*</span></label>
                <input
                  autoFocus
                  type="text" value={createForm.name}
                  onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Apex Security Ltd"
                  className="w-full bg-[#1A1A2E] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-gray-400"
                />
              </div>
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">DEFAULT PHOTO LIMIT PER REPORT</label>
                <div className="flex items-center gap-3">
                  <input
                    type="number" min={1} max={20}
                    value={createForm.default_photo_limit}
                    onChange={(e) => setCreateForm((f) => ({ ...f, default_photo_limit: e.target.value }))}
                    className="w-24 bg-[#1A1A2E] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-gray-400"
                  />
                  <span className="text-gray-600 text-xs">Max 20. Can be overridden per site.</span>
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowCreate(false)} className="flex-1 border border-[#2E2E48] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
              <button onClick={createCompany} disabled={saving} className="flex-1 bg-gray-600 text-white font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-gray-500 disabled:opacity-40 transition-colors">
                {saving ? 'CREATING…' : 'CREATE'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
