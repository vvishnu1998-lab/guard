'use client';
import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminLoginPage() {
  const router = useRouter();
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

      // Store tokens in httpOnly-like cookies via our own API route
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
    <main className="min-h-screen bg-[#1A1A2E] flex items-center justify-center p-8">
      <div className="w-full max-w-sm">
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold tracking-widest text-amber-400">GUARD</h1>
          <p className="text-gray-500 tracking-widest text-xs mt-2">ADMIN DASHBOARD</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="bg-red-950 border border-red-500 rounded-lg p-3 text-red-400 text-sm">
              {error}
            </div>
          )}
          <div>
            <label className="block text-gray-500 text-xs tracking-widest mb-1">EMAIL</label>
            <input
              type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-[#242436] border border-[#2E2E48] rounded-lg px-4 py-3 text-gray-200 text-sm focus:border-amber-400 focus:outline-none"
              placeholder="admin@example.com"
            />
          </div>
          <div>
            <label className="block text-gray-500 text-xs tracking-widest mb-1">PASSWORD</label>
            <input
              type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-[#242436] border border-[#2E2E48] rounded-lg px-4 py-3 text-gray-200 text-sm focus:border-amber-400 focus:outline-none"
              placeholder="••••••••"
            />
          </div>
          <button
            type="submit" disabled={loading}
            className="w-full bg-amber-400 text-gray-900 font-bold tracking-widest text-sm py-3 rounded-lg hover:bg-amber-300 transition-colors disabled:opacity-50"
          >
            {loading ? 'SIGNING IN...' : 'SIGN IN'}
          </button>
        </form>
      </div>
    </main>
  );
}
