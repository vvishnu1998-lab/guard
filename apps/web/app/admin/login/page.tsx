'use client';
import Image from 'next/image';
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

export default function AdminLoginPage() {
  const [email, setEmail]           = useState('');
  const [password, setPassword]     = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError]           = useState('');
  const [loading, setLoading]       = useState(false);

  // Forgot password state
  const [showForgot, setShowForgot] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetSent, setResetSent]   = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Login failed'); return; }
      document.cookie = `guard_admin_access=${data.access}; path=/; max-age=28800; SameSite=Strict`;
      document.cookie = `guard_admin_refresh=${data.refresh}; path=/; max-age=2592000; SameSite=Strict`;
      window.location.href = '/admin';
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotPassword() {
    setResetError('');
    setResetLoading(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: resetEmail, portal: 'admin' }),
      });
      const data = await res.json();
      if (!res.ok) { setResetError(data.error ?? 'Failed to send reset email'); return; }
      setResetSent(true);
    } catch {
      setResetError('Network error. Please try again.');
    } finally {
      setResetLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#060E1A] flex">
      {/* Left panel — brand */}
      <div className="hidden lg:flex flex-col justify-between w-[45%] bg-[#070F1E] border-r border-white/[0.05] p-14">
        <div className="flex items-center gap-3">
          <Image
            src="/vwing_logo.png"
            alt="V-Wing"
            width={36}
            height={36}
            className="object-contain"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
          <span className="text-white font-black tracking-[0.2em] text-lg">V-WING</span>
        </div>
        <div>
          <p className="text-white/10 text-[11px] tracking-[0.3em] font-semibold mb-8">SECURITY MANAGEMENT</p>
          <h2 className="text-white font-black text-5xl leading-[1.1] tracking-tight mb-6">
            Every shift.<br />
            Every site.<br />
            <span className="text-amber-500">Accounted for.</span>
          </h2>
          <p className="text-white/35 text-sm leading-relaxed max-w-xs">
            Real-time guard monitoring, geofence compliance, and automated reporting — built for serious security operations.
          </p>
        </div>
        <p className="text-white/15 text-xs tracking-widest">© V-WING SECURITY MANAGEMENT</p>
      </div>

      {/* Right panel — form */}
      <div className="flex-1 flex items-center justify-center p-8 lg:p-16">
        <div className="w-full max-w-[380px]">
          {/* Mobile logo */}
          <div className="flex items-center gap-3 mb-12 lg:hidden">
            <Image
              src="/vwing_logo.png"
              alt="V-Wing"
              width={32}
              height={32}
              className="object-contain"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
            <span className="text-white font-black tracking-[0.2em] text-lg">V-WING</span>
          </div>

          {showForgot ? (
            /* ── Forgot password panel ── */
            <div>
              <h1 className="text-white font-black text-3xl tracking-tight mb-1">Reset Password</h1>
              <p className="text-white/35 text-sm mb-10 tracking-wide">
                Enter your email and we&apos;ll send you a reset link.
              </p>

              {resetError && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3.5 mb-6 text-red-400 text-sm">
                  {resetError}
                </div>
              )}

              {resetSent ? (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 mb-6 text-amber-400 text-sm">
                  Check your email for a reset link.
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="block text-white/40 text-[10px] tracking-[0.2em] font-semibold mb-2">EMAIL</label>
                    <input
                      type="email"
                      value={resetEmail}
                      onChange={(e) => setResetEmail(e.target.value)}
                      className="w-full bg-white/[0.04] border border-white/[0.1] rounded-lg px-4 py-3.5 text-white text-sm placeholder-white/20 focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/40 focus:bg-white/[0.06] focus:outline-none transition-all"
                      placeholder="admin@company.com"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleForgotPassword}
                    disabled={resetLoading || !resetEmail}
                    className="w-full bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-black font-black tracking-[0.15em] text-sm py-4 rounded-lg transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-amber-500/20 hover:shadow-amber-500/30"
                  >
                    {resetLoading ? 'SENDING…' : 'SEND RESET LINK'}
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={() => { setShowForgot(false); setResetSent(false); setResetEmail(''); setResetError(''); }}
                className="mt-6 text-sm text-white/40 hover:text-white/70 transition-colors"
              >
                ← Back to sign in
              </button>
            </div>
          ) : (
            /* ── Sign in panel ── */
            <div>
              <h1 className="text-white font-black text-3xl tracking-tight mb-1">Admin Sign In</h1>
              <p className="text-white/35 text-sm mb-10 tracking-wide">Access the operations dashboard.</p>

              {error && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3.5 mb-6 text-red-400 text-sm">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-white/40 text-[10px] tracking-[0.2em] font-semibold mb-2">EMAIL</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-white/[0.04] border border-white/[0.1] rounded-lg px-4 py-3.5 text-white text-sm placeholder-white/20 focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/40 focus:bg-white/[0.06] focus:outline-none transition-all"
                    placeholder="admin@company.com"
                  />
                </div>
                <div>
                  <label className="block text-white/40 text-[10px] tracking-[0.2em] font-semibold mb-2">PASSWORD</label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full bg-white/[0.04] border border-white/[0.1] rounded-lg px-4 py-3.5 pr-11 text-white text-sm placeholder-white/20 focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/40 focus:bg-white/[0.06] focus:outline-none transition-all"
                      placeholder="••••••••"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(p => !p)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-amber-500 transition-colors"
                    >
                      {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                    </button>
                  </div>
                  <div className="flex justify-end mt-1">
                    <button
                      type="button"
                      onClick={() => setShowForgot(true)}
                      className="text-sm text-amber-500 hover:text-amber-400 transition-colors"
                    >
                      Forgot password?
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-black font-black tracking-[0.15em] text-sm py-4 rounded-lg transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-amber-500/20 hover:shadow-amber-500/30 mt-2"
                >
                  {loading ? 'SIGNING IN…' : 'SIGN IN'}
                </button>
              </form>
            </div>
          )}

          <p className="text-white/15 text-[11px] text-center mt-10 tracking-wide">
            V-Wing Security Management Platform
          </p>
        </div>
      </div>
    </main>
  );
}
