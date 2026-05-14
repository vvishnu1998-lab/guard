'use client';
import { useState, FormEvent } from 'react';

function EyeIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  );
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export default function AdminChangePasswordPage() {
  const [current, setCurrent]         = useState('');
  const [next, setNext]               = useState('');
  const [confirm, setConfirm]         = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext]       = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError]             = useState('');
  const [loading, setLoading]         = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (next.length < 6 || next.length > 8) { setError('New password must be 6–8 characters'); return; }
    if (next !== confirm) { setError('New passwords do not match'); return; }

    setLoading(true);
    try {
      const access = readCookie('guard_admin_access');
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/admin/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Could not change password'); return; }
      window.location.href = '/admin';
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function renderEye(visible: boolean, toggle: () => void) {
    return (
      <button
        type="button"
        onClick={toggle}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-amber-500 transition-colors"
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    );
  }

  return (
    <main className="min-h-screen bg-[#060E1A] flex items-center justify-center p-8">
      <div className="w-full max-w-[420px]">
        <div className="mb-10">
          <p className="text-amber-500 text-[11px] tracking-[0.3em] font-semibold mb-3">SET PASSWORD</p>
          <h1 className="text-white font-black text-3xl tracking-tight mb-2">Choose a new password</h1>
          <p className="text-white/35 text-sm tracking-wide">
            Enter your current (or temporary) password, then choose a new 6–8 character password.
          </p>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3.5 mb-6 text-red-400 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-white/40 text-[10px] tracking-[0.2em] font-semibold mb-2">CURRENT / TEMPORARY PASSWORD</label>
            <div className="relative">
              <input
                type={showCurrent ? 'text' : 'password'}
                required
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/[0.1] rounded-lg px-4 py-3.5 pr-11 text-white text-sm placeholder-white/20 focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/40 focus:bg-white/[0.06] focus:outline-none transition-all"
              />
              {renderEye(showCurrent, () => setShowCurrent((p) => !p))}
            </div>
          </div>

          <div>
            <label className="block text-white/40 text-[10px] tracking-[0.2em] font-semibold mb-2">NEW PASSWORD</label>
            <div className="relative">
              <input
                type={showNext ? 'text' : 'password'}
                required
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder="6–8 characters"
                className="w-full bg-white/[0.04] border border-white/[0.1] rounded-lg px-4 py-3.5 pr-11 text-white text-sm placeholder-white/20 focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/40 focus:bg-white/[0.06] focus:outline-none transition-all"
              />
              {renderEye(showNext, () => setShowNext((p) => !p))}
            </div>
          </div>

          <div>
            <label className="block text-white/40 text-[10px] tracking-[0.2em] font-semibold mb-2">CONFIRM NEW PASSWORD</label>
            <div className="relative">
              <input
                type={showConfirm ? 'text' : 'password'}
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/[0.1] rounded-lg px-4 py-3.5 pr-11 text-white text-sm placeholder-white/20 focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/40 focus:bg-white/[0.06] focus:outline-none transition-all"
              />
              {renderEye(showConfirm, () => setShowConfirm((p) => !p))}
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-black font-black tracking-[0.15em] text-sm py-4 rounded-lg transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-amber-500/20 hover:shadow-amber-500/30 mt-2"
          >
            {loading ? 'SAVING…' : 'SET PASSWORD & CONTINUE'}
          </button>
        </form>
      </div>
    </main>
  );
}
