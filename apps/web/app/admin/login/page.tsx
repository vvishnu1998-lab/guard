'use client';
import Image from 'next/image';
import { useState, FormEvent } from 'react';

export default function AdminLoginPage() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

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
                className="w-full bg-white/[0.04] border border-white/[0.1] rounded-lg px-4 py-3.5 text-white text-sm placeholder-white/20 focus:border-amber-500/60 focus:bg-white/[0.06] focus:outline-none transition-all"
                placeholder="admin@company.com"
              />
            </div>
            <div>
              <label className="block text-white/40 text-[10px] tracking-[0.2em] font-semibold mb-2">PASSWORD</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/[0.1] rounded-lg px-4 py-3.5 text-white text-sm placeholder-white/20 focus:border-amber-500/60 focus:bg-white/[0.06] focus:outline-none transition-all"
                placeholder="••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-black font-black tracking-[0.15em] text-sm py-4 rounded-lg transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-amber-500/20 hover:shadow-amber-500/30 mt-2"
            >
              {loading ? 'SIGNING IN…' : 'SIGN IN'}
            </button>
          </form>

          <p className="text-white/15 text-[11px] text-center mt-10 tracking-wide">
            V-Wing Security Management Platform
          </p>
        </div>
      </div>
    </main>
  );
}
