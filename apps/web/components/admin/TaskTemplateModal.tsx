'use client';
/**
 * TaskTemplateModal — create or edit a task template.
 * Used by the /admin/tasks page.
 */
import { useEffect, useState } from 'react';

export interface TemplateFormData {
  title:          string;
  description:    string;
  scheduled_time: string;     // HH:MM — stored as UTC, displayed as local in the form
  recurrence:     string;
  requires_photo: boolean;
  is_active:      boolean;
}

/** Convert "HH:MM" UTC string → "HH:MM" local string for the time input */
function utcTimeToLocal(utcHHMM: string): string {
  const [h, m] = utcHHMM.split(':').map(Number);
  const d = new Date();
  d.setUTCHours(h, m, 0, 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Convert "HH:MM" local string → "HH:MM" UTC string for API storage */
function localTimeToUtc(localHHMM: string): string {
  const [h, m] = localHHMM.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

interface Props {
  open:     boolean;
  initial?: Partial<TemplateFormData> & { id?: string };
  siteId:   string;
  onSave:   (data: TemplateFormData, id?: string) => Promise<void>;
  onClose:  () => void;
}

const RECURRENCES = [
  { value: 'daily',    label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays only' },
  { value: 'weekends', label: 'Weekends only' },
];

const EMPTY: TemplateFormData = {
  title:          '',
  description:    '',
  scheduled_time: '09:00',
  recurrence:     'daily',
  requires_photo: false,
  is_active:      true,
};

export default function TaskTemplateModal({ open, initial, siteId, onSave, onClose }: Props) {
  const [form,    setForm]    = useState<TemplateFormData>(EMPTY);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');

  useEffect(() => {
    if (open) {
      if (initial) {
        // scheduled_time from DB is UTC — convert to local for the time input
        const localTime = initial.scheduled_time ? utcTimeToLocal(initial.scheduled_time) : EMPTY.scheduled_time;
        setForm({ ...EMPTY, ...initial, scheduled_time: localTime });
      } else {
        setForm(EMPTY);
      }
      setError('');
    }
  }, [open, initial]);

  if (!open) return null;

  function set<K extends keyof TemplateFormData>(key: K, val: TemplateFormData[K]) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  async function handleSave() {
    if (!form.title.trim()) { setError('Title is required'); return; }
    if (!form.scheduled_time) { setError('Scheduled time is required'); return; }
    setSaving(true);
    setError('');
    try {
      // Convert local time → UTC before sending to API
      const payload: TemplateFormData = { ...form, scheduled_time: localTimeToUtc(form.scheduled_time) };
      await onSave(payload, initial?.id);
      onClose();
    } catch (err: any) {
      setError(err?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-lg bg-[#242436] border border-[#2E2E48] rounded-2xl p-6 mx-4">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-amber-400 font-bold tracking-widest text-lg">
            {initial?.id ? 'EDIT TEMPLATE' : 'NEW TEMPLATE'}
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
        </div>

        {error && (
          <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">
            {error}
          </div>
        )}

        <div className="space-y-4">
          {/* Title */}
          <div>
            <label className="block text-gray-500 text-xs tracking-widest mb-1">
              TITLE <span className="text-amber-400">*</span>
            </label>
            <input
              type="text"
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              maxLength={120}
              className="w-full bg-[#1A1A2E] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
              placeholder="e.g. Perimeter check — Gate 2"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-gray-500 text-xs tracking-widest mb-1">INSTRUCTIONS</label>
            <textarea
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              rows={3}
              maxLength={500}
              className="w-full bg-[#1A1A2E] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-200 text-sm resize-none focus:outline-none focus:border-amber-400"
              placeholder="Optional — what should the guard do / check?"
            />
          </div>

          {/* Scheduled time + Recurrence row */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-gray-500 text-xs tracking-widest mb-1">
                SCHEDULED TIME <span className="text-amber-400">*</span>
              </label>
              <input
                type="time"
                value={form.scheduled_time}
                onChange={(e) => set('scheduled_time', e.target.value)}
                className="w-full bg-[#1A1A2E] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
              />
            </div>

            <div>
              <label className="block text-gray-500 text-xs tracking-widest mb-1">RECURRENCE</label>
              <select
                value={form.recurrence}
                onChange={(e) => set('recurrence', e.target.value)}
                className="w-full bg-[#1A1A2E] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
              >
                {RECURRENCES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Toggles */}
          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.requires_photo}
                onChange={(e) => set('requires_photo', e.target.checked)}
                className="accent-amber-400 w-4 h-4"
              />
              <span className="text-gray-400 text-sm tracking-widest">REQUIRES PHOTO</span>
            </label>

            {initial?.id && (
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => set('is_active', e.target.checked)}
                  className="accent-amber-400 w-4 h-4"
                />
                <span className="text-gray-400 text-sm tracking-widest">ACTIVE</span>
              </label>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3 mt-6">
          <button
            onClick={onClose}
            className="flex-1 border border-[#2E2E48] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors"
          >
            CANCEL
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors"
          >
            {saving ? 'SAVING…' : 'SAVE TEMPLATE'}
          </button>
        </div>
      </div>
    </div>
  );
}
