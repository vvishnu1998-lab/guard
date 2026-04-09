'use client';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/client',          label: 'REPORTS'       },
  { href: '/client/schedule', label: 'GUARD SCHEDULE'},
  { href: '/client/download', label: 'DOWNLOADS'     },
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
    <nav className="w-52 bg-[#0D0D1A] border-r border-white/[0.06] flex flex-col shrink-0">
      {/* Logo block */}
      <div className="px-5 pt-7 pb-6 border-b border-white/[0.06]">
        <div className="flex items-center gap-2.5">
          <Image
            src="/vwing_logo.png"
            alt="V-Wing"
            width={28}
            height={28}
            className="object-contain"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
          <div>
            <p className="text-white font-black tracking-[0.2em] text-base leading-none">V-WING</p>
            <p className="text-blue-400 text-[9px] tracking-[0.25em] mt-1 font-medium">CLIENT PORTAL</p>
          </div>
        </div>
      </div>

      {/* Nav links */}
      <div className="flex-1 px-3 py-4 space-y-0.5">
        {NAV_ITEMS.map(({ href, label }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center px-3 py-2.5 rounded-md text-[11px] tracking-[0.15em] font-semibold transition-all duration-150 ${
                active
                  ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/20'
                  : 'text-white/40 hover:text-white hover:bg-white/[0.06]'
              }`}
            >
              {label}
            </Link>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-5 py-5 border-t border-white/[0.06]">
        <p className="text-[10px] text-white/20 tracking-wide leading-relaxed mb-3">Read-only access.</p>
        <button
          onClick={logout}
          className="w-full text-left text-[10px] tracking-[0.2em] text-white/25 hover:text-red-400 transition-colors font-semibold py-1"
        >
          SIGN OUT
        </button>
      </div>
    </nav>
  );
}
