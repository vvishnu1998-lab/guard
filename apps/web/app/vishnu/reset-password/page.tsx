'use client';
import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Image from 'next/image';

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

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token') ?? '';

  const [password, setPassword]         = useState('');
  const [confirm, setConfirm]           = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm]   = useState(false);
  const [error, setError]               = useState('');
  const [loading, setLoading]           = useState(false);
  const [success, setSuccess]           = useState(false);

  useEffect(() => {
    if (!token) setError('Invalid or missing reset token.');
  }, [token]);

  async function handleSubmit() {
    setError('');
    if (password.length < 12) { setError('Password must be at least 12 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setLoading(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Failed to reset password'); return; }
      setSuccess(true);
      setTimeout(() => router.push('/vishnu/login'), 2500);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#060E1A] flex items-center justify-center p-8">
      <div className="w-full max-w-[360px]">
        <div className="flex flex-col items-center mb-14">
          <Image
            src="/vwing_logo.png"
            alt="Netra"
            width={48}
            height={48}
            className="object-contain mb-4"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
          <p className="text-white font-black tracking-[0.3em] text-2xl">V-WING</p>
          <div className="w-8 h-px bg-white/20 my-3" />
          <p className="text-white/25 text-[10px] tracking-[0.3em] font-semibold">SUPER ADMIN</p>
        </div>

        <h2 className="text-white font-black text-2xl tracking-tight mb-1">Set New Password</h2>
        <p className="text-white/35 text-sm mb-8 tracking-wide">Super admin password reset.</p>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3.5 mb-6 text-red-400 text-sm">
            {error}
          </div>
        )}

        {success ? (
          <div className="bg-white/[0.06] border border-white/[0.15] rounded-lg p-4 text-white/70 text-sm">
            Password reset successfully! Redirecting to sign in…
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="block text-white/35 text-[10px] tracking-[0.2em] font-semibold mb-2">NEW PASSWORD</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-4 py-3.5 pr-11 text-white text-sm placeholder-white/15 focus:border-white/30 focus:ring-1 focus:ring-white/20 focus:bg-white/[0.06] focus:outline-none transition-all"
                  placeholder="At least 8 characters"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(p => !p)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-300 transition-colors"
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-white/35 text-[10px] tracking-[0.2em] font-semibold mb-2">CONFIRM PASSWORD</label>
              <div className="relative">
                <input
                  type={showConfirm ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-4 py-3.5 pr-11 text-white text-sm placeholder-white/15 focus:border-white/30 focus:ring-1 focus:ring-white/20 focus:bg-white/[0.06] focus:outline-none transition-all"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm(p => !p)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-300 transition-colors"
                >
                  {showConfirm ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={loading || !password || !confirm || !token}
              className="w-full bg-white hover:bg-white/90 active:bg-white/80 text-black font-black tracking-[0.2em] text-sm py-4 rounded-lg transition-all duration-150 disabled:opacity-30 disabled:cursor-not-allowed mt-2"
            >
              {loading ? 'RESETTING…' : 'RESET PASSWORD'}
            </button>
          </div>
        )}

        <p className="text-white/10 text-[10px] text-center mt-10 tracking-widest">
          V-WING · RESTRICTED ACCESS
        </p>
      </div>
    </main>
  );
}

export default function VishnuResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}
