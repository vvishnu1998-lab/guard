'use client';

import Link from 'next/link';
import LogoImage from './LogoImage';

// ── NavBar component ──────────────────────────────────────────────────────────
export default function NavBar() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 px-6 py-4">
      <div
        className="max-w-6xl mx-auto flex items-center justify-between rounded-xl border border-white/[0.07] px-5 py-3"
        style={{ background: 'rgba(11,21,38,0.85)', backdropFilter: 'blur(16px)' }}
      >
        {/* Logo + name */}
        <div className="flex items-center gap-3">
          <LogoImage size={30} className="object-contain" />
          <span
            className="text-white font-black tracking-[0.25em] text-lg"
            style={{ fontFamily: 'var(--font-bebas), sans-serif', letterSpacing: '0.18em' }}
          >
            NETRAOPS
          </span>
        </div>

        {/* Nav links + CTA */}
        <div className="flex items-center gap-6">
          <a href="#features" className="hidden md:block text-white/40 hover:text-white/80 text-xs tracking-[0.2em] transition-colors">
            FEATURES
          </a>
          <a href="#contact" className="hidden md:block text-white/40 hover:text-white/80 text-xs tracking-[0.2em] transition-colors">
            CONTACT
          </a>
          <Link
            href="/portal"
            className="bg-white/[0.07] hover:bg-white/[0.12] border border-white/[0.12] text-white font-bold px-5 py-2 rounded-lg text-xs tracking-[0.2em] transition-all"
          >
            LOGIN
          </Link>
        </div>
      </div>
    </nav>
  );
}
