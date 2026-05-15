'use client';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';

const NAV_ITEMS = [
  { href: '/admin',           label: 'DASHBOARD'      },
  { href: '/admin/live-map',  label: 'LIVE STATUS'    },
  { href: '/admin/sites',     label: 'SITES'          },
  { href: '/admin/guards',    label: 'GUARDS'         },
  { href: '/admin/shifts',    label: 'SHIFTS'         },
  { href: '/admin/tasks',     label: 'TASKS'          },
  { href: '/admin/reports',   label: 'REPORTS'        },
  { href: '/admin/analytics', label: 'ANALYTICS'      },
  { href: '/admin/clients',   label: 'CLIENT PORTALS' },
  { href: '/admin/billing',   label: 'BILLING'        },
  { href: '/admin/chat',      label: 'CHAT'           },
];

export default function AdminNav() {
  const pathname = usePathname();
  const router   = useRouter();
  const [open, setOpen] = useState(false);

  // Close drawer on route change
  useEffect(() => { setOpen(false); }, [pathname]);

  function logout() {
    document.cookie = 'guard_admin_access=; path=/; max-age=0';
    document.cookie = 'guard_admin_refresh=; path=/; max-age=0';
    router.push('/admin/login');
  }

  const navContent = (
    <>
      {/* Logo */}
      <div className="px-5 pt-7 pb-6 border-b border-white/[0.06] flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Image
            src="/vwing_logo.png"
            alt="Netra"
            width={28}
            height={28}
            className="object-contain"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
          <div>
            <p className="text-white font-black tracking-[0.2em] text-base leading-none">NetraOps</p>
            <p className="text-amber-500 text-[9px] tracking-[0.25em] mt-1 font-medium">ADMIN</p>
          </div>
        </div>
        {/* Close button — mobile only */}
        <button onClick={() => setOpen(false)} className="md:hidden text-white/40 hover:text-white text-xl w-8 h-8 flex items-center justify-center">✕</button>
      </div>

      {/* Nav links */}
      <div className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map(({ href, label }) => {
          const active = pathname === href || (href !== '/admin' && (pathname ?? '').startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center px-3 py-3 md:py-2.5 rounded-md text-sm md:text-[11px] tracking-[0.15em] font-semibold transition-all duration-150 ${
                active
                  ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20'
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
      <nav className="hidden md:flex w-56 bg-[#070F1E] border-r border-white/[0.06] flex-col shrink-0">
        {navContent}
      </nav>

      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 h-14 bg-[#070F1E] border-b border-white/[0.06] flex items-center px-4 gap-3">
        <button onClick={() => setOpen(true)} className="text-white/60 hover:text-white text-2xl w-10 h-10 flex items-center justify-center">☰</button>
        <div className="flex items-center gap-2">
          <Image
            src="/vwing_logo.png"
            alt="Netra"
            width={22}
            height={22}
            className="object-contain"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
          <span className="text-white font-black tracking-[0.2em] text-sm">NetraOps</span>
          <span className="text-amber-500 text-[9px] tracking-[0.2em] font-medium">ADMIN</span>
        </div>
      </div>

      {/* Mobile sidebar overlay */}
      {open && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <nav className="w-72 max-w-[85vw] bg-[#070F1E] border-r border-white/[0.06] flex flex-col h-full">
            {navContent}
          </nav>
          {/* Backdrop */}
          <div className="flex-1 bg-black/50" onClick={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}
