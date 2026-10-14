'use client';

/**
 * /admin/settings/sign-ins — the admin's own sign-in history (Phase D, D1).
 *
 * Vishnu's decisions 1b and 2a (2026-10-14), within the locked 6a: the admin's
 * own sign-ins, failed sign-ins, lockouts, password changes and password reset
 * emails; a page of its own, opened from Settings → YOUR ACCOUNT, newest first,
 * 50 at a time, back 365 days. No address is shown, because the API sends none.
 *
 * Reads GET /api/admin/me/sign-ins; LOAD MORE follows the cursor the API
 * returns. Vercel and Railway deploy separately, so an API without the route
 * (a 404) gets a sentence, not a raw error.
 */
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { adminFetch } from '../../../../lib/adminApi';
import type { SignInEvent } from '../../../../lib/signInHistory';
import SignInHistoryList from '../../../../components/admin/SignInHistoryList';

export default function SignInHistoryPage() {
  const [events, setEvents] = useState<SignInEvent[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (before: string | null) => {
    setLoading(true);
    setError('');
    try {
      const res = await adminFetch(`/api/admin/me/sign-ins${before ? `?before=${encodeURIComponent(before)}` : ''}`);
      const body = await res.json().catch(() => null) as { events?: unknown; next?: unknown; error?: unknown } | null;
      if (res.status === 404) {
        setError('Your sign-in history is not available yet. Try again in a few minutes.');
        return;
      }
      if (!res.ok || !body || !Array.isArray(body.events)) {
        setError(typeof body?.error === 'string' ? body.error : 'Could not load your sign-in history.');
        return;
      }
      const page = body.events as SignInEvent[];
      setEvents((prev) => (before ? prev.concat(page) : page));
      setNext(typeof body.next === 'string' ? body.next : null);
    } catch {
      setError('Could not load your sign-in history.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(null); }, [load]);

  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <Link href="/admin/settings" className="text-gray-500 text-xs tracking-widest hover:text-gray-300">
          ← SETTINGS
        </Link>
        <h1 className="text-3xl font-bold tracking-widest text-[#C9A84C] mt-2">SIGN-IN HISTORY</h1>
      </div>
      <section className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-4 md:p-6">
        <p className="text-gray-500 text-xs mb-4">
          Your own sign-ins, failed sign-ins and password changes from the last 365 days, newest first. Times are Pacific.
        </p>
        <SignInHistoryList events={events} hasMore={next !== null} loading={loading} error={error} onMore={() => load(next)} />
      </section>
    </div>
  );
}
