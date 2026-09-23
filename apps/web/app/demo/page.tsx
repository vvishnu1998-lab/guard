import type { Metadata } from 'next';
import Link from 'next/link';
import FadeSection from '../../components/marketing/FadeSection';
import NavBar from '../../components/marketing/NavBar';
import ContactForm from '../../components/marketing/ContactForm';
import LogoImage from '../../components/marketing/LogoImage';

// Landing page for the printed-brochure QR codes (https://netraops.com/demo, apex
// 308s to www). Walkthrough video above the same contact form the homepage uses.
// Same marketing shell as app/page.tsx: .mkt root, gold grid, NavBar, footer.

const DESCRIPTION =
  'Every screen in this video is the real product. Then tell us where to set it up — first month free.';

export const metadata: Metadata = {
  // The root layout applies the `%s · NetraOps` template; `absolute` keeps the
  // title exactly as written.
  title: { absolute: 'NetraOps — Walkthrough' },
  description: DESCRIPTION,
  alternates: { canonical: '/demo' },
};

export default function DemoPage() {
  return (
    <div className="mkt min-h-screen bg-[#0B1526] text-white overflow-x-hidden">

      {/* ── BACKGROUND GRID PATTERN ─────────────────────────────────────────── */}
      <div
        className="fixed inset-0 pointer-events-none z-0"
        style={{
          backgroundImage: `
            linear-gradient(rgba(201,168,76,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(201,168,76,0.03) 1px, transparent 1px)
          `,
          backgroundSize: '60px 60px',
        }}
      />

      {/* ── NAV ─────────────────────────────────────────────────────────────── */}
      <NavBar />

      {/* ── WALKTHROUGH ─────────────────────────────────────────────────────── */}
      <section className="relative z-10 pt-36 pb-24 px-6">
        <div className="max-w-4xl mx-auto">
          <FadeSection>
            <p className="text-[#C9A84C] text-xs tracking-[0.35em] font-semibold text-center mb-4">WALKTHROUGH</p>
            <h1 className="font-display uppercase text-center text-4xl md:text-6xl font-bold tracking-[0.02em] text-white mb-4">
              See NetraOps in three minutes
            </h1>
            <p className="text-center text-white/40 max-w-xl mx-auto mb-12 text-base" style={{ fontFamily: 'var(--font-dm-sans), sans-serif' }}>
              {DESCRIPTION}
            </p>
          </FadeSection>

          <FadeSection>
            <div className="relative aspect-video rounded-xl border border-white/10 bg-black overflow-hidden shadow-lg shadow-black/40">
              <iframe
                src="https://www.youtube-nocookie.com/embed/Brhdfuy2_Fw?rel=0"
                title="NetraOps walkthrough"
                loading="lazy"
                allowFullScreen
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                referrerPolicy="strict-origin-when-cross-origin"
                className="absolute inset-0 w-full h-full"
              />
            </div>
          </FadeSection>
        </div>
      </section>

      {/* ── CONTACT ─────────────────────────────────────────────────────────── */}
      <section id="contact" className="relative z-10 py-28 px-6 border-t border-white/[0.05]">
        <div className="max-w-2xl mx-auto">
          <FadeSection>
            <p className="text-[#C9A84C] text-xs tracking-[0.35em] font-semibold text-center mb-4">CONTACT</p>
            <h2 className="font-display uppercase text-center text-4xl md:text-5xl font-bold tracking-[0.02em] text-white mb-12">
              See it on your own sites
            </h2>
          </FadeSection>

          <FadeSection>
            <ContactForm />
          </FadeSection>
        </div>
      </section>

      {/* ── FOOTER (same markup as app/page.tsx — there is no shared footer
          component, and this page must not change the homepage) ──────────── */}
      <footer className="relative z-10 border-t border-white/[0.05] py-10 px-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <LogoImage size={28} className="object-contain opacity-80" />
            <span className="text-white/30 text-xs tracking-[0.2em]">© 2026 NETRAOPS. ALL RIGHTS RESERVED.</span>
          </div>
          <div className="flex items-center gap-6">
            <Link href="/privacy" className="text-white/25 hover:text-white/60 text-xs tracking-widest transition-colors">
              PRIVACY POLICY
            </Link>
            <Link href="/terms" className="text-white/25 hover:text-white/60 text-xs tracking-widest transition-colors">
              TERMS OF SERVICE
            </Link>
            <Link href="/security" className="text-white/25 hover:text-white/60 text-xs tracking-widest transition-colors">
              SECURITY
            </Link>
            <Link href="/portal" className="text-white/25 hover:text-white/60 text-xs tracking-widest transition-colors">
              LOGIN
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
