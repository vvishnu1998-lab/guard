'use client';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';

const NAV_ITEMS = [
  { href: '/client',          label: 'REPORTS'        },
  { href: '/client/schedule', label: 'GUARD SCHEDULE' },
  { href: '/client/download', label: 'DOWNLOADS'      },
];

export default function ClientNav() {
  const pathname = usePathname();
  const router   = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => { setOpen(false); }, [pathname]);

  function logout() {
    document.cookie = 'guard_client_access=; path=/; max-age=0';
    document.cookie = 'guard_client_refresh=; path=/; max-age=0';
    router.push('/client/login');
  }

  const navContent = (
    <>
      <div className="px-5 pt-7 pb-6 border-b border-white/[0.06] flex items-center justify-between">
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
        <button onClick={() => setOpen(false)} className="md:hidden text-white/40 hover:text-white text-xl w-8 h-8 flex items-center justify-center">✕</button>
      </div>

      <div className="flex-1 px-3 py-4 space-y-0.5">
        {NAV_ITEMS.map(({ href, label }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center px-3 py-3 md:py-2.5 rounded-md text-sm md:text-[11px] tracking-[0.15em] font-semibold transition-all duration-150 ${
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

      <div className="px-5 py-5 border-t border-white/[0.06]">
        <p className="text-[10px] text-white/20 tracking-wide leading-relaxed mb-3">Read-only access.</p>
        <button
          onClick={logout}
          className="w-full text-left text-[10px] tracking-[0.2em] text-white/25 hover:text-red-400 transition-colors font-semibold py-2"
        >
          SIGN OUT
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <nav className="hidden md:flex w-52 bg-[#070F1E] border-r border-white/[0.06] flex-col shrink-0">
        {navContent}
      </nav>

      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 h-14 bg-[#070F1E] border-b border-white/[0.06] flex items-center px-4 gap-3">
        <button onClick={() => setOpen(true)} className="text-white/60 hover:text-white text-2xl w-10 h-10 flex items-center justify-center">☰</button>
        <div className="flex items-center gap-2">
          <Image src="/vwing_logo.png" alt="V-Wing" width={22} height={22} className="object-contain"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          <span className="text-white font-black tracking-[0.2em] text-sm">V-WING</span>
          <span className="text-blue-400 text-[9px] tracking-[0.2em] font-medium">CLIENT</span>
        </div>
      </div>

      {/* Mobile sidebar overlay */}
      {open && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <nav className="w-72 max-w-[85vw] bg-[#070F1E] border-r border-white/[0.06] flex flex-col h-full">
            {navContent}
          </nav>
          <div className="flex-1 bg-black/50" onClick={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}
