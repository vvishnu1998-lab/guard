'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const NAV = [
  { href: '/vishnu',           label: 'OVERVIEW'   },
  { href: '/vishnu/companies', label: 'COMPANIES'  },
  { href: '/vishnu/sites',     label: 'ALL SITES'  },
  { href: '/vishnu/retention', label: 'RETENTION'  },
];

export default function VishnuLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router   = useRouter();

  function logout() {
    document.cookie = 'guard_vishnu_access=; path=/; max-age=0';
    document.cookie = 'guard_vishnu_refresh=; path=/; max-age=0';
    router.push('/vishnu/login');
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <nav className="w-52 bg-[#242436] border-r border-[#2E2E48] flex flex-col p-4 gap-1 shrink-0">
        <div className="mb-6">
          <p className="text-gray-300 font-bold tracking-widest text-xl">GUARD</p>
          <p className="text-gray-600 text-xs tracking-widest mt-1">SUPER ADMIN</p>
        </div>
        {NAV.map(({ href, label }) => {
          const active = pathname === href || (href !== '/vishnu' && (pathname ?? '').startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              className={`px-3 py-2 rounded text-xs tracking-widest transition-colors ${
                active
                  ? 'bg-gray-600 text-white font-bold'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-[#1A1A2E]'
              }`}
            >
              {label}
            </Link>
          );
        })}
        <div className="mt-auto pt-4 border-t border-[#2E2E48]">
          <p className="text-xs text-gray-700 mb-2">Vishnu · Full access</p>
          <button
            onClick={logout}
            className="w-full px-3 py-2 rounded text-xs tracking-widest text-gray-500 hover:text-red-400 hover:bg-[#1A1A2E] transition-colors text-left"
          >
            SIGN OUT
          </button>
        </div>
      </nav>
      <main className="flex-1 overflow-y-auto bg-[#1A1A2E] p-6">{children}</main>
    </div>
  );
}
