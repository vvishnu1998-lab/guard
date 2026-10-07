'use client';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { adminGet, adminPatch, ApiError } from '../../../lib/adminApi';

/**
 * /admin/settings — company profile (Phase A, GET/PATCH /api/admin/company)
 * and company logo (POST/DELETE /api/admin/company/logo).
 *
 * Every admin of the company can VIEW; only the primary admin can EDIT. The
 * API re-checks primary on every write; `is_primary` here only decides which
 * controls render, and anything but `true` renders read-only (fail closed).
 *
 * Vercel and Railway deploy separately, so this page must survive an API that
 * lacks the route or some fields: every field is optional, a missing one
 * renders "—", and a failed load shows a message instead of the form.
 *
 * The logo calls use raw fetch: adminFetch always sends a JSON Content-Type,
 * which a multipart upload cannot carry, and adminDelete throws a plain Error
 * without the response body. Same shape as uploadPdfToSite in
 * app/admin/sites/page.tsx.
 */

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
function getAdminToken() {
  if (typeof document === 'undefined') return '';
  return document.cookie.match(/guard_admin_access=([^;]+)/)?.[1] ?? '';
}

type FieldKey = 'contact_email' | 'phone' | 'address' | 'licence_number' | 'website';

interface CompanyProfile {
  id?: string;
  name?: string | null;
  contact_email?: string | null;
  phone?: string | null;
  address?: string | null;
  licence_number?: string | null;
  website?: string | null;
  logo_url?: string | null;
  is_primary?: boolean;
}

const FIELDS: Array<{ key: FieldKey; label: string; type: 'email' | 'tel' | 'text' | 'url' | 'textarea'; placeholder: string }> = [
  { key: 'contact_email',  label: 'CONTACT EMAIL',  type: 'email',    placeholder: 'office@example.com' },
  { key: 'phone',          label: 'PHONE',          type: 'tel',      placeholder: '+1 (408) 555-0100' },
  { key: 'address',        label: 'ADDRESS',        type: 'textarea', placeholder: 'Street, city, state, ZIP' },
  { key: 'licence_number', label: 'LICENCE NUMBER', type: 'text',     placeholder: 'e.g. PPO 12345' },
  { key: 'website',        label: 'WEBSITE',        type: 'url',      placeholder: 'https://example.com' },
];

/** Mirrors the API's limits (services/companyProfile.ts); the API stays the authority. */
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_TYPES = ['image/png', 'image/jpeg'];

const INPUT_CLASS =
  'w-full bg-[#0B1526] border rounded-lg px-3 py-2 text-gray-200 text-sm placeholder-gray-600 focus:outline-none focus:border-[#00C8FF]';

function formFrom(p: CompanyProfile | null): Record<FieldKey, string> {
  return {
    contact_email:  p?.contact_email ?? '',
    phone:          p?.phone ?? '',
    address:        p?.address ?? '',
    licence_number: p?.licence_number ?? '',
    website:        p?.website ?? '',
  };
}

function display(value: string | null | undefined): string {
  return value && value.trim() !== '' ? value : '—';
}

