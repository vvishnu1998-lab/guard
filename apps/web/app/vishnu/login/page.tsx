'use client';
import Image from 'next/image';
import { useState, FormEvent } from 'react';

export default function VishnuLoginPage() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/vishnu/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Login failed'); return; }
      document.cookie = `guard_vishnu_access=${data.access}; path=/; max-age=28800; SameSite=Strict`;
      document.cookie = `guard_vishnu_refresh=${data.refresh}; path=/; max-age=2592000; SameSite=Strict`;
      window.location.href = '/vishnu';
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#060E1A] flex items-center justify-center p-8">
      <div className="w-full max-w-[360px]">
        {/* Logo */}
        <div className="flex flex-col items-center mb-14">
          <Image
            src="/vwing_logo.png"
            alt="V-Wing"
            width={48}
            height={48}
            className="object-contain mb-4"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
          <p className="text-white font-black tracking-[0.3em] text-2xl">V-WING</p>
          <div className="w-8 h-px bg-white/20 my-3" />
          <p className="text-white/25 text-[10px] tracking-[0.3em] font-semibold">SUPER ADMIN</p>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3.5 mb-6 text-red-400 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-white/35 text-[10px] tracking-[0.2em] font-semibold mb-2">EMAIL</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-4 py-3.5 text-white text-sm placeholder-white/15 focus:border-white/30 focus:bg-white/[0.06] focus:outline-none transition-all"
              placeholder="admin@vwing.io"
            />
          </div>
          <div>
            <label className="block text-white/35 text-[10px] tracking-[0.2em] font-semibold mb-2">PASSWORD</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-4 py-3.5 text-white text-sm placeholder-white/15 focus:border-white/30 focus:bg-white/[0.06] focus:outline-none transition-all"
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-white hover:bg-white/90 active:bg-white/80 text-black font-black tracking-[0.2em] text-sm py-4 rounded-lg transition-all duration-150 disabled:opacity-30 disabled:cursor-not-allowed mt-2"
          >
            {loading ? 'SIGNING IN…' : 'SIGN IN'}
          </button>
        </form>

        <p className="text-white/10 text-[10px] text-center mt-10 tracking-widest">
          V-WING · RESTRICTED ACCESS
        </p>
      </div>
    </main>
  );
}
