import type { Metadata } from 'next';
import Link from 'next/link';
import FadeSection from '../components/marketing/FadeSection';
import NavBar from '../components/marketing/NavBar';
import HeroSection from '../components/marketing/HeroSection';
import ContactForm from '../components/marketing/ContactForm';
import LogoImage from '../components/marketing/LogoImage';

export const metadata: Metadata = {
  alternates: { canonical: '/' },
};

// ── Feature card data ──────────────────────────────────────────────────────────
const features = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-7 h-7">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
      </svg>
    ),
    title: 'Live Patrol Visibility',
    body: 'Track every officer\'s patrol in real time. GPS check-ins every 30 minutes confirm guards are on post and moving — no radio calls required.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-7 h-7">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
      </svg>
    ),
    title: 'Post Order Enforcement',
    body: 'Define patrol boundaries for every post. Officers who leave their designated zone trigger an instant alert — before a client ever notices.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-7 h-7">
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
    ),
    title: 'Digital Duty Logs',
    body: 'Every shift generates a complete duty log — clock-in time, patrol checkpoints, incidents, and handoff notes. Delivered to your inbox every morning.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-7 h-7">
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
      </svg>
    ),
    title: 'No-Show Incident Response',
    body: 'If an officer fails to report to post within 15 minutes of shift start, command is notified automatically. No gap in coverage goes undetected.',
  },
];

// ── Main page (server component — metadata lives here, interactivity in
//    components/marketing/* client islands) ───────────────────────────────────
export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0B1526] text-white overflow-x-hidden">

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

      {/* ── HERO ────────────────────────────────────────────────────────────── */}
      <HeroSection />

      {/* ── FEATURES ────────────────────────────────────────────────────────── */}
      <section id="features" className="relative z-10 py-28 px-6">
        <div className="max-w-6xl mx-auto">
          <FadeSection>
            <p className="text-[#C9A84C] text-xs tracking-[0.35em] font-semibold text-center mb-4">CAPABILITIES</p>
            <h2 className="text-center text-4xl md:text-5xl font-black tracking-tight text-white mb-4"
              style={{ fontFamily: 'var(--font-bebas), sans-serif', letterSpacing: '0.04em' }}>
              Built for Operations That Can&apos;t Afford to Miss
            </h2>
            <p className="text-center text-white/40 max-w-xl mx-auto mb-16 text-base" style={{ fontFamily: 'var(--font-dm-sans), sans-serif' }}>
              Every feature is built around one principle: your security operations should run with military precision.
            </p>
          </FadeSection>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {features.map((f, i) => (
              <FadeSection key={i}>
                <div className="relative group h-full rounded-xl border border-white/[0.07] bg-white/[0.03] hover:bg-white/[0.055] hover:border-[#C9A84C]/30 transition-all duration-300 p-7 flex flex-col gap-4">
                  <div className="text-[#C9A84C] w-10 h-10 flex items-center justify-center rounded-lg bg-[#C9A84C]/10 border border-[#C9A84C]/20">
                    {f.icon}
                  </div>
                  <h3 className="text-white font-bold text-lg tracking-tight">{f.title}</h3>
                  <p className="text-white/45 text-sm leading-relaxed" style={{ fontFamily: 'var(--font-dm-sans), sans-serif' }}>{f.body}</p>
                  {/* gold accent line on hover */}
                  <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[#C9A84C]/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity rounded-b-xl" />
                </div>
              </FadeSection>
            ))}
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ────────────────────────────────────────────────────── */}
      <section id="how-it-works" className="relative z-10 py-28 px-6 border-t border-white/[0.05]">
        <div className="max-w-5xl mx-auto">
          <FadeSection>
            <p className="text-[#C9A84C] text-xs tracking-[0.35em] font-semibold text-center mb-4">PROCESS</p>
            <h2 className="text-center text-4xl md:text-5xl font-black text-white mb-16"
              style={{ fontFamily: 'var(--font-bebas), sans-serif', letterSpacing: '0.04em' }}>
              Simple Setup. Powerful Results.
            </h2>
          </FadeSection>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-0 relative">
            {/* Connector line (desktop only) */}
            <div className="hidden md:block absolute top-8 left-[calc(16.67%+24px)] right-[calc(16.67%+24px)] h-px bg-gradient-to-r from-[#C9A84C]/30 via-[#C9A84C]/60 to-[#C9A84C]/30 z-0" />

            {[
              {
                n: '01',
                title: 'Onboard Your Team',
                body: 'Add your security company, sites, and guards in minutes. No IT department required.',
              },
              {
                n: '02',
                title: 'Guards Clock In',
                body: 'Guards use the NetraOps mobile app to clock in with photo verification and live location.',
              },
              {
                n: '03',
                title: 'You Stay in Control',
                body: 'Monitor shifts live, receive automated reports, and access client portals — all from one dashboard.',
              },
            ].map((step, i) => (
              <FadeSection key={i} className="relative z-10 flex flex-col items-center text-center px-6">
                <div className="w-16 h-16 rounded-full border-2 border-[#C9A84C]/60 bg-[#0B1526] flex items-center justify-center mb-6">
                  <span className="text-[#C9A84C] font-black text-xl" style={{ fontFamily: 'var(--font-bebas), sans-serif', letterSpacing: '0.05em' }}>
                    {step.n}
                  </span>
                </div>
                <h3 className="text-white font-bold text-lg mb-3 tracking-tight">{step.title}</h3>
                <p className="text-white/40 text-sm leading-relaxed" style={{ fontFamily: 'var(--font-dm-sans), sans-serif' }}>{step.body}</p>
              </FadeSection>
            ))}
          </div>
        </div>
      </section>

      {/* ── CONTACT ─────────────────────────────────────────────────────────── */}
      <section id="contact" className="relative z-10 py-28 px-6 border-t border-white/[0.05]">
        <div className="max-w-2xl mx-auto">
          <FadeSection>
            <p className="text-[#C9A84C] text-xs tracking-[0.35em] font-semibold text-center mb-4">CONTACT</p>
            <h2 className="text-center text-4xl md:text-5xl font-black text-white mb-3"
              style={{ fontFamily: 'var(--font-bebas), sans-serif', letterSpacing: '0.04em' }}>
              Ready to See It in Action?
            </h2>
            <p className="text-center text-white/40 mb-12 text-base" style={{ fontFamily: 'var(--font-dm-sans), sans-serif' }}>
              Get in touch and we&apos;ll set up a personalized demo for your team.
            </p>
          </FadeSection>

          <FadeSection>
            <ContactForm />
          </FadeSection>
        </div>
      </section>

      {/* ── FOOTER ──────────────────────────────────────────────────────────── */}
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
            <Link href="/portal" className="text-white/25 hover:text-white/60 text-xs tracking-widest transition-colors">
              LOGIN
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
