'use client';
/**
 * Vishnu — Company Management (/vishnu/companies)
 * Create companies, set per-company photo quotas, manage admins.
 * Each company row expands to a nested table of its sites. A top-of-page
 * search auto-expands the parent company of a matching site and highlights
 * the row briefly (amber bg → fade).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

interface Site {
  id:                    string;
  name:                  string;
  address:               string;
  is_active:             boolean;
  contract_start:        string;
  contract_end:          string | null;
  photo_limit_override:  number | null;
  company_id:            string;
  company_name:          string;
  default_photo_limit:   number;
  effective_photo_limit: number;
  guards_on_duty:        string;
}

const EMPTY_FORM       = { name: '', default_photo_limit: '5' };
const EDIT_EMPTY       = { name: '', default_photo_limit: '' };
const ADMIN_FORM_EMPTY = { name: '', email: '', password: '' };

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function contractCell(end: string | null): { date: string; sub: string; subColor: string } {
  if (!end) return { date: 'No contract end', sub: '', subColor: 'text-gray-600' };
  const days = Math.ceil((new Date(end).getTime() - Date.now()) / 86_400_000);
  const date = fmtDate(end);
  if (days < 0)  return { date, sub: 'EXPIRED',   subColor: 'text-red-400' };
  if (days < 30) return { date, sub: `${days}d remaining`, subColor: 'text-orange-400' };
  if (days < 90) return { date, sub: `${days}d remaining`, subColor: 'text-yellow-400' };
  return                 { date, sub: `${days}d remaining`, subColor: 'text-green-400' };
}

export default function CompaniesPage() {
  const [companies,   setCompanies]   = useState<Company[]>([]);
  const [sitesByCo,   setSitesByCo]   = useState<Record<string, Site[]>>({});
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [showCreate,  setShowCreate]  = useState(false);
  const [createForm,  setCreateForm]  = useState(EMPTY_FORM);
  const [saving,      setSaving]      = useState(false);
  const [formError,   setFormError]   = useState('');
  const [expanded,    setExpanded]    = useState<Set<string>>(new Set());
  const [admins,      setAdmins]      = useState<Record<string, Admin[]>>({});
  const [editId,      setEditId]      = useState<string | null>(null);
  const [editForm,    setEditForm]    = useState(EDIT_EMPTY);
  const [adminModal,  setAdminModal]  = useState<string | null>(null); // company id
  const [adminForm,   setAdminForm]   = useState(ADMIN_FORM_EMPTY);
  const [adminError,  setAdminError]  = useState('');
  const [adminSaving, setAdminSaving] = useState(false);
  const [search,      setSearch]      = useState('');
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  const [editSiteId,  setEditSiteId]  = useState<string | null>(null);
  const [overrideVal, setOverrideVal] = useState('');
  const [savingSite,  setSavingSite]  = useState(false);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const siteRowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});

  const load = useCallback(async () => {
    try {
      const [comps, allSites] = await Promise.all([
        vishnuGet<Company[]>('/api/admin/companies'),
        vishnuGet<Site[]>('/api/admin/all-sites'),
      ]);
      setCompanies(comps);
      const grouped: Record<string, Site[]> = {};
      for (const s of allSites) {
        (grouped[s.company_id] ??= []).push(s);
      }
      setSitesByCo(grouped);
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

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    void loadAdmins(id);
  }

  // Cross-company search: on non-empty query, auto-expand every company that
  // has a matching site and stamp those site rows with amber highlight for 2s.
  // Company-name-only matches keep the company visible but don't auto-expand.
  const searchTerm = search.trim().toLowerCase();
  useEffect(() => {
    if (highlightTimer.current) { clearTimeout(highlightTimer.current); highlightTimer.current = null; }
    if (!searchTerm) { setHighlighted(new Set()); return; }

    const matchedSiteIds  = new Set<string>();
    const matchedCoIds    = new Set<string>();
    for (const co of companies) {
      const coMatches = co.name.toLowerCase().includes(searchTerm);
      const sites = sitesByCo[co.id] ?? [];
      for (const s of sites) {
        if (
          s.name.toLowerCase().includes(searchTerm) ||
          (s.address ?? '').toLowerCase().includes(searchTerm)
        ) {
          matchedSiteIds.add(s.id);
          matchedCoIds.add(co.id);
        }
      }
      if (coMatches) {
        // company-name-only match: keep visible but don't auto-expand
      }
    }
    if (matchedCoIds.size > 0) {
      setExpanded((prev) => {
        const next = new Set(prev);
        Array.from(matchedCoIds).forEach((cid) => next.add(cid));
        return next;
      });
      Array.from(matchedCoIds).forEach((cid) => void loadAdmins(cid));
    }
    setHighlighted(matchedSiteIds);
    if (matchedSiteIds.size > 0) {
      const firstId = Array.from(matchedSiteIds)[0];
      if (firstId) {
        // Scroll the first match into view after the expansion animation.
        requestAnimationFrame(() => {
          siteRowRefs.current[firstId]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
      highlightTimer.current = setTimeout(() => setHighlighted(new Set()), 2000);
    }
    return () => { if (highlightTimer.current) clearTimeout(highlightTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, companies, sitesByCo]);

  // Companies to display: filter out companies with zero matches on non-empty
  // search (so the page focuses on relevant rows), but always include companies
  // whose OWN NAME matches even if no sites match.
  const visibleCompanies = useMemo(() => {
    if (!searchTerm) return companies;
    return companies.filter((co) => {
      if (co.name.toLowerCase().includes(searchTerm)) return true;
      const sites = sitesByCo[co.id] ?? [];
      return sites.some((s) =>
        s.name.toLowerCase().includes(searchTerm) ||
        (s.address ?? '').toLowerCase().includes(searchTerm),
      );
    });
  }, [companies, sitesByCo, searchTerm]);

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
    if (adminForm.password.length < 8 || adminForm.password.length > 128) {
      setAdminError('Minimum 8 characters.'); return;
    }
    setAdminSaving(true); setAdminError('');
    try {
      await vishnuPost(`/api/admin/companies/${companyId}/admins`, {
        name: adminForm.name.trim(),
        email: adminForm.email.trim(),
        password: adminForm.password,
      });
      setAdminModal(null); setAdminForm(ADMIN_FORM_EMPTY);
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

  async function saveOverride(siteId: string) {
    setSavingSite(true);
    try {
      const val = overrideVal === '' ? null : parseInt(overrideVal);
      await vishnuPatch(`/api/admin/sites/${siteId}/photo-limit`, { photo_limit_override: val });
      setEditSiteId(null); setOverrideVal('');
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setSavingSite(false); }
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

      <input
        type="text"
        placeholder="Search sites or companies…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full bg-[#0F1E35] border border-[#1A3050] rounded-lg px-4 py-3 text-gray-300 text-sm focus:outline-none focus:border-gray-500"
      />

      <div className="space-y-3">
        {loading && <p className="text-center text-gray-500 py-10 text-sm">Loading…</p>}
        {!loading && companies.length === 0 && (
          <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-12 text-center">
            <p className="text-gray-500 text-sm">No companies yet. Create the first one.</p>
          </div>
        )}
        {!loading && companies.length > 0 && visibleCompanies.length === 0 && (
          <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-8 text-center">
            <p className="text-gray-500 text-sm">No sites or companies match "{search}".</p>
          </div>
        )}

        {visibleCompanies.map((c) => {
          const isExpanded = expanded.has(c.id);
          const sites = sitesByCo[c.id] ?? [];
          return (
            <div key={c.id} className={`bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden ${!c.is_active ? 'opacity-60' : ''}`}>
              {/* Company row */}
              <div className="p-4 flex items-center gap-4">
                <button
                  onClick={() => toggleExpand(c.id)}
                  className="flex-1 text-left flex items-center gap-4"
                >
                  <span className={`text-xs tracking-widest ${isExpanded ? 'text-gray-300' : 'text-gray-500'}`}>
                    {isExpanded ? '▼' : '▶'}
                  </span>
                  <div className="flex-1 min-w-0">
                    {editId === c.id ? (
                      <input
                        autoFocus
                        value={editForm.name}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                        placeholder={c.name}
                        className="bg-[#0B1526] border border-gray-600 rounded px-2 py-1 text-gray-200 text-sm focus:outline-none focus:border-gray-400 w-48"
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
                      className="bg-[#0B1526] border border-gray-600 rounded px-2 py-1 text-gray-200 text-sm focus:outline-none w-14 text-center"
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
                      <button onClick={() => { setEditId(null); setEditForm(EDIT_EMPTY); }} className="text-xs text-gray-500 border border-[#1A3050] px-2 py-1 rounded hover:border-gray-500 transition-colors">CANCEL</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => { setEditId(c.id); setEditForm({ name: c.name, default_photo_limit: String(c.default_photo_limit) }); }}
                        className="text-xs text-gray-400 border border-[#1A3050] px-2 py-1 rounded hover:border-gray-500 hover:text-gray-200 transition-colors">
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

              {/* Expanded: sites table + admins */}
              {isExpanded && (
                <div className="border-t border-[#1A3050] px-4 pb-4 pt-3 space-y-4">
                  {/* Sites table */}
                  <div>
                    <p className="text-gray-600 text-xs tracking-widest mb-2">SITES</p>
                    {sites.length === 0 ? (
                      <p className="text-gray-600 text-xs">No sites for this company yet.</p>
                    ) : (
                      <div className="bg-[#0B1526] border border-[#1A3050] rounded-lg overflow-x-auto">
                        <table className="w-full text-sm min-w-[720px]">
                          <thead>
                            <tr className="text-gray-600 text-xs tracking-widest border-b border-[#1A3050]">
                              <th className="text-left  p-3">SITE</th>
                              <th className="text-left  p-3">ADDRESS</th>
                              <th className="text-left  p-3">CONTRACT</th>
                              <th className="text-center p-3">ON DUTY</th>
                              <th className="text-center p-3">PHOTO LIMIT OVERRIDE</th>
                              <th className="text-center p-3">STATUS</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sites.map((s) => {
                              const cc = contractCell(s.contract_end);
                              const isHighlighted = highlighted.has(s.id);
                              return (
                                <tr
                                  key={s.id}
                                  ref={(el) => { siteRowRefs.current[s.id] = el; }}
                                  className={`border-b border-[#1A3050] transition-colors duration-1000 ${
                                    isHighlighted ? 'bg-amber-500/20' : (s.is_active ? '' : 'opacity-60')
                                  }`}
                                >
                                  <td className="p-3 text-gray-200">{s.name}</td>
                                  <td className="p-3 text-gray-500 text-xs max-w-[240px] truncate">{s.address}</td>
                                  <td className="p-3">
                                    <p className={`text-xs ${s.contract_end ? 'text-gray-400' : 'text-gray-600 italic'}`}>{cc.date}</p>
                                    {cc.sub && <p className={`text-xs ${cc.subColor}`}>{cc.sub}</p>}
                                  </td>
                                  <td className="p-3 text-center">
                                    <span className={`text-sm font-bold ${parseInt(s.guards_on_duty) > 0 ? 'text-green-400' : 'text-gray-600'}`}>
                                      {s.guards_on_duty}
                                    </span>
                                  </td>
                                  <td className="p-3 text-center">
                                    {editSiteId === s.id ? (
                                      <div className="flex items-center gap-1 justify-center">
                                        <input
                                          autoFocus type="number" min={1} max={20}
                                          value={overrideVal}
                                          onChange={(e) => setOverrideVal(e.target.value)}
                                          placeholder="—"
                                          className="w-12 bg-[#0F1E35] border border-gray-600 rounded px-1 py-0.5 text-gray-200 text-xs text-center focus:outline-none"
                                        />
                                        <button onClick={() => saveOverride(s.id)} disabled={savingSite} className="text-xs text-green-400 hover:text-green-300 disabled:opacity-40">✓</button>
                                        <button onClick={() => { setEditSiteId(null); setOverrideVal(''); }} className="text-xs text-gray-500 hover:text-gray-300">✕</button>
                                      </div>
                                    ) : (
                                      <button
                                        onClick={() => { setEditSiteId(s.id); setOverrideVal(s.photo_limit_override != null ? String(s.photo_limit_override) : ''); }}
                                        className="text-xs text-gray-500 hover:text-gray-300 border border-[#1A3050] hover:border-gray-500 px-2 py-0.5 rounded transition-colors"
                                      >
                                        {s.photo_limit_override != null ? `${s.photo_limit_override} ✎` : 'SET'}
                                      </button>
                                    )}
                                  </td>
                                  <td className="p-3 text-center">
                                    <span className={`text-xs tracking-widest ${s.is_active ? 'text-green-400' : 'text-gray-600'}`}>
                                      {s.is_active ? 'ACTIVE' : 'INACTIVE'}
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {/* Admins */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-gray-600 text-xs tracking-widest">ADMINS</p>
                      <button
                        onClick={() => { setAdminModal(c.id); setAdminForm(ADMIN_FORM_EMPTY); setAdminError(''); }}
                        className="text-xs text-gray-400 border border-[#1A3050] px-2 py-0.5 rounded hover:border-gray-500 hover:text-gray-200 transition-colors"
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
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Create Admin Modal */}
      {adminModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4">
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
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-gray-400"
                />
              </div>
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">EMAIL *</label>
                <input type="email" value={adminForm.email}
                  onChange={(e) => setAdminForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="admin@company.com"
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-gray-400"
                />
              </div>
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">PASSWORD *</label>
                <input type="password" value={adminForm.password}
                  onChange={(e) => setAdminForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="Min 8 characters"
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-gray-400"
                />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setAdminModal(null)} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
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
          <div className="w-full max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4">
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
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-gray-400"
                />
              </div>
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">DEFAULT PHOTO LIMIT PER REPORT</label>
                <div className="flex items-center gap-3">
                  <input
                    type="number" min={1} max={20}
                    value={createForm.default_photo_limit}
                    onChange={(e) => setCreateForm((f) => ({ ...f, default_photo_limit: e.target.value }))}
                    className="w-24 bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-gray-400"
                  />
                  <span className="text-gray-600 text-xs">Max 20. Can be overridden per site.</span>
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowCreate(false)} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
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
