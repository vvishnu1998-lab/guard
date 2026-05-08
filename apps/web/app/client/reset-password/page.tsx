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
      setTimeout(() => router.push('/client/login'), 2500);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#060E1A] flex items-center justify-center p-8">
      <div className="w-full max-w-[380px]">
        <div className="flex items-center gap-3 mb-12">
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

        <h1 className="text-white font-black text-3xl tracking-tight mb-1">Set New Password</h1>
        <p className="text-white/35 text-sm mb-10 tracking-wide">Client portal password reset.</p>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3.5 mb-6 text-red-400 text-sm">
            {error}
          </div>
        )}

        {success ? (
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4 text-blue-400 text-sm">
            Password reset successfully! Redirecting to sign in…
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="block text-white/40 text-[10px] tracking-[0.2em] font-semibold mb-2">NEW PASSWORD</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-white/[0.04] border border-white/[0.1] rounded-lg px-4 py-3.5 pr-11 text-white text-sm placeholder-white/20 focus:border-blue-400/60 focus:ring-1 focus:ring-blue-400/40 focus:bg-white/[0.06] focus:outline-none transition-all"
                  placeholder="At least 8 characters"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(p => !p)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-blue-400 transition-colors"
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-white/40 text-[10px] tracking-[0.2em] font-semibold mb-2">CONFIRM PASSWORD</label>
              <div className="relative">
                <input
                  type={showConfirm ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="w-full bg-white/[0.04] border border-white/[0.1] rounded-lg px-4 py-3.5 pr-11 text-white text-sm placeholder-white/20 focus:border-blue-400/60 focus:ring-1 focus:ring-blue-400/40 focus:bg-white/[0.06] focus:outline-none transition-all"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm(p => !p)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-blue-400 transition-colors"
                >
                  {showConfirm ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={loading || !password || !confirm || !token}
              className="w-full bg-blue-500 hover:bg-blue-400 active:bg-blue-600 text-white font-black tracking-[0.15em] text-sm py-4 rounded-lg transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 mt-2"
            >
              {loading ? 'RESETTING…' : 'RESET PASSWORD'}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

export default function ClientResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}
