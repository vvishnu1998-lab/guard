'use client';
/**
 * Admin — CLIENT PORTALS (/admin/clients)
 *
 * Single management surface for everything client-portal-adjacent per site:
 *   * client accounts (list + add + edit + reset password + deactivate)
 *   * per-site PREVIEW AS CLIENT (30-min read-only JWT)
 *   * portal enable/disable (bumps clients.tokens_not_before + toggles
 *     sites.client_access_disabled_at)
 *
 * Retention rebuild removed the CLIENT ACCESS UNTIL + DATA DELETION date
 * overrides (per-row expires_at on the child tables owns that now). What
 * remains is a lean PORTAL ACCESS section wrapping the enable/disable
 * toggle.
 *
 * The /admin/sites expanded panel deep-links here via ?site=<siteId>.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { adminGet, adminPatch, adminPost, adminDelete } from '../../../lib/adminApi';

interface Site {
  id:                          string;
  name:                        string;
  address:                     string;
  is_active:                   boolean;
  client_access_disabled_at:   string | null;
  company_id:                  string;
  company_name?:               string;
}

interface Client {
  id:                   string;
  site_id:              string;
  name:                 string;
  email:                string;
  is_active:            boolean;
  must_change_password: boolean;
  created_at:           string;
  last_login_at:        string | null;
  // v36 multi-site: every OTHER site this client is linked to (junction rows).
  // Populated by the GET /api/clients/:site_id handler via a subquery.
  sites:                { id: string; name: string }[];
}

interface CredentialsBanner {
  email:         string;
  temp_password: string;
  mode:          'created' | 'reset' | 'resent';
  email_status?: 'sent' | 'failed';
}

type StatusFilter = 'active' | 'inactive' | 'all';

const STATUS_CHIPS: StatusFilter[] = ['active', 'inactive', 'all'];

// Cryptographically secure 12-char temp password for the ADD CLIENT modal.
const TEMP_PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function generateTempPasswordClient(length = 12): string {
  const bytes = new Uint8Array(length);
  if (typeof window === 'undefined' || !window.crypto?.getRandomValues) {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  } else {
    window.crypto.getRandomValues(bytes);
  }
  let out = '';
  for (let i = 0; i < length; i++) out += TEMP_PW_ALPHABET[bytes[i] % TEMP_PW_ALPHABET.length];
  return out;
}

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

export default function ClientPortalsPage() {
  return (
    <Suspense fallback={<p className="text-gray-500 text-sm">Loading…</p>}>
      <ClientPortalsPageInner />
    </Suspense>
  );
}

function ClientPortalsPageInner() {
  const searchParams = useSearchParams();
  const targetSiteId = searchParams?.get('site') ?? null;

  const [sites,   setSites]   = useState<Site[]>([]);
  const [clientsPerSite, setClientsPerSite] = useState<Record<string, Client[]>>({});
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const [search,       setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');

  const [credentialsBanner, setCredentialsBanner] = useState<CredentialsBanner | null>(null);

  // Add / edit client modal
  const [clientModalMode, setClientModalMode] = useState<'add' | 'edit' | null>(null);
  const [clientModalSite, setClientModalSite] = useState<string | null>(null);
  const [editingClient,   setEditingClient]   = useState<Client | null>(null);
  const [clientForm,      setClientForm]      = useState({ name: '', email: '', password: '' });
  const [clientSaving,    setClientSaving]    = useState(false);
  const [clientFormError, setClientFormError] = useState('');
  const [clientToggling,  setClientToggling]  = useState<string | null>(null);

  // Portal toggle in-flight indicator
  const [portalToggling,  setPortalToggling]  = useState<string | null>(null);

  // v36 multi-site — ADD SITE modal + inline REMOVE FROM SITE state.
  // linkModalClient is set when the admin clicks "+ SITE" on a client row;
  // it opens a picker of the company's remaining active sites.
  const [linkModalClient, setLinkModalClient] = useState<Client | null>(null);
  const [linkModalCompanyId, setLinkModalCompanyId] = useState<string | null>(null);
  const [linkSaving,      setLinkSaving]      = useState<string | null>(null);
  const [siteLinkError,   setSiteLinkError]   = useState('');
  const [unlinkingKey,    setUnlinkingKey]    = useState<string | null>(null);

  // Scrolling to ?site=<id> after data loads.
  const scrollAppliedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const s = await adminGet<Site[]>('/api/sites');
      setSites(s);
      const entries = await Promise.all(
        s.map(async (site) => {
          try {
            const list = await adminGet<Client[]>(`/api/clients/${site.id}`);
            return [site.id, list] as const;
          } catch {
            return [site.id, [] as Client[]] as const;
          }
        })
      );
      setClientsPerSite(Object.fromEntries(entries));
      setError('');
    } catch (e: any) { setError(e?.message ?? 'Failed to load'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Deep-link scroll after data settles.
  useEffect(() => {
    if (loading || !targetSiteId || scrollAppliedRef.current) return;
    const el = document.getElementById(`site-${targetSiteId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      scrollAppliedRef.current = true;
    }
  }, [loading, targetSiteId]);

  // Vishnu multi-company label — same conditional pattern as guards/shifts/sites.
  const showCompanyLabel = useMemo(() => {
    const set = new Set<string>();
    for (const s of sites) if (s.company_name) set.add(s.company_name);
    return set.size > 1;
  }, [sites]);

  // Filter each site's client list against the chip + search.
  function matchesClient(c: Client, q: string): boolean {
    if (!q) return true;
    const s = q.toLowerCase();
    return c.email.toLowerCase().includes(s) || c.name.toLowerCase().includes(s);
  }
  function matchesSite(site: Site, q: string): boolean {
    if (!q) return true;
    const s = q.toLowerCase();
    return site.name.toLowerCase().includes(s) || (site.address ?? '').toLowerCase().includes(s);
  }

  const visibleSites = useMemo(() => {
    const q = search.trim();
    // Show a site if it matches the search OR any of its clients match.
    return [...sites]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .filter((site) => {
        if (matchesSite(site, q)) return true;
        return (clientsPerSite[site.id] ?? []).some((c) => matchesClient(c, q));
      });
  }, [sites, search, clientsPerSite]);

  function clientsForSite(siteId: string): Client[] {
    const all = clientsPerSite[siteId] ?? [];
    const q = search.trim();
    return all
      .filter((c) =>
        statusFilter === 'all' ? true
        : statusFilter === 'active' ? c.is_active
        : !c.is_active
      )
      .filter((c) => matchesClient(c, q) || matchesSite(sites.find((s) => s.id === siteId)!, q))
      .sort((a, b) => {
        if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
        return a.email.localeCompare(b.email, undefined, { sensitivity: 'base' });
      });
  }

  // ── Modal handlers ────────────────────────────────────────────────────
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
    setClientModalMode(null); setClientModalSite(null); setEditingClient(null);
    setClientForm({ name: '', email: '', password: '' }); setClientFormError('');
  }
  function regenerateTempPassword() {
    setClientForm((f) => ({ ...f, password: generateTempPasswordClient(12) }));
  }

  async function saveNewClient() {
    if (!clientModalSite) return;
    const name  = clientForm.name.trim();
    const email = clientForm.email.trim().toLowerCase();
    if (name.length < 2)         { setClientFormError('Full name must be at least 2 characters'); return; }
    if (!email.includes('@'))    { setClientFormError('Enter a valid email address'); return; }
    setClientSaving(true); setClientFormError('');
    try {
      const r = await adminPost<{ client: Client; temp_password?: string }>('/api/clients', {
        site_id: clientModalSite, name, email, password: clientForm.password,
      });
      setCredentialsBanner({ email: r.client.email, temp_password: clientForm.password, mode: 'created' });
      const target = clientModalSite;
      closeClientModal();
      // Refresh just this site's clients.
      try {
        const list = await adminGet<Client[]>(`/api/clients/${target}`);
        setClientsPerSite((prev) => ({ ...prev, [target]: list }));
      } catch { /* fall through to next full load */ }
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
      const target = clientModalSite;
      closeClientModal();
      if (target) {
        const list = await adminGet<Client[]>(`/api/clients/${target}`);
        setClientsPerSite((prev) => ({ ...prev, [target]: list }));
      }
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
      setCredentialsBanner({ email: r.email, temp_password: r.temp_password, mode: 'reset' });
      const target = clientModalSite;
      closeClientModal();
      if (target) {
        const list = await adminGet<Client[]>(`/api/clients/${target}`);
        setClientsPerSite((prev) => ({ ...prev, [target]: list }));
      }
    } catch (e: any) { setClientFormError(e?.message ?? 'Failed to reset password'); }
    finally { setClientSaving(false); }
  }

  async function resendClientWelcome() {
    if (!editingClient) return;
    if (!confirm(`Resend welcome email to ${editingClient.email}? A new temporary password will be generated and the old one will stop working.`)) return;
    setClientSaving(true); setClientFormError('');
    try {
      const r = await adminPost<{ temp_password: string; email_status: 'sent' | 'failed' }>(
        `/api/clients/${editingClient.id}/resend-welcome`, {},
      );
      setCredentialsBanner({
        email:         editingClient.email,
        temp_password: r.temp_password,
        mode:          'resent',
        email_status:  r.email_status,
      });
      const target = clientModalSite;
      closeClientModal();
      if (target) {
        const list = await adminGet<Client[]>(`/api/clients/${target}`);
        setClientsPerSite((prev) => ({ ...prev, [target]: list }));
      }
    } catch (e: any) { setClientFormError(e?.message ?? 'Failed to resend welcome email'); }
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
      const list = await adminGet<Client[]>(`/api/clients/${siteId}`);
      setClientsPerSite((prev) => ({ ...prev, [siteId]: list }));
    } catch (e: any) { setError(e?.message ?? 'Failed to update client'); }
    finally { setClientToggling(null); }
  }

  // ── Portal enable/disable + preview + retention ───────────────────────
  async function togglePortal(site: Site) {
    const enabled = !!site.client_access_disabled_at;   // currently DISABLED → enabling
    const msg = enabled
      ? `Enable client portal for ${site.name}?`
      : `Disable client portal for ${site.name}? Any active client sessions end immediately.`;
    if (!confirm(msg)) return;
    setPortalToggling(site.id);
    try {
      await adminPatch(`/api/sites/${site.id}/client-access`, { enabled });
      await load();
    } catch (e: any) { setError(e?.message ?? 'Failed to toggle portal'); }
    finally { setPortalToggling(null); }
  }

  async function previewAsClient(siteId: string) {
    try {
      const r = await adminPost<{ access_token: string; expires_in: number }>(
        `/api/admin/sites/${siteId}/preview-client-token`, {},
      );
      window.open(`/client?preview=${encodeURIComponent(r.access_token)}`, '_blank', 'noopener');
    } catch (e: any) { setError(e?.message ?? 'Preview failed'); }
  }

  // v36 multi-site — pull a client's sites row after a link/unlink and
  // patch every site-section that shows it (a client may appear in >1
  // section now). Cheaper than a full page reload and keeps the
  // section-scoped state model.
  async function refreshClientAcrossSites(client: Client) {
    // Union of: sections the client is currently in + sections they were
    // in before the mutation (both site_id + every entry from client.sites).
    const impacted = new Set<string>([client.site_id, ...client.sites.map((s) => s.id)]);
    const updates = await Promise.all(
      Array.from(impacted).map(async (siteId) => {
        try {
          const list = await adminGet<Client[]>(`/api/clients/${siteId}`);
          return [siteId, list] as const;
        } catch {
          return [siteId, clientsPerSite[siteId] ?? []] as const;
        }
      }),
    );
    setClientsPerSite((prev) => {
      const next = { ...prev };
      for (const [siteId, list] of updates) next[siteId] = list;
      return next;
    });
  }

  function openLinkSiteModal(client: Client) {
    const currentSite = sites.find((s) => s.id === client.site_id);
    setLinkModalClient(client);
    setLinkModalCompanyId(currentSite?.company_id ?? null);
    setSiteLinkError('');
  }
  function closeLinkSiteModal() {
    setLinkModalClient(null);
    setLinkModalCompanyId(null);
    setSiteLinkError('');
  }

  async function linkClientToSite(client: Client, siteId: string) {
    setLinkSaving(siteId);
    setSiteLinkError('');
    try {
      await adminPost(`/api/clients/${client.id}/sites`, { site_id: siteId });
      closeLinkSiteModal();
      await refreshClientAcrossSites({ ...client, sites: [...client.sites, { id: siteId, name: '' }] });
    } catch (e: any) {
      setSiteLinkError(e?.message ?? 'Could not link site');
    } finally {
      setLinkSaving(null);
    }
  }

  async function unlinkClientFromSite(client: Client, siteId: string) {
    const linkedCount = client.sites.length;
    if (linkedCount <= 1) {
      setError('Cannot remove the client\'s last site. Deactivate the client or add another site first.');
      return;
    }
    const siteName = client.sites.find((s) => s.id === siteId)?.name ?? 'this site';
    if (!confirm(`Remove ${client.email} from ${siteName}? Their session will end and they'll lose access to this site.`)) return;
    const key = `${client.id}::${siteId}`;
    setUnlinkingKey(key);
    try {
      await adminDelete(`/api/clients/${client.id}/sites/${siteId}`);
      await refreshClientAcrossSites(client);
    } catch (e: any) {
      setError(e?.message ?? 'Could not unlink site');
    } finally {
      setUnlinkingKey(null);
    }
  }

  function copyCredentialsToClipboard(b: CredentialsBanner) {
    const text = `Portal: https://netraops.com/portal\nEmail: ${b.email}\nPassword: ${b.temp_password}`;
    navigator.clipboard?.writeText(text).catch(() => { /* ignore */ });
  }

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl md:text-3xl font-bold tracking-widest text-amber-400">CLIENT PORTALS</h1>
        <div className="flex flex-wrap gap-3 items-center">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clients or sites…"
            className="bg-[#0F1E35] border border-[#1A3050] text-gray-200 text-sm rounded-lg px-3 py-2 min-w-[240px] focus:outline-none focus:border-amber-400"
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
        </div>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      {credentialsBanner && (() => {
        const failed = credentialsBanner.mode === 'resent' && credentialsBanner.email_status === 'failed';
        const headline =
          credentialsBanner.mode === 'created' ? 'Client created. Share these credentials:'
          : credentialsBanner.mode === 'reset'  ? 'New temp password ready. Share these credentials:'
          : failed                              ? '⚠️ Email delivery failed — share these credentials manually:'
                                                : '✅ Welcome email sent. New temp password:';
        return (
          <div className={`text-sm rounded-lg px-4 py-3 flex items-start justify-between gap-3 border ${
            failed ? 'bg-amber-900/40 border-amber-500 text-amber-200'
                   : 'bg-green-900/40 border-green-500 text-green-300'
          }`}>
            <div className="min-w-0 flex-1">
              <p className={`font-medium mb-1 ${failed ? 'text-amber-100' : 'text-green-200'}`}>{headline}</p>
              <p className="text-sm leading-6">
                Portal: <span className="font-mono">https://netraops.com/portal</span><br />
                Email: <span className="font-mono">{credentialsBanner.email}</span><br />
                Password: <span className="font-mono font-bold">{credentialsBanner.temp_password}</span>
              </p>
              <p className={`text-xs mt-2 ${failed ? 'text-amber-300' : 'text-green-400'}`}>
                Client will be prompted to change the password on first login.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => copyCredentialsToClipboard(credentialsBanner)}
                className={`text-xs tracking-widest border rounded px-3 py-1 ${
                  failed ? 'text-amber-200 hover:text-amber-50 border-amber-500/40 hover:bg-amber-500/10'
                         : 'text-green-300 hover:text-green-100 border-green-500/40 hover:bg-green-500/10'
                }`}
              >
                COPY
              </button>
              <button
                onClick={() => setCredentialsBanner(null)}
                aria-label="Dismiss"
                className={`text-lg leading-none ${failed ? 'text-amber-300 hover:text-amber-100' : 'text-green-400 hover:text-green-200'}`}
              >
                ✕
              </button>
            </div>
          </div>
        );
      })()}

      {loading && <p className="text-center text-gray-500 py-10">Loading…</p>}
      {!loading && visibleSites.length === 0 && (
        <p className="text-center text-gray-500 py-10">No sites match your criteria.</p>
      )}

      {/* Site sections */}
      {!loading && visibleSites.map((site) => {
        const siteClients = clientsForSite(site.id);
        const portalEnabled = !site.client_access_disabled_at;
        const siteSearchMatch = matchesSite(site, search.trim());
        return (
          <section
            key={site.id}
            id={`site-${site.id}`}
            className={`bg-[#0F1E35] border rounded-xl p-6 space-y-4 scroll-mt-6 ${
              targetSiteId === site.id ? 'border-amber-400/60 shadow-lg shadow-amber-400/10' : 'border-[#1A3050]'
            }`}
          >
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <h2 className="text-gray-100 font-bold tracking-widest text-lg">
                  {site.name}
                  {!site.is_active && (
                    <span className="ml-2 text-[10px] tracking-widest text-gray-400 bg-gray-800/60 border border-gray-700 rounded px-1.5 py-0.5">INACTIVE SITE</span>
                  )}
                </h2>
                {site.address && <p className="text-gray-500 text-xs mt-0.5">{site.address}</p>}
                {showCompanyLabel && site.company_name && (
                  <p className="text-gray-600 text-[10px] tracking-widest mt-1">{site.company_name.toUpperCase()}</p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {portalEnabled ? (
                  <span className="inline-flex items-center gap-1.5 text-xs tracking-widest text-green-400 bg-green-400/10 border border-green-400/30 px-2 py-0.5 rounded">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" /> ENABLED
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs tracking-widest text-red-400 bg-red-400/10 border border-red-400/30 px-2 py-0.5 rounded">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-400 inline-block" /> DISABLED
                  </span>
                )}
              </div>
            </div>

            {/* PORTAL ACCESS */}
            <div className="bg-[#0B1526] border border-[#1A3050] rounded-lg p-4 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <p className="text-gray-500 text-xs tracking-widest mb-1">PORTAL ACCESS</p>
                <p className="text-gray-400 text-[11px]">
                  {portalEnabled
                    ? 'Client portal is enabled. Clients at this site can log in.'
                    : 'Client portal is disabled. Logins are blocked until re-enabled.'}
                </p>
              </div>
              <button
                onClick={() => togglePortal(site)}
                disabled={portalToggling === site.id || !site.is_active}
                className={`text-xs tracking-widest px-3 py-1.5 rounded transition-colors border disabled:opacity-40 ${
                  portalEnabled
                    ? 'text-red-400 border-red-500/40 hover:bg-red-500/10 hover:border-red-400'
                    : 'text-green-400 border-green-500/40 hover:bg-green-500/10 hover:border-green-400'
                }`}
              >
                {portalToggling === site.id ? '…' : portalEnabled ? 'DISABLE PORTAL' : 'ENABLE PORTAL'}
              </button>
            </div>

            {/* CLIENTS AT THIS SITE */}
            <div className="space-y-2">
              <p className="text-gray-500 text-xs tracking-widest">CLIENTS AT THIS SITE</p>
              {siteClients.length === 0 ? (
                <p className="text-gray-600 text-xs">
                  {clientsPerSite[site.id]?.length ? 'No clients match the current filter.' : 'No clients yet.'}
                </p>
              ) : (
                siteClients.map((c) => (
                  <div key={c.id}
                    className={`bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 flex items-center gap-3 flex-wrap ${!c.is_active ? 'opacity-60' : ''}`}>
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
                      {/* v36 multi-site: chip row of every site this client is linked to,
                          with an inline × per chip and a + SITE button that opens the picker. */}
                      <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                        <span className="text-[10px] tracking-widest text-gray-600">SITES:</span>
                        {c.sites.map((s) => {
                          const key = `${c.id}::${s.id}`;
                          const isOnlySite = c.sites.length <= 1;
                          return (
                            <span
                              key={s.id}
                              className="inline-flex items-center gap-1 text-[10px] tracking-widest text-gray-300 bg-[#1A3050]/40 border border-[#1A3050] rounded px-1.5 py-0.5"
                            >
                              {s.name || s.id.slice(0, 6)}
                              <button
                                type="button"
                                onClick={() => unlinkClientFromSite(c, s.id)}
                                disabled={isOnlySite || unlinkingKey === key || !site.is_active}
                                title={isOnlySite ? 'Client must have at least one site' : `Remove from ${s.name}`}
                                aria-label={`Remove ${c.email} from ${s.name}`}
                                className="text-gray-500 hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed"
                              >
                                {unlinkingKey === key ? '…' : '×'}
                              </button>
                            </span>
                          );
                        })}
                        <button
                          type="button"
                          onClick={() => openLinkSiteModal(c)}
                          disabled={!site.is_active}
                          className="text-[10px] tracking-widest text-amber-400 hover:text-amber-300 border border-amber-400/30 rounded px-1.5 py-0.5 hover:bg-amber-400/10 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          + SITE
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => openEditClientModal(site.id, c)}
                        disabled={!site.is_active}
                        className="text-xs text-gray-400 hover:text-amber-400 tracking-widest disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        EDIT
                      </button>
                      <button
                        onClick={() => toggleClientActive(c, site.id)}
                        disabled={clientToggling === c.id || !site.is_active}
                        className={`text-xs tracking-widest disabled:opacity-40 disabled:cursor-not-allowed ${
                          c.is_active ? 'text-red-400 hover:text-red-300' : 'text-green-400 hover:text-green-300'
                        }`}
                      >
                        {clientToggling === c.id ? '…' : c.is_active ? 'DEACTIVATE' : 'REACTIVATE'}
                      </button>
                      <button
                        onClick={() => previewAsClient(site.id)}
                        disabled={!site.is_active || !portalEnabled}
                        title="Opens client portal in a new tab as read-only for 30 minutes."
                        className="text-xs text-cyan-400 hover:text-cyan-300 tracking-widest disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        PREVIEW ↗
                      </button>
                    </div>
                  </div>
                ))
              )}
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  onClick={() => openAddClientModal(site.id)}
                  disabled={!site.is_active}
                  className="text-xs text-amber-400 tracking-widest border border-amber-400/40 rounded px-3 py-1.5 hover:bg-amber-400/10 hover:border-amber-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  + ADD CLIENT
                </button>
              </div>
            </div>
            {/* If the search matched only the site (not any client), leave a hint. */}
            {search.trim() && siteSearchMatch && siteClients.length === 0 && (clientsPerSite[site.id]?.length ?? 0) > 0 && (
              <p className="text-gray-600 text-[11px]">
                Site name matched — showing all clients regardless of the "{statusFilter.toUpperCase()}" filter.
              </p>
            )}
          </section>
        );
      })}

      {/* ── Add / Edit Client Modal ───────────────────────────────────── */}
      {clientModalMode !== null && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60">
          <div className="w-full sm:max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-t-2xl sm:rounded-2xl p-6">
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
                  type="text" placeholder="e.g. Jane Property Manager"
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
              </div>
              {clientModalMode === 'add' && (
                <div>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">TEMPORARY PASSWORD</label>
                  <div className="flex gap-2">
                    <input
                      type="text" readOnly
                      value={clientForm.password}
                      className="flex-1 bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 font-mono text-sm select-all focus:outline-none focus:border-amber-400"
                    />
                    <button
                      type="button"
                      onClick={regenerateTempPassword}
                      title="Regenerate"
                      className="bg-[#0B1526] border border-[#1A3050] text-gray-400 hover:border-amber-400 hover:text-amber-400 rounded-lg px-3 py-2 text-sm transition-colors"
                    >
                      🔄
                    </button>
                  </div>
                  <p className="text-gray-500 text-xs mt-1">Client will be prompted to change on first login.</p>
                </div>
              )}
              {clientModalMode === 'edit' && editingClient && (
                <div className="bg-[#0B1526] border border-[#1A3050] rounded-lg p-3">
                  <p className="text-gray-500 text-xs tracking-widest mb-1">PASSWORD</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={resetClientPassword}
                      disabled={clientSaving}
                      className="text-xs text-amber-400 tracking-widest border border-amber-400/40 rounded px-3 py-1.5 hover:bg-amber-400/10 hover:border-amber-400 transition-colors disabled:opacity-40"
                    >
                      RESET PASSWORD
                    </button>
                    {editingClient.must_change_password && (
                      <button
                        type="button"
                        onClick={resendClientWelcome}
                        disabled={clientSaving}
                        className="text-xs text-cyan-400 tracking-widest border border-cyan-400/40 rounded px-3 py-1.5 hover:bg-cyan-400/10 hover:border-cyan-400 transition-colors disabled:opacity-40"
                      >
                        ↻ RESEND WELCOME EMAIL
                      </button>
                    )}
                  </div>
                  <p className="text-gray-500 text-xs mt-2">Reset mints a new temp password. Resend also fires the welcome template.</p>
                </div>
              )}
              <p className="text-gray-500 text-xs">
                Portal: <span className="text-gray-300 font-mono">https://netraops.com/portal</span> — client logs in with their email.
              </p>
            </div>
            <div className="flex gap-3 mt-6">
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

      {/* ── v36 Link Client to Additional Site Modal ─────────────────── */}
      {linkModalClient && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60">
          <div className="w-full sm:max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-t-2xl sm:rounded-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">ADD SITE</h2>
              <button onClick={closeLinkSiteModal} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            <p className="text-gray-400 text-sm mb-4">
              Link <span className="text-gray-200 font-medium">{linkModalClient.email}</span> to another active site.
              They&apos;ll be able to switch between their linked sites from the client portal.
            </p>
            {siteLinkError && (
              <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{siteLinkError}</div>
            )}
            {(() => {
              const alreadyLinkedIds = new Set(linkModalClient.sites.map((s) => s.id));
              const candidateSites = sites
                .filter((s) => s.is_active)
                .filter((s) => !linkModalCompanyId || s.company_id === linkModalCompanyId)
                .filter((s) => !alreadyLinkedIds.has(s.id))
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
              if (candidateSites.length === 0) {
                return (
                  <p className="text-gray-500 text-sm">
                    No other active sites to link. Reactivate a site or ask Vishnu to add one.
                  </p>
                );
              }
              return (
                <div className="space-y-2 max-h-[400px] overflow-y-auto">
                  {candidateSites.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => linkClientToSite(linkModalClient, s.id)}
                      disabled={linkSaving !== null}
                      className="w-full text-left bg-[#0B1526] border border-[#1A3050] hover:border-amber-400/60 rounded-lg px-3 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <p className="text-gray-200 text-sm font-medium truncate">{s.name}</p>
                      {s.address && <p className="text-gray-500 text-xs mt-0.5 truncate">{s.address}</p>}
                      {linkSaving === s.id && <p className="text-amber-400 text-[10px] tracking-widest mt-1">LINKING…</p>}
                    </button>
                  ))}
                </div>
              );
            })()}
            <div className="mt-6">
              <button
                onClick={closeLinkSiteModal}
                className="w-full border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors"
              >
                CANCEL
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
