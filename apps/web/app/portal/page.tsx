'use client';
import Image from 'next/image';
import Link from 'next/link';

export default function PortalSelect() {
  return (
    <main className="min-h-screen bg-[#060E1A] flex flex-col items-center justify-center gap-10 p-8">
      {/* Back link */}
      <Link
        href="/"
        className="absolute top-6 left-6 text-white/30 hover:text-white/70 text-xs tracking-[0.2em] font-semibold transition-colors flex items-center gap-2"
      >
        ← BACK TO NETRAOPS.COM
      </Link>

      {/* Logo + wordmark */}
      <div className="flex flex-col items-center gap-4">
        <Image
          src="/vwing_logo.png"
          alt="Netra"
          width={56}
          height={56}
          className="object-contain"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
        <div className="text-center">
          <h1 className="text-white font-black tracking-[0.25em] text-3xl">NETRA</h1>
          <p className="text-white/25 text-[10px] tracking-[0.35em] mt-2 font-semibold">SECURITY MANAGEMENT</p>
        </div>
      </div>

      <div className="w-px h-8 bg-white/10" />

      <p className="text-white/30 tracking-[0.2em] text-xs font-semibold">SELECT YOUR PORTAL</p>

      <div className="flex flex-col gap-3 w-full max-w-[280px]">
        <Link
          href="/admin"
          className="bg-amber-500 hover:bg-amber-400 text-black font-black text-center py-4 rounded-lg tracking-[0.2em] text-sm transition-all shadow-lg shadow-amber-500/20 hover:shadow-amber-500/30"
        >
          ADMIN DASHBOARD
        </Link>
        <Link
          href="/client"
          className="bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.1] text-white/70 hover:text-white font-bold text-center py-4 rounded-lg tracking-[0.2em] text-sm transition-all"
        >
          CLIENT PORTAL
        </Link>
        <Link
          href="/vishnu"
          className="bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] text-white/30 hover:text-white/60 font-bold text-center py-4 rounded-lg tracking-[0.2em] text-sm transition-all"
        >
          SUPER ADMIN
        </Link>
      </div>

      <p className="text-[#4A5568] text-[10px] tracking-widest mt-4">© NETRAOPS</p>
    </main>
  );
}
