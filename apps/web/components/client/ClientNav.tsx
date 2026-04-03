'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/client', label: 'REPORTS' },
  { href: '/client/schedule', label: 'GUARD SCHEDULE' },
  { href: '/client/download', label: 'DOWNLOADS' },
];

export default function ClientNav() {
  const pathname = usePathname();
  const router   = useRouter();

  function logout() {
    document.cookie = 'guard_client_access=; path=/; max-age=0';
    document.cookie = 'guard_client_refresh=; path=/; max-age=0';
    router.push('/client/login');
  }

  return (
    <nav className="w-52 bg-[#242436] border-r border-[#2E2E48] flex flex-col p-4 gap-1 shrink-0">
      <div className="mb-6">
        <p className="text-blue-400 font-bold tracking-widest text-xl">GUARD</p>
        <p className="text-gray-500 text-xs tracking-widest mt-1">CLIENT PORTAL</p>
      </div>
      {NAV_ITEMS.map(({ href, label }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            className={`px-3 py-2 rounded text-xs tracking-widest transition-colors ${
              active
                ? 'bg-blue-500 text-white font-bold'
                : 'text-gray-400 hover:text-blue-400 hover:bg-[#1A1A2E]'
            }`}
          >
            {label}
          </Link>
        );
      })}
      <div className="mt-auto pt-4 border-t border-[#2E2E48]">
        <p className="text-xs text-gray-600 leading-relaxed mb-2">Read-only access.</p>
        <button
          onClick={logout}
          className="w-full px-3 py-2 rounded text-xs tracking-widest text-gray-500 hover:text-red-400 hover:bg-[#1A1A2E] transition-colors text-left"
        >
          SIGN OUT
        </button>
      </div>
    </nav>
  );
}
