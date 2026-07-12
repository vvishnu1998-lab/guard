'use client';
/**
 * Client site picker — shown after login when a client covers >1 site
 * (schema_v36 multi-site). Also reachable via the "Switch Site" link in
 * the header. Fetches the accessible-sites list from GET /api/client/sites
 * on mount so it reflects any admin-side link/unlink/disable that happened
 * since the login token was minted.
 *
 * On pick: POST /api/client/switch-site → new access + refresh tokens →
 * swap both cookies → redirect to /client (or wherever the user was
 * before if there's a ?from=<path> param).
 */
import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import { useSearchParams } from 'next/navigation';
import { clientFetch, clientGet } from '../../../lib/clientApi';

interface Site {
  id:      string;
  name:    string;
  address: string | null;
}

interface SitesResponse {
  sites:          Site[];
  active_site_id: string;
}

function safeFromPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//')) return null;
  return raw;
}

export default function ClientSelectSitePage() {
  const searchParams = useSearchParams();
  const fromPath     = safeFromPath(searchParams?.get('from')) ?? '/client';

  const [sites,        setSites]        = useState<Site[]>([]);
  const [activeSiteId, setActiveSiteId] = useState<string | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [switching,    setSwitching]    = useState<string | null>(null);
  const [error,        setError]        = useState('');

  const load = useCallback(async () => {
    try {
      const r = await clientGet<SitesResponse>('/api/client/sites');
      setSites(r.sites ?? []);
      setActiveSiteId(r.active_site_id ?? null);
      setError('');
    } catch (e: any) {
      if (e.message?.includes('401') || e.message?.includes('Missing') || e.message?.includes('Invalid')) {
        window.location.href = '/client/login';
        return;
      }
      setError(e.message ?? 'Could not load sites');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function pickSite(siteId: string) {
    setSwitching(siteId);
    setError('');
    try {
      const res = await clientFetch('/api/client/switch-site', {
        method: 'POST',
        body:   JSON.stringify({ site_id: siteId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Could not switch site');
        setSwitching(null);
        return;
      }
      document.cookie = `guard_client_access=${data.access}; path=/; max-age=28800; SameSite=Strict`;
      document.cookie = `guard_client_refresh=${data.refresh}; path=/; max-age=2592000; SameSite=Strict`;
      window.location.href = fromPath;
    } catch {
      setError('Network error. Please try again.');
      setSwitching(null);
    }
  }

  return (
    <main className="min-h-screen bg-[#060E1A] flex items-center justify-center p-8">
      <div className="w-full max-w-[520px]">
        <div className="flex items-center gap-3 mb-10">
          <Image
            src="/vwing_logo.png"
            alt="Netra"
            width={32}
            height={32}
            className="object-contain"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
          <span className="text-white font-black tracking-[0.2em] text-lg">NETRA</span>
        </div>

        <p className="text-blue-400 text-[11px] tracking-[0.3em] font-semibold mb-3">SELECT SITE</p>
        <h1 className="text-white font-black text-3xl tracking-tight mb-2">Which site are you visiting?</h1>
        <p className="text-white/35 text-sm mb-10 tracking-wide">
          You have access to more than one site. Pick one to continue — you can switch later from the header.
        </p>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3.5 mb-6 text-red-400 text-sm">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-white/40 text-sm">Loading sites…</p>
        ) : sites.length === 0 ? (
          <div className="bg-white/[0.03] border border-white/[0.08] rounded-lg p-6 text-white/60 text-sm">
            No accessible sites. Contact your security provider.
          </div>
        ) : (
          <div className="space-y-3">
            {sites.map((s) => {
              const isActive    = s.id === activeSiteId;
              const isSwitching = switching === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => pickSite(s.id)}
                  disabled={switching !== null}
                  className={`w-full text-left bg-white/[0.03] border rounded-lg p-5 transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed ${
                    isActive
                      ? 'border-blue-400/60 hover:border-blue-400'
                      : 'border-white/[0.1] hover:border-white/[0.25] hover:bg-white/[0.05]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="text-white font-bold text-base truncate">{s.name}</p>
                      {s.address && (
                        <p className="text-white/40 text-xs mt-0.5 truncate">{s.address}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {isActive && !isSwitching && (
                        <span className="text-[10px] tracking-[0.2em] font-semibold text-blue-400">CURRENT</span>
                      )}
                      {isSwitching && (
                        <span className="text-[10px] tracking-[0.2em] font-semibold text-white/60">SWITCHING…</span>
                      )}
                      <span className="text-white/30 text-lg">→</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
