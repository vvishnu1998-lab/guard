/**
 * The rows of the admin's sign-in history (Phase D, D1) and the list's states:
 * loading, an error, nothing yet, LOAD MORE while the API has more, and a last
 * line when it has none. Presentational: app/admin/settings/sign-ins/page.tsx
 * fetches.
 *
 * Each row is what happened, the device and the time in Pacific time. A failed
 * or blocked sign-in is amber, so one the admin did not make stands out.
 */
import { fmtPacific, isSignInFailure, signInEventLabel, type SignInEvent } from '../../lib/signInHistory';

export interface SignInHistoryListProps {
  events: SignInEvent[];
  hasMore: boolean;
  loading: boolean;
  error: string;
  onMore: () => void;
}

export default function SignInHistoryList({ events, hasMore, loading, error, onMore }: SignInHistoryListProps) {
  return (
    <div>
      {events.length > 0 && (
        <ul className="divide-y divide-[#1A3050]">
          {events.map((e, i) => (
            <li key={`${e.at}-${i}`} className="py-3 flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1">
              <div className="min-w-0">
                <p className={`text-sm font-semibold ${isSignInFailure(e.type) ? 'text-amber-400' : 'text-white'}`}>{signInEventLabel(e.type)}</p>
                <p className="text-gray-500 text-xs">{e.device}</p>
              </div>
              <p className="text-gray-400 text-xs font-mono whitespace-nowrap">{fmtPacific(e.at)}</p>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
      {loading && <p className="text-gray-500 text-sm mt-3">Loading…</p>}
      {!loading && !error && events.length === 0 && (
        <p className="text-gray-500 text-sm">No sign-in activity in the last 365 days.</p>
      )}
      {!loading && hasMore && (
        <button
          type="button"
          onClick={onMore}
          className="mt-4 border border-[#00C8FF] text-[#00C8FF] font-bold tracking-widest text-sm px-5 py-2.5 rounded-lg hover:bg-[#00C8FF]/10 transition-colors"
        >
          LOAD MORE
        </button>
      )}
      {!loading && !error && !hasMore && events.length > 0 && (
        <p className="text-gray-600 text-xs mt-4">That is everything from the last 365 days.</p>
      )}
    </div>
  );
}
