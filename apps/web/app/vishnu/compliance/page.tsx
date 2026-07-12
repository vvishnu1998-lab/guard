'use client';
/**
 * Vishnu — Data & Compliance (/vishnu/compliance)
 * Three stacked sections: legal holds, upcoming expiry, admin audit log.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { vishnuGet, vishnuPatch } from '../../../lib/vishnuApi';

// ── Types ───────────────────────────────────────────────────────────────────

interface HoldRow {
  record_id:    string;
  record_type:  'Activity Report' | 'Incident Report' | 'Maintenance Report' | 'Violation';
  company_id:   string;
  company_name: string;
  site_id:      string;
  site_name:    string;
  guard_id:     string;
  guard_name:   string;
  reported_at:  string;
  held_since:   string | null;
}

interface ExpiryRow {
  record_id:    string;
  record_type:  string;
  company_id:   string;
  company_name: string;
  site_id:      string;
  site_name:    string;
  expires_at:   string;
}

interface AuditRow {
  timestamp:    string;
  actor_id:     string | null;
  actor_name:   string;
  company_id:   string | null;
  company_name: string | null;
  action:       string;
  target:       string;
}

type ExpiryWindow = 7 | 30 | 90;

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function endpointForHold(recordType: HoldRow['record_type']): 'reports' | 'violations' {
  return recordType === 'Violation' ? 'violations' : 'reports';
}

// Only reports + violations are individually holdable (Commit A endpoints).
// The other record types render in UPCOMING EXPIRY but their PLACE ON HOLD
// button is disabled with a hint tooltip — they're held via cascade only.
function isDirectlyHoldable(recordType: string): boolean {
  return recordType === 'Violation'
      || recordType === 'Incident Report'
      || recordType === 'Activity Report'
      || recordType === 'Maintenance Report';
}
function expiryEndpointFor(recordType: string): 'reports' | 'violations' | null {
  if (recordType === 'Violation') return 'violations';
  if (recordType === 'Incident Report' || recordType === 'Activity Report' || recordType === 'Maintenance Report') return 'reports';
  return null;
}

// ── Confirm modal ──────────────────────────────────────────────────────────

function ConfirmModal({
  title, body, confirmLabel, danger, onConfirm, onCancel,
}: {
  title: string; body: string; confirmLabel: string; danger?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4">
        <h2 className="text-gray-300 font-bold tracking-widest text-lg mb-3">{title}</h2>
        <p className="text-gray-400 text-sm mb-6">{body}</p>
        <div className="flex gap-3">
          <button onClick={onCancel} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
          <button
            onClick={onConfirm}
            className={`flex-1 rounded-lg py-2 text-sm tracking-widest font-bold text-white transition-colors ${
              danger ? 'bg-red-700 hover:bg-red-600' : 'bg-gray-600 hover:bg-gray-500'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function CompliancePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-widest text-gray-300">DATA &amp; COMPLIANCE</h1>
      <LegalHoldsSection />
      <UpcomingExpirySection />
      <AuditLogSection />
    </div>
  );
}

// ── Section 1: Legal Holds ─────────────────────────────────────────────────

function LegalHoldsSection() {
  const [rows,       setRows]       = useState<HoldRow[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [companyId,  setCompanyId]  = useState('');
  const [expanded,   setExpanded]   = useState(false);
  const [confirming, setConfirming] = useState<HoldRow | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await vishnuGet<HoldRow[]>('/api/admin/vishnu/legal-holds'));
      setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const companies = useMemo(() =>
    Array.from(new Map(rows.map((r) => [r.company_id, r.company_name])).entries()),
    [rows],
  );

  // Sort ASC by held_since (oldest holds at top), NULLS last.
  const sorted = useMemo(() => {
    const filtered = companyId ? rows.filter((r) => r.company_id === companyId) : rows;
    return [...filtered].sort((a, b) => {
      if (!a.held_since && !b.held_since) return 0;
      if (!a.held_since) return 1;
      if (!b.held_since) return -1;
      return new Date(a.held_since).getTime() - new Date(b.held_since).getTime();
    });
  }, [rows, companyId]);

  const visible = expanded ? sorted : sorted.slice(0, 10);

  async function release(row: HoldRow) {
    setConfirming(null);
    try {
      const kind = endpointForHold(row.record_type);
      await vishnuPatch(`/api/admin/${kind}/${row.record_id}/legal-hold`, { hold: false });
      await load();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <section className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
      <div className="p-4 border-b border-[#1A3050] flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h2 className="text-gray-300 font-bold tracking-widest text-sm">LEGAL HOLDS</h2>
          <span className="text-orange-400 text-xs tracking-widest">({rows.length} active)</span>
        </div>
        {companies.length > 0 && (
          <select
            value={companyId} onChange={(e) => setCompanyId(e.target.value)}
            className="bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-1.5 text-gray-300 text-xs tracking-widest focus:outline-none focus:border-gray-500"
          >
            <option value="">ALL COMPANIES</option>
            {companies.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
      </div>

      {error && <div className="bg-red-900/40 border-b border-red-500 text-red-300 text-sm px-4 py-2">{error}</div>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead>
            <tr className="text-gray-600 text-xs tracking-widest border-b border-[#1A3050]">
              <th className="text-left  p-3">COMPANY</th>
              <th className="text-left  p-3">SITE</th>
              <th className="text-left  p-3">GUARD</th>
              <th className="text-left  p-3">TYPE</th>
              <th className="text-left  p-3">REPORTED AT</th>
              <th className="text-left  p-3">HELD SINCE</th>
              <th className="text-center p-3">ACTION</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="text-center text-gray-500 py-8">Loading…</td></tr>}
            {!loading && sorted.length === 0 && (
              <tr><td colSpan={7} className="text-center text-gray-500 py-8">No legal holds in place.</td></tr>
            )}
            {visible.map((r) => (
              <tr key={`${r.record_type}:${r.record_id}`} className="border-b border-[#1A3050] hover:bg-[#0B1526] transition-colors">
                <td className="p-3 text-gray-300">{r.company_name}</td>
                <td className="p-3 text-gray-400">{r.site_name}</td>
                <td className="p-3 text-gray-400">{r.guard_name}</td>
                <td className="p-3 text-gray-300 text-xs">{r.record_type}</td>
                <td className="p-3 text-gray-500 text-xs">{fmtDateTime(r.reported_at)}</td>
                <td className="p-3 text-gray-500 text-xs">{fmtDateTime(r.held_since)}</td>
                <td className="p-3 text-center">
                  <button
                    onClick={() => setConfirming(r)}
                    className="text-xs text-orange-400 border border-orange-700 px-3 py-1 rounded hover:bg-orange-900/30 transition-colors tracking-widest"
                  >
                    RELEASE
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sorted.length > 10 && (
        <div className="p-3 border-t border-[#1A3050] text-center">
          <button
            onClick={() => setExpanded((e) => !e)}
            className="text-xs text-gray-400 tracking-widest hover:text-gray-200 transition-colors"
          >
            {expanded ? 'COLLAPSE' : `VIEW ALL ${sorted.length}`}
          </button>
        </div>
      )}

      {confirming && (
        <ConfirmModal
          title="RELEASE LEGAL HOLD"
          body={`Release the hold on this ${confirming.record_type.toLowerCase()}? Cascaded parents (session, shift, pings, tasks) will stay held — release each layer individually.`}
          confirmLabel="RELEASE"
          onConfirm={() => release(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </section>
  );
}

// ── Section 2: Upcoming Expiry ─────────────────────────────────────────────

function UpcomingExpirySection() {
  const [days,        setDays]        = useState<ExpiryWindow>(30);
  const [includeHeld, setIncludeHeld] = useState(false);
  const [rows,        setRows]        = useState<ExpiryRow[]>([]);
  const [counts,      setCounts]      = useState<{ 7: number; 30: number; 90: number }>({ 7: 0, 30: 0, 90: 0 });
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [expanded,    setExpanded]    = useState(false);
  const [confirming,  setConfirming]  = useState<ExpiryRow | null>(null);

  const load = useCallback(async () => {
    try {
      const q = (d: number) => `/api/admin/vishnu/upcoming-expiry?days=${d}&include_held=${includeHeld}`;
      const [r7, r30, r90] = await Promise.all([
        vishnuGet<ExpiryRow[]>(q(7)),
        vishnuGet<ExpiryRow[]>(q(30)),
        vishnuGet<ExpiryRow[]>(q(90)),
      ]);
      setCounts({ 7: r7.length, 30: r30.length, 90: r90.length });
      setRows(days === 7 ? r7 : days === 30 ? r30 : r90);
      setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [days, includeHeld]);

  useEffect(() => { load(); }, [load]);

  // Endpoint already returns expires_at ASC (soonest first).
  const visible = expanded ? rows : rows.slice(0, 10);

  async function placeOnHold(row: ExpiryRow) {
    setConfirming(null);
    const kind = expiryEndpointFor(row.record_type);
    if (!kind) return;
    try {
      await vishnuPatch(`/api/admin/${kind}/${row.record_id}/legal-hold`, { hold: true });
      await load();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <section className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
      <div className="p-4 border-b border-[#1A3050] space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-gray-300 font-bold tracking-widest text-sm">UPCOMING EXPIRY</h2>
          <label className="flex items-center gap-2 text-xs text-gray-500 tracking-widest cursor-pointer">
            <input type="checkbox" checked={includeHeld} onChange={(e) => setIncludeHeld(e.target.checked)} className="accent-gray-500" />
            SHOW HELD RECORDS
          </label>
        </div>
        <div className="flex items-center gap-4 flex-wrap text-xs text-gray-500 tracking-widest">
          <span><span className="text-yellow-400 font-bold">{counts[7]}</span> records expire in 7 days</span>
          <span className="text-gray-700">·</span>
          <span><span className="text-yellow-400 font-bold">{counts[30]}</span> records expire in 30 days</span>
          <span className="text-gray-700">·</span>
          <span><span className="text-yellow-400 font-bold">{counts[90]}</span> records expire in 90 days</span>
        </div>
        <div className="flex items-center gap-2">
          {([7, 30, 90] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`text-xs tracking-widest px-3 py-1 rounded border transition-colors ${
                days === d
                  ? 'border-gray-400 text-gray-200 bg-[#0B1526]'
                  : 'border-[#1A3050] text-gray-500 hover:border-gray-500 hover:text-gray-300'
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="bg-red-900/40 border-b border-red-500 text-red-300 text-sm px-4 py-2">{error}</div>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[820px]">
          <thead>
            <tr className="text-gray-600 text-xs tracking-widest border-b border-[#1A3050]">
              <th className="text-left  p-3">COMPANY</th>
              <th className="text-left  p-3">SITE</th>
              <th className="text-left  p-3">RECORD TYPE</th>
              <th className="text-left  p-3">RECORD ID</th>
              <th className="text-left  p-3">EXPIRES AT</th>
              <th className="text-center p-3">ACTION</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6} className="text-center text-gray-500 py-8">Loading…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={6} className="text-center text-gray-500 py-8">Nothing expiring in this window.</td></tr>
            )}
            {visible.map((r) => {
              const canHold = isDirectlyHoldable(r.record_type);
              return (
                <tr key={`${r.record_type}:${r.record_id}`} className="border-b border-[#1A3050] hover:bg-[#0B1526] transition-colors">
                  <td className="p-3 text-gray-300">{r.company_name}</td>
                  <td className="p-3 text-gray-400">{r.site_name}</td>
                  <td className="p-3 text-gray-300 text-xs">{r.record_type}</td>
                  <td className="p-3 text-gray-600 text-xs font-mono">{r.record_id.slice(0, 8)}…</td>
                  <td className="p-3 text-gray-500 text-xs">{fmtDate(r.expires_at)}</td>
                  <td className="p-3 text-center">
                    {canHold ? (
                      <button
                        onClick={() => setConfirming(r)}
                        className="text-xs text-yellow-400 border border-yellow-700 px-3 py-1 rounded hover:bg-yellow-900/30 transition-colors tracking-widest"
                      >
                        PLACE ON HOLD
                      </button>
                    ) : (
                      <span className="text-xs text-gray-600 tracking-widest" title="Held only via cascade from a parent report or violation">
                        CASCADE ONLY
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {rows.length > 10 && (
        <div className="p-3 border-t border-[#1A3050] text-center">
          <button
            onClick={() => setExpanded((e) => !e)}
            className="text-xs text-gray-400 tracking-widest hover:text-gray-200 transition-colors"
          >
            {expanded ? 'COLLAPSE' : `VIEW ALL ${rows.length}`}
          </button>
        </div>
      )}

      {confirming && (
        <ConfirmModal
          title="PLACE ON LEGAL HOLD"
          body={`Place this ${confirming.record_type.toLowerCase()} on legal hold? Related session, shift, pings, and task completions will also be held.`}
          confirmLabel="PLACE ON HOLD"
          onConfirm={() => placeOnHold(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </section>
  );
}

// ── Section 3: Audit Log ───────────────────────────────────────────────────

const AUDIT_PAGE = 20;

function AuditLogSection() {
  const [rows,    setRows]    = useState<AuditRow[]>([]);
  const [offset,  setOffset]  = useState(0);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(async (off: number, replace: boolean) => {
    setLoading(true);
    try {
      const next = await vishnuGet<AuditRow[]>(`/api/admin/vishnu/audit-log?limit=${AUDIT_PAGE}&offset=${off}`);
      setHasMore(next.length === AUDIT_PAGE);
      setRows((prev) => replace ? next : [...prev, ...next]);
      setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(0, true); }, [load]);

  function viewMore() {
    const nextOff = offset + AUDIT_PAGE;
    setOffset(nextOff);
    void load(nextOff, false);
  }

  return (
    <section className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
      <div className="p-4 border-b border-[#1A3050]">
        <h2 className="text-gray-300 font-bold tracking-widest text-sm">RECENT ADMIN ACTIONS</h2>
      </div>

      {error && <div className="bg-red-900/40 border-b border-red-500 text-red-300 text-sm px-4 py-2">{error}</div>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[780px]">
          <thead>
            <tr className="text-gray-600 text-xs tracking-widest border-b border-[#1A3050]">
              <th className="text-left p-3">TIMESTAMP</th>
              <th className="text-left p-3">ACTOR</th>
              <th className="text-left p-3">COMPANY</th>
              <th className="text-left p-3">ACTION</th>
              <th className="text-left p-3">TARGET</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && <tr><td colSpan={5} className="text-center text-gray-500 py-8">Loading…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={5} className="text-center text-gray-500 py-8">No audit events recorded.</td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={`${r.timestamp}:${i}`} className="border-b border-[#1A3050] hover:bg-[#0B1526] transition-colors">
                <td className="p-3 text-gray-500 text-xs">{fmtDateTime(r.timestamp)}</td>
                <td className="p-3 text-gray-300">
                  {r.actor_name}
                  {r.actor_name === 'Vishnu' && <span className="ml-1 text-[10px] text-gray-500 tracking-widest">(SUPER)</span>}
                </td>
                <td className="p-3 text-gray-400 text-xs">{r.company_name ?? '—'}</td>
                <td className="p-3 text-gray-300 text-xs">{r.action}</td>
                <td className="p-3 text-gray-400 text-xs">{r.target}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="p-3 border-t border-[#1A3050] text-center">
          <button
            onClick={viewMore}
            disabled={loading}
            className="text-xs text-gray-400 tracking-widest hover:text-gray-200 transition-colors disabled:opacity-40"
          >
            {loading ? 'LOADING…' : 'VIEW MORE'}
          </button>
        </div>
      )}
    </section>
  );
}
