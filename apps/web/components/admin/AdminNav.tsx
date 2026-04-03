'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/admin', label: 'DASHBOARD' },
  { href: '/admin/live-map', label: 'LIVE MAP' },
  { href: '/admin/sites', label: 'SITES' },
  { href: '/admin/guards', label: 'GUARDS' },
  { href: '/admin/shifts',   label: 'SHIFTS' },
  { href: '/admin/tasks',    label: 'TASKS' },
  { href: '/admin/reports',  label: 'REPORTS' },
  { href: '/admin/analytics', label: 'ANALYTICS' },
  { href: '/admin/clients', label: 'CLIENT PORTALS' },
];

export default function AdminNav() {
  const pathname = usePathname();
  const router   = useRouter();

  function logout() {
    document.cookie = 'guard_admin_access=; path=/; max-age=0';
    document.cookie = 'guard_admin_refresh=; path=/; max-age=0';
    router.push('/admin/login');
  }

  return (
    <nav className="w-56 bg-[#242436] border-r border-[#2E2E48] flex flex-col p-4 gap-1 shrink-0">
      <div className="mb-6">
        <p className="text-amber-400 font-bold tracking-widest text-xl">GUARD</p>
        <p className="text-gray-500 text-xs tracking-widest mt-1">ADMIN</p>
      </div>
      {NAV_ITEMS.map(({ href, label }) => {
        const active = pathname === href || (href !== '/admin' && pathname.startsWith(href));
        return (
          <Link
            key={href}
            href={href}
            className={`px-3 py-2 rounded text-xs tracking-widest transition-colors ${
              active
                ? 'bg-amber-400 text-gray-900 font-bold'
                : 'text-gray-400 hover:text-amber-400 hover:bg-[#1A1A2E]'
            }`}
          >
            {label}
          </Link>
        );
      })}
      <div className="mt-auto pt-4 border-t border-[#2E2E48]">
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
