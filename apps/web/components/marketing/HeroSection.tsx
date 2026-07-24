'use client';

// ── Hero section ──────────────────────────────────────────────────────────────
export default function HeroSection() {
  return (
    <section className="relative z-10 min-h-screen flex flex-col items-center justify-center px-6 pt-24 pb-20 text-center">
      {/* Radial glow behind headline */}
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[400px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(ellipse, rgba(201,168,76,0.07) 0%, transparent 70%)' }}
      />

      {/* Pill badge */}
      <div
        className="flex items-center gap-2 border border-[#C9A84C]/30 rounded-full px-4 py-2 mb-10"
        style={{ background: 'rgba(201,168,76,0.06)', animation: 'fadeInDown 0.8s ease forwards' }}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-[#C9A84C] animate-pulse" />
        <span className="text-[#C9A84C] text-xs tracking-[0.25em] font-semibold">LIVE GUARD MANAGEMENT PLATFORM</span>
      </div>

      {/* Main headline */}
      <h1
        className="text-5xl sm:text-7xl md:text-8xl font-black text-white leading-none mb-8 max-w-4xl"
        style={{
          fontFamily: 'var(--font-bebas), sans-serif',
          letterSpacing: '0.04em',
          animation: 'fadeInUp 0.9s ease 0.1s forwards',
          opacity: 0,
        }}
      >
        Every Shift.<br />
        Every Site.<br />
        <span className="text-[#C9A84C]">Accounted For.</span>
      </h1>

      {/* Sub-headline */}
      <p
        className="text-white/45 text-base sm:text-lg max-w-2xl leading-relaxed mb-12"
        style={{
          fontFamily: 'var(--font-dm-sans), sans-serif',
          animation: 'fadeInUp 0.9s ease 0.2s forwards',
          opacity: 0,
        }}
      >
        Real-time guard monitoring, geofence compliance, and automated reporting —
        built for serious security operations.
      </p>

      {/* CTAs */}
      <div
        className="flex flex-col sm:flex-row gap-4 items-center"
        style={{ animation: 'fadeInUp 0.9s ease 0.3s forwards', opacity: 0 }}
      >
        <a
          href="mailto:support@netraops.com"
          className="bg-[#C9A84C] hover:bg-[#D4B560] text-[#0B1526] font-black px-10 py-4 rounded-lg tracking-[0.15em] text-sm transition-all shadow-lg shadow-[#C9A84C]/25 hover:shadow-[#C9A84C]/40"
        >
          GET STARTED
        </a>
        <a
          href="#features"
          className="border border-white/[0.15] hover:border-white/[0.3] text-white/70 hover:text-white font-bold px-10 py-4 rounded-lg tracking-[0.15em] text-sm transition-all"
        >
          SEE HOW IT WORKS
        </a>
      </div>

      {/* Scroll indicator */}
      <div
        className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 opacity-30"
        style={{ animation: 'fadeIn 1.5s ease 1s forwards' }}
      >
        <div className="w-px h-10 bg-gradient-to-b from-transparent to-white/60" />
        <span className="text-white/60 text-[10px] tracking-[0.3em]">SCROLL</span>
      </div>

      <style>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(24px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeInDown {
          from { opacity: 0; transform: translateY(-12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to   { opacity: 0.3; }
        }
      `}</style>
    </section>
  );
}