function initials(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '—';
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

async function logoRequest(method: 'POST' | 'DELETE', body?: FormData): Promise<
  { ok: true; data: CompanyProfile & { removed?: boolean } } | { ok: false; message: string }
> {
  try {
    const res = await fetch(`${API}/api/admin/company/logo`, {
      method,
      headers: { Authorization: `Bearer ${getAdminToken()}` },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // `error` carries the copy on these routes; the enum is in `code`.
      return { ok: false, message: typeof data?.error === 'string' ? data.error : `Request failed: ${res.status}` };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, message: 'Could not reach the server. Check your connection and try again.' };
  }
}

export default function AdminSettingsPage() {
  const [profile, setProfile]       = useState<CompanyProfile | null>(null);
  const [loadError, setLoadError]   = useState('');
  const [loading, setLoading]       = useState(true);

  const [form, setForm]             = useState<Record<FieldKey, string>>(formFrom(null));
  const [saving, setSaving]         = useState(false);
  const [saveError, setSaveError]   = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [saveNote, setSaveNote]     = useState('');

  const [file, setFile]             = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [logoBusy, setLogoBusy]     = useState<'' | 'upload' | 'remove'>('');
  const [logoError, setLogoError]   = useState('');
  const [logoNote, setLogoNote]     = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [previewBroken, setPreviewBroken] = useState(false);

  useEffect(() => {
    let cancelled = false;
    adminGet<CompanyProfile>('/api/admin/company')
      .then((p) => {
        if (cancelled) return;
        setProfile(p ?? {});
        setForm(formFrom(p));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : '';
        setLoadError(msg && !msg.startsWith('Request failed')
          ? msg
          : 'Company settings are not available right now. Try again later.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const canEdit = profile?.is_primary === true;
  const saved = useMemo(() => formFrom(profile), [profile]);
  const dirty = FIELDS.some(({ key }) => form[key] !== saved[key]);

  function setField(key: FieldKey, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaveNote('');
    setFieldErrors((fe) => ({ ...fe, [key]: undefined }));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!canEdit || saving || !dirty) return;
    setSaving(true);
    setSaveError('');
    setFieldErrors({});
    setSaveNote('');
    try {
      const updated = await adminPatch<CompanyProfile & { changed?: string[] }>('/api/admin/company', { ...form });
      setProfile((p) => ({ ...p, ...updated }));
      setForm(formFrom(updated));
      setSaveNote((updated.changed?.length ?? 0) > 0 ? 'Saved.' : 'Nothing changed: the values were already saved.');
    } catch (err) {
      if (err instanceof ApiError) {
        const fields = err.body?.fields;
        if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
          const next: Partial<Record<FieldKey, string>> = {};
          for (const [k, v] of Object.entries(fields as Record<string, { message?: unknown }>)) {
            if (FIELDS.some((f) => f.key === k)) {
              next[k as FieldKey] = typeof v?.message === 'string' ? v.message : 'Check this field.';
            }
          }
          setFieldErrors(next);
        }
        setSaveError(err.message);
      } else {
        setSaveError('Could not save. Check your connection and try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  function chooseFile(f: File | null) {
    setLogoError('');
    setLogoNote('');
    setConfirmRemove(false);
    if (f && !LOGO_TYPES.includes(f.type)) {
      setFile(null);
      setLogoError('The logo must be a PNG or JPEG image.');
      return;
    }
    if (f && f.size > LOGO_MAX_BYTES) {
      setFile(null);
      setLogoError('The logo must be 2 MB or smaller.');
      return;
    }
    setFile(f);
  }

  async function uploadLogo() {
    if (!canEdit || !file || logoBusy) return;
    setLogoBusy('upload');
    setLogoError('');
    setLogoNote('');
    const fd = new FormData();
    fd.append('file', file);
    const r = await logoRequest('POST', fd);
    if (r.ok) {
      setProfile((p) => ({ ...p, ...r.data }));
      setPreviewBroken(false);
      setFile(null);
      setFileInputKey((k) => k + 1);
      setLogoNote('Logo updated.');
    } else {
      setLogoError(r.message);
    }
    setLogoBusy('');
  }

  async function removeLogo() {
    if (!canEdit || logoBusy) return;
    setLogoBusy('remove');
    setLogoError('');
    setLogoNote('');
    const r = await logoRequest('DELETE');
    if (r.ok) {
      setProfile((p) => ({ ...p, ...r.data }));
      setLogoNote(r.data.removed === false ? 'There was no logo to remove.' : 'Logo removed.');
    } else {
      setLogoError(r.message);
    }
    setConfirmRemove(false);
    setLogoBusy('');
  }

  const logoSrc = profile?.logo_url ?? null;

  return (
    <div className="space-y-8 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-widest text-[#C9A84C]">SETTINGS</h1>
      </div>

      {loading && <p className="text-gray-500 text-sm">Loading…</p>}

      {!loading && loadError && (
        <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{loadError}</div>
      )}

      {!loading && !loadError && profile && (
        <>
          {/* ── Company profile ─────────────────────────────────────────── */}
          <section className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-4 md:p-6">
            <h2 className="text-white font-bold tracking-widest text-base mb-1">COMPANY PROFILE</h2>
            <p className="text-gray-500 text-xs mb-5">
              {canEdit
                ? "Your company's contact details. Leave a field empty to clear it."
                : 'Only the primary admin can edit the company profile.'}
            </p>

            <div className="mb-5">
              <p className="block text-gray-500 text-xs tracking-widest mb-1">COMPANY NAME</p>
              <p className="text-gray-200 text-sm break-words">{display(profile.name)}</p>
              <p className="text-gray-600 text-xs mt-1">Contact NetraOps to change your company name.</p>
            </div>

            {saveError && (
              <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{saveError}</div>
            )}

            {canEdit ? (
              <form onSubmit={save} noValidate className="space-y-4">
                {FIELDS.map(({ key, label, type, placeholder }) => {
                  const id = `company-${key}`;
                  const err = fieldErrors[key];
                  const borderClass = err ? 'border-red-500' : 'border-[#1A3050]';
                  return (
                    <div key={key}>
                      <label htmlFor={id} className="block text-gray-500 text-xs tracking-widest mb-1">{label}</label>
                      {type === 'textarea' ? (
                        <textarea
                          id={id} rows={3} value={form[key]} placeholder={placeholder}
                          onChange={(e) => setField(key, e.target.value)}
                          aria-invalid={err ? true : undefined}
                          aria-describedby={err ? `${id}-error` : undefined}
                          className={`${INPUT_CLASS} ${borderClass} resize-y`}
                        />
                      ) : (
                        <input
                          id={id} type={type} value={form[key]} placeholder={placeholder}
                          onChange={(e) => setField(key, e.target.value)}
                          aria-invalid={err ? true : undefined}
                          aria-describedby={err ? `${id}-error` : undefined}
                          className={`${INPUT_CLASS} ${borderClass}`}
                        />
                      )}
                      {err && <p id={`${id}-error`} className="text-red-400 text-xs mt-1">{err}</p>}
                    </div>
                  );
                })}

                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <button
                    type="submit"
                    disabled={saving || !dirty}
                    className="bg-[#00C8FF] text-[#0B1526] font-bold tracking-widest text-sm px-5 py-2.5 rounded-lg hover:bg-[#33D4FF] disabled:opacity-40 transition-colors"
                  >
                    {saving ? 'SAVING…' : 'SAVE CHANGES'}
                  </button>
                  {saveNote && !saveError && <p className="text-gray-400 text-xs">{saveNote}</p>}
                </div>
              </form>
            ) : (
              <dl className="space-y-4">
                {FIELDS.map(({ key, label }) => (
                  <div key={key}>
                    <dt className="text-gray-500 text-xs tracking-widest mb-1">{label}</dt>
                    <dd className="text-gray-200 text-sm whitespace-pre-line break-words">{display(profile[key])}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>

          {/* ── Company logo ────────────────────────────────────────────── */}
          <section className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-4 md:p-6">
            <h2 className="text-white font-bold tracking-widest text-base mb-1">COMPANY LOGO</h2>
            <p className="text-gray-500 text-xs mb-5">
              PNG or JPEG, up to 2 MB, 256 to 2048 pixels on the longest side. Square works best.
            </p>

            {logoError && (
              <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{logoError}</div>
            )}

            <div className="flex flex-col sm:flex-row gap-5">
              <div className="w-32 h-32 shrink-0 rounded-lg bg-[#0B1526] border border-[#1A3050] flex items-center justify-center overflow-hidden">
                {logoSrc && !previewBroken ? (
                  // A presigned S3 URL, which next/image's remotePatterns do not cover; plain <img>, as ReportPhotosView does.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={logoSrc}
                    alt="Company logo"
                    className="max-w-full max-h-full object-contain"
                    onError={() => setPreviewBroken(true)}
                  />
                ) : logoSrc ? (
                  <p className="text-gray-500 text-[11px] text-center px-2">Preview expired. Reload the page.</p>
                ) : (
                  <span className="text-gray-600 font-bold tracking-widest text-2xl">{initials(profile.name)}</span>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <p className="text-gray-400 text-xs mb-3">
                  {logoSrc ? 'Current logo.' : 'No logo yet. Your company name is used instead.'}
                </p>

                {canEdit ? (
                  <div className="space-y-3">
                    <div>
                      <label htmlFor="company-logo-file" className="block text-gray-500 text-xs tracking-widest mb-1">
                        {logoSrc ? 'REPLACE LOGO' : 'UPLOAD LOGO'}
                      </label>
                      <input
                        key={fileInputKey}
                        id="company-logo-file"
                        type="file"
                        accept="image/png,image/jpeg"
                        onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
                        className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400 file:mr-3 file:bg-amber-400 file:text-gray-900 file:border-0 file:rounded file:px-3 file:py-1 file:text-xs file:font-bold file:cursor-pointer"
                      />
                      {file && <p className="text-gray-400 text-xs mt-1 break-all">Selected: {file.name} ({formatBytes(file.size)})</p>}
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={uploadLogo}
                        disabled={!file || logoBusy !== ''}
                        className="bg-[#00C8FF] text-[#0B1526] font-bold tracking-widest text-sm px-5 py-2.5 rounded-lg hover:bg-[#33D4FF] disabled:opacity-40 transition-colors"
                      >
                        {logoBusy === 'upload' ? 'UPLOADING…' : 'UPLOAD'}
                      </button>

                      {logoSrc && !confirmRemove && (
                        <button
                          type="button"
                          onClick={() => { setConfirmRemove(true); setLogoNote(''); setLogoError(''); }}
                          disabled={logoBusy !== ''}
                          className="text-red-400 hover:text-red-300 font-bold tracking-widest text-xs px-2 py-2 disabled:opacity-40"
                        >
                          REMOVE LOGO
                        </button>
                      )}
                      {logoSrc && confirmRemove && (
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-gray-300 text-xs">Remove the logo?</span>
                          <button
                            type="button"
                            onClick={removeLogo}
                            disabled={logoBusy !== ''}
                            className="bg-red-600 hover:bg-red-500 text-white font-bold tracking-widest text-xs px-3 py-2 rounded-lg disabled:opacity-40"
                          >
                            {logoBusy === 'remove' ? 'REMOVING…' : 'YES, REMOVE'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmRemove(false)}
                            disabled={logoBusy !== ''}
                            className="text-gray-400 hover:text-white font-bold tracking-widest text-xs px-2 py-2"
                          >
                            CANCEL
                          </button>
                        </span>
                      )}
                    </div>
                    {logoNote && !logoError && <p className="text-gray-400 text-xs">{logoNote}</p>}
                  </div>
                ) : (
                  <p className="text-gray-500 text-xs">Only the primary admin can change the logo.</p>
                )}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
