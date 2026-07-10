'use client';
/**
 * Shared "Assign Guard" modal — attaches a guard to an existing
 * (previously unassigned) shift. Extracted from the inline modal in
 * /admin/shifts/page.tsx so the per-site drill-in can trigger it too.
 */
import { useEffect, useState } from 'react';
import { adminPatch } from '../../lib/adminApi';
import { fmtDT } from '../../lib/shiftFormat';
import InactiveSiteBadge from '../InactiveSiteBadge';

interface Guard { id: string; name: string; badge_number: string; is_active?: boolean }
export interface AssignableShift {
  id: string;
  site_name: string;
  site_is_active?: boolean;
  scheduled_start: string;
  scheduled_end: string;
}

interface Props {
  shift: AssignableShift | null;   // null → closed
  guards: Guard[];
  onClose: () => void;
  onAssigned: () => void;
}

export default function AssignGuardModal({ shift, guards, onClose, onAssigned }: Props) {
  const [guardId,  setGuardId]  = useState('');
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState('');

  // Reset on open. `shift` becoming non-null == "open".
  useEffect(() => {
    if (!shift) return;
    setGuardId(''); setError(''); setBusy(false);
  }, [shift]);

  if (!shift) return null;

  async function submit() {
    if (!guardId) { setError('Select a guard'); return; }
    setBusy(true); setError('');
    try {
      await adminPatch(`/api/shifts/${shift!.id}/assign-guard`, { guard_id: guardId });
      onAssigned();
      onClose();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-sm bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-amber-400 font-bold tracking-widest text-lg">ASSIGN GUARD</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
        </div>
        <p className="text-gray-500 text-xs mb-1">
          Site: <span className="text-gray-300">{shift.site_name}</span>
          <InactiveSiteBadge siteIsActive={shift.site_is_active} />
        </p>
        <p className="text-gray-500 text-xs mb-4">{fmtDT(shift.scheduled_start)} → {fmtDT(shift.scheduled_end)}</p>
        {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{error}</div>}
        <div className="mb-5">
          <label className="block text-gray-500 text-xs tracking-widest mb-1">GUARD <span className="text-amber-400">*</span></label>
          <select value={guardId} onChange={(e) => setGuardId(e.target.value)}
            className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400">
            <option value="">Select guard…</option>
            {guards.filter((g) => g.is_active !== false).map((g) => (
              <option key={g.id} value={g.id}>{g.name} — {g.badge_number}</option>
            ))}
          </select>
        </div>
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
          <button onClick={submit} disabled={busy} className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors">
            {busy ? 'ASSIGNING…' : 'ASSIGN'}
          </button>
        </div>
      </div>
    </div>
  );
}
