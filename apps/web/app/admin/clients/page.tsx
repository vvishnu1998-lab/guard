'use client';
/**
 * Admin — Client Portals Management (/admin/clients)
 * Create / view client portal accounts for each site.
 * Each site can have one client account (read-only access to their site's data).
 */
import { useCallback, useEffect, useState } from 'react';
import { adminGet, adminPost } from '../../../lib/adminApi';

interface Site {
  id:   string;
  name: string;
}

interface Client {
  id:         string;
  site_id:    string;
  name:       string;
  email:      string;
  is_active:  boolean;
  created_at: string;
}

const EMPTY = { site_id: '', name: '', email: '', password: '' };

export default function ClientPortalsPage() {
  const [sites,      setSites]      = useState<Site[]>([]);
  const [clients,    setClients]    = useState<Record<string, Client | null>>({});
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [showModal,  setShowModal]  = useState(false);
  const [form,       setForm]       = useState(EMPTY);
  const [saving,     setSaving]     = useState(false);
  const [formError,  setFormError]  = useState('');

  const load = useCallback(async () => {
    try {
      const s = await adminGet<Site[]>('/api/sites');
      setSites(s);
      // Fetch client account for each site in parallel
      const entries = await Promise.all(
        s.map(async (site) => {
          try {
            const c = await adminGet<Client | null>(`/api/clients/${site.id}`);
            return [site.id, c] as const;
          } catch {
            return [site.id, null] as const;
          }
        })
      );
      setClients(Object.fromEntries(entries));
      setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createClient() {
    const { site_id, name, email, password } = form;
    if (!site_id || !name || !email || !password) { setFormError('All fields required'); return; }
    if (password.length < 8) { setFormError('Password must be at least 8 characters'); return; }
    setSaving(true); setFormError('');
    try {
      await adminPost('/api/clients', form);
      setShowModal(false); setForm(EMPTY);
      await load();
    } catch (e: any) { setFormError(e.message); }
    finally { setSaving(false); }
  }

  // Sites without a client account yet
  const sitesWithoutClient = sites.filter((s) => !clients[s.id]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-widest text-amber-400">CLIENT PORTALS</h1>
        <button
          onClick={() => { setShowModal(true); setFormError(''); setForm(EMPTY); }}
          disabled={sitesWithoutClient.length === 0}
          className="bg-amber-400 text-gray-900 font-bold tracking-widest text-sm px-4 py-2 rounded-lg hover:bg-amber-300 disabled:opacity-40 transition-colors"
        >
          + ADD CLIENT ACCOUNT
        </button>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-xs tracking-widest border-b border-[#1A3050]">
              <th className="text-left p-4">SITE</th>
              <th className="text-left p-4">CLIENT ACCOUNT</th>
              <th className="text-left p-4">EMAIL</th>
              <th className="text-center p-4">STATUS</th>
              <th className="text-left p-4">CREATED</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5} className="text-center text-gray-500 py-10">Loading…</td></tr>}
            {!loading && sites.length === 0 && (
              <tr><td colSpan={5} className="text-center text-gray-500 py-10">No sites yet — create a site first</td></tr>
            )}
            {sites.map((site) => {
              const client = clients[site.id];
              return (
                <tr key={site.id} className="border-b border-[#1A3050] hover:bg-[#0B1526] transition-colors">
                  <td className="p-4 text-gray-200 font-medium">{site.name}</td>
                  <td className="p-4">
                    {client ? (
                      <span className="text-gray-300">{client.name}</span>
                    ) : (
                      <span className="text-gray-600 text-xs tracking-widest">—  NO ACCOUNT</span>
                    )}
                  </td>
                  <td className="p-4 text-gray-500 text-xs">{client?.email ?? '—'}</td>
                  <td className="p-4 text-center">
                    {client ? (
                      <span className={`text-xs tracking-widest ${client.is_active ? 'text-green-400' : 'text-gray-600'}`}>
                        {client.is_active ? 'ACTIVE' : 'INACTIVE'}
                      </span>
                    ) : (
                      <span className="text-gray-700 text-xs tracking-widest">—</span>
                    )}
                  </td>
                  <td className="p-4 text-gray-600 text-xs">
                    {client ? new Date(client.created_at).toLocaleDateString('en-GB') : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-5 text-sm text-gray-500 space-y-1">
        <p className="text-amber-400 font-bold tracking-widest text-xs mb-2">CLIENT PORTAL ACCESS</p>
        <p>Each site can have one client portal account. The client gets read-only access to their site's reports, guard schedule, and PDF downloads.</p>
        <p>Clients log in at <span className="text-gray-300 font-mono">/client/login</span> and cannot see data from other sites.</p>
      </div>

      {/* Create Client Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">ADD CLIENT ACCOUNT</h2>
              <button onClick={() => setShowModal(false)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            {formError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{formError}</div>}
            <div className="space-y-4">
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">SITE <span className="text-amber-400">*</span></label>
                <select
                  value={form.site_id}
                  onChange={(e) => setForm((f) => ({ ...f, site_id: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                >
                  <option value="">Select site…</option>
                  {sitesWithoutClient.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              {([
                ['name',     'CONTACT NAME',  'text',     'e.g. John Smith'],
                ['email',    'EMAIL',         'email',    'client@yoursite.com'],
                ['password', 'PASSWORD',      'password', 'Min 8 characters'],
              ] as const).map(([key, label, type, ph]) => (
                <div key={key}>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">{label} <span className="text-amber-400">*</span></label>
                  <input
                    type={type} placeholder={ph} value={(form as any)[key]}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                    className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                  />
                </div>
              ))}
            </div>
            <p className="text-gray-600 text-xs mt-3 mb-5">The client will log in at /client/login with read-only access to their site.</p>
            <div className="flex gap-3">
              <button onClick={() => setShowModal(false)} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
              <button onClick={createClient} disabled={saving} className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors">
                {saving ? 'CREATING…' : 'CREATE'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
