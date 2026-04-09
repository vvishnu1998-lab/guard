'use client';
/**
 * Admin Task Templates — /admin/tasks
 * Star admin can view, create, edit, and soft-delete task templates per site.
 * Filters by site. Shows requires_photo, recurrence, scheduled_time, active status.
 */
import { useCallback, useEffect, useState } from 'react';
import TaskTemplateModal, { type TemplateFormData } from '../../../components/admin/TaskTemplateModal';
import { adminFetch, adminGet } from '../../../lib/adminApi';

interface Site {
  id:   string;
  name: string;
}

interface Template {
  id:             string;
  site_id:        string;
  title:          string;
  description:    string | null;
  scheduled_time: string;
  recurrence:     string;
  requires_photo: boolean;
  is_active:      boolean;
  created_at:     string;
}

const RECURRENCE_LABELS: Record<string, string> = {
  daily:    'Daily',
  weekdays: 'Weekdays',
  weekends: 'Weekends',
  custom:   'Custom',
};

export default function TaskTemplatesPage() {
  const [sites,        setSites]        = useState<Site[]>([]);
  const [selectedSite, setSelectedSite] = useState('');
  const [templates,    setTemplates]    = useState<Template[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [modalOpen,    setModalOpen]    = useState(false);
  const [editing,      setEditing]      = useState<Template | null>(null);
  const [error,        setError]        = useState('');

  // Load sites once
  useEffect(() => {
    adminGet<any>('/api/sites')
      .then((data) => {
        const list: Site[] = Array.isArray(data) ? data : (data?.sites ?? data?.data ?? []);
        setSites(list);
        if (list[0]) setSelectedSite(list[0].id);
      })
      .catch(() => setError('Could not load sites'));
  }, []);

  // Load templates when site changes
  const loadTemplates = useCallback(async () => {
    if (!selectedSite) return;
    setLoading(true);
    try {
      const res = await adminFetch(`/api/tasks/templates?site_id=${selectedSite}`);
      if (!res.ok) throw new Error('Failed to load templates');
      setTemplates(await res.json());
      setError('');
    } catch (err: any) {
      setError(err?.message ?? 'Could not load templates');
    } finally {
      setLoading(false);
    }
  }, [selectedSite]);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  async function handleSave(data: TemplateFormData, id?: string) {
    const method = id ? 'PATCH' : 'POST';
    const path   = id ? `/api/tasks/templates/${id}` : '/api/tasks/templates';
    const body   = id ? data : { ...data, site_id: selectedSite };

    const res = await adminFetch(path, { method, body: JSON.stringify(body) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as any).error ?? 'Save failed');
    }
    await loadTemplates();
  }

  async function handleDeactivate(id: string) {
    if (!confirm('Deactivate this template? It will no longer generate tasks for new shifts.')) return;
    const res = await adminFetch(`/api/tasks/templates/${id}`, { method: 'DELETE' });
    if (!res.ok) { setError('Could not deactivate template'); return; }
    await loadTemplates();
  }

  function openCreate() { setEditing(null); setModalOpen(true); }
  function openEdit(t: Template) { setEditing(t); setModalOpen(true); }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-widest text-amber-400">TASK TEMPLATES</h1>
          <p className="text-gray-500 text-sm mt-1">
            Templates are assigned to a site. Instances are auto-generated when a guard clocks in.
          </p>
        </div>
        <button
          onClick={openCreate}
          className="bg-amber-400 text-gray-900 font-bold tracking-widest text-sm px-4 py-2 rounded-lg hover:bg-amber-300 transition-colors"
        >
          + NEW TEMPLATE
        </button>
      </div>

      {error && (
        <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      {/* Site filter */}
      <div className="flex items-center gap-3">
        <label className="text-gray-500 text-xs tracking-widest">SITE</label>
        <select
          value={selectedSite}
          onChange={(e) => setSelectedSite(e.target.value)}
          className="bg-[#0F1E35] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
        >
          {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      {/* Templates table */}
      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
        <div className="p-4 border-b border-[#1A3050] flex items-center justify-between">
          <h2 className="text-amber-400 font-bold tracking-widest text-sm">
            TEMPLATES
            <span className="ml-2 text-gray-500 font-normal">({templates.length})</span>
          </h2>
          {loading && <span className="text-gray-500 text-xs">Loading…</span>}
        </div>

        {templates.length === 0 && !loading ? (
          <div className="text-center text-gray-500 py-12">
            <p className="text-4xl mb-3">✅</p>
            <p>No templates for this site yet.</p>
            <button
              onClick={openCreate}
              className="mt-4 text-amber-400 text-sm tracking-widest hover:underline"
            >
              CREATE FIRST TEMPLATE →
            </button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-500 text-xs tracking-widest border-b border-[#1A3050]">
                <th className="text-left p-4">TITLE</th>
                <th className="text-left p-4">TIME</th>
                <th className="text-left p-4">RECURRENCE</th>
                <th className="text-center p-4">PHOTO REQ.</th>
                <th className="text-center p-4">STATUS</th>
                <th className="text-right p-4">ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className={`border-b border-[#1A3050] transition-colors ${t.is_active ? 'hover:bg-[#0B1526]' : 'opacity-50'}`}>
                  <td className="p-4">
                    <p className="text-gray-200 font-medium">{t.title}</p>
                    {t.description && (
                      <p className="text-gray-500 text-xs mt-0.5 truncate max-w-xs">{t.description}</p>
                    )}
                  </td>
                  <td className="p-4 text-gray-400 font-mono">
                    {/* scheduled_time stored as UTC — convert to local for display */}
                    {(() => {
                      const [h, m] = t.scheduled_time.split(':').map(Number);
                      const d = new Date(); d.setUTCHours(h, m, 0, 0);
                      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    })()}
                  </td>
                  <td className="p-4 text-gray-400">
                    {RECURRENCE_LABELS[t.recurrence] ?? t.recurrence}
                  </td>
                  <td className="p-4 text-center">
                    {t.requires_photo
                      ? <span className="text-amber-400 text-xs tracking-widest">YES</span>
                      : <span className="text-gray-600 text-xs">—</span>
                    }
                  </td>
                  <td className="p-4 text-center">
                    <span className={`text-xs tracking-widest ${t.is_active ? 'text-green-400' : 'text-gray-600'}`}>
                      {t.is_active ? 'ACTIVE' : 'INACTIVE'}
                    </span>
                  </td>
                  <td className="p-4 text-right">
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => openEdit(t)}
                        className="text-xs text-amber-400 tracking-widest hover:underline"
                      >
                        EDIT
                      </button>
                      {t.is_active && (
                        <button
                          onClick={() => handleDeactivate(t.id)}
                          className="text-xs text-red-400 tracking-widest hover:underline"
                        >
                          DEACTIVATE
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Info callout */}
      <div className="bg-[#0B1526] border border-[#1A3050] rounded-xl p-4 text-sm text-gray-500">
        <p className="text-amber-400 font-bold tracking-widest text-xs mb-1">HOW IT WORKS</p>
        <ul className="space-y-1 list-disc list-inside">
          <li>Task instances are generated automatically when a guard clocks in.</li>
          <li>The template title is copied into the instance — editing a template later does not change past instances.</li>
          <li>Deactivating a template stops it from generating new instances. Existing instances are unaffected.</li>
          <li>Daily = every shift; Weekdays = Mon–Fri; Weekends = Sat–Sun.</li>
        </ul>
      </div>

      <TaskTemplateModal
        open={modalOpen}
        initial={editing ? { id: editing.id, title: editing.title, description: editing.description ?? '', scheduled_time: editing.scheduled_time, recurrence: editing.recurrence, requires_photo: editing.requires_photo, is_active: editing.is_active } : undefined}
        siteId={selectedSite}
        onSave={handleSave}
        onClose={() => setModalOpen(false)}
      />
    </div>
  );
}
