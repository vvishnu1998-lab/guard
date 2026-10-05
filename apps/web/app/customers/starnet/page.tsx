import type { Metadata, ResolvingMetadata } from 'next';
import Link from 'next/link';
import FadeSection from '../../../components/marketing/FadeSection';
import NavBar from '../../../components/marketing/NavBar';
import LogoImage from '../../../components/marketing/LogoImage';
import { QUOTE } from '../../../components/marketing/Testimonial';

// Starnet Security customer story, approved for publishing by Starnet
// Security Inc (2026-10). Every string below is VERBATIM as approved — do not
// edit a word, and add no other customer, site or guard name and no number
// beyond the ones here. The figures were pulled from production on
// 2026-10-05 and cover Jul 17 – Oct 5, 2026; they are a dated snapshot, not
// live counts. Layout follows artboard C of the "STARNET Testimonial & Case
// Study — Sample" canvas. Same marketing shell as app/page.tsx and
// app/demo/page.tsx: .mkt root, gold grid, NavBar, footer.
// public/case-studies/starnet.pdf is a separate render of this same copy:
// change the two together or they will disagree.

const TITLE = 'Starnet Security — Customer story | NetraOps';

// The page's sub line, reused verbatim as the meta and Open Graph description.
const DESCRIPTION =
  'How a California guard company moved from hearing about problems from its client to seeing them first — with every shift on the record.';

// A page-level openGraph / twitter block REPLACES the inherited one, including
// the site-wide share image from app/opengraph-image.png and
// app/twitter-image.png, so the parent's images are carried over explicitly.
// Without this the page's share card has no image (/demo keeps it only because
// it sets no openGraph block).
export async function generateMetadata(_props: unknown, parent: ResolvingMetadata): Promise<Metadata> {
  const inherited = await parent;
  return {
    // The root layout applies the `%s · NetraOps` template; `absolute` keeps
    // the title exactly as written.
    title: { absolute: TITLE },
    description: DESCRIPTION,
    alternates: { canonical: '/customers/starnet' },
    openGraph: {
      type: 'article',
      siteName: 'NetraOps',
      url: 'https://www.netraops.com/customers/starnet',
      title: TITLE,
      description: DESCRIPTION,
      images: inherited.openGraph?.images,
    },
    twitter: {
      card: 'summary_large_image',
      title: TITLE,
      description: DESCRIPTION,
      images: inherited.twitter?.images,
    },
  };
}

const BODY_FONT = { fontFamily: 'var(--font-dm-sans), sans-serif' };

const FACTS = [
  { label: 'COMPANY', value: 'Starnet Security Inc.' },
  { label: 'ACTIVE SITES', value: '7' },
  { label: 'ACTIVE GUARDS', value: '22' },
  { label: 'LIVE SINCE', value: 'July 2026' },
];

const CHANGES = [
  'Guards clock in on post — GPS check and selfie, on their own phones.',
  'Late or off post, the supervisor gets an alert.',
  'Every shift is logged: check-ins, activity reports, incidents, hours.',
  'The client gets reports by email and its own portal, without asking.',
];

const RECORD = [
  { value: '221', label: 'shifts on the record' },
  { value: '2,392', label: 'GPS photo check-ins by guards on post' },
  { value: '1,716', label: 'activity & incident reports filed' },
  { value: '62', label: 'late or no-show alerts sent to the supervisor' },
];

export default function StarnetStoryPage() {
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

      <main className="relative z-10 pt-36 pb-24 px-6">
        <article className="max-w-4xl mx-auto flex flex-col gap-12">

          {/* ── HEADER ──────────────────────────────────────────────────────── */}
          <FadeSection className="flex flex-col gap-6">
            <p className="text-[#C9A84C] text-xs tracking-[0.32em] font-bold uppercase">CUSTOMER STORY</p>
            <h1 className="font-display uppercase text-5xl md:text-[64px] font-bold leading-[0.94] tracking-[0.01em] text-white text-balance">
              <span className="block">Starnet Security:</span>
              <span className="block text-[#C9A84C]">finding out first.</span>
            </h1>
            <p className="max-w-[620px] text-[#C9CFD9] text-base md:text-lg leading-relaxed" style={BODY_FONT}>
              {DESCRIPTION}
            </p>

            {/* Fact strip: 4 across from md, 2×2 below. The 1px gap over a
                rule-coloured container draws the dividers. */}
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-px bg-[#2A3A55] border-y border-[#2A3A55]" style={BODY_FONT}>
              {FACTS.map((f) => (
                <div key={f.label} className="bg-[#0B1526] px-3 py-3 max-md:odd:pl-0 md:first:pl-0 flex flex-col gap-1">
                  <dt className="text-[#8E9AAE] text-xs tracking-[0.04em]">{f.label}</dt>
                  <dd className="m-0 text-white text-sm font-bold">{f.value}</dd>
                </div>
              ))}
            </dl>
          </FadeSection>

          {/* ── BEFORE / WHAT CHANGED ───────────────────────────────────────── */}
          <FadeSection className="grid grid-cols-1 md:grid-cols-2 gap-10 md:gap-8" >
            <section aria-labelledby="before-heading" className="flex flex-col gap-3" style={BODY_FONT}>
              <h2 id="before-heading" className="text-[#C9A84C] text-xs tracking-[0.32em] font-bold uppercase">BEFORE</h2>
              <p className="text-white text-lg md:text-xl leading-snug font-medium">
                The worst way to learn a post is empty is from your client.
              </p>
              <p className="text-[#E4E8EF] text-[15px] leading-relaxed">
                Before NetraOps, that phone call was Starnet’s early warning system — whichever app a site was on.
              </p>
            </section>
            <section aria-labelledby="changed-heading" className="flex flex-col gap-3" style={BODY_FONT}>
              <h2 id="changed-heading" className="text-[#C9A84C] text-xs tracking-[0.32em] font-bold uppercase">WHAT CHANGED</h2>
              <ul className="flex flex-col gap-3">
                {CHANGES.map((c) => (
                  <li key={c} className="flex gap-2.5 items-start text-[#E4E8EF] text-[15px] leading-[1.4]">
                    <span aria-hidden="true" className="mt-[7px] w-1.5 h-1.5 rounded-full bg-[#C9A84C] shrink-0" />
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </section>
          </FadeSection>

          {/* ── THE RECORD SO FAR ───────────────────────────────────────────── */}
          <FadeSection>
            <section aria-labelledby="record-heading" className="flex flex-col gap-3" style={BODY_FONT}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                <h2 id="record-heading" className="text-[#C9A84C] text-xs tracking-[0.32em] font-bold uppercase">THE RECORD SO FAR</h2>
                <p className="text-[#8E9AAE] text-xs tracking-[0.04em]">Jul 17 – Oct 5, 2026 · pulled from NetraOps</p>
              </div>
              <ul className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {RECORD.map((r) => (
                  <li key={r.value} className="rounded-[10px] bg-[#101C31] border border-[#2A3A55] p-4 flex flex-col gap-1.5">
                    <span className="font-display font-bold text-4xl leading-none text-white">{r.value}</span>
                    <span className="text-[#C9CFD9] text-[13px] leading-[1.35]">{r.label}</span>
                  </li>
                ))}
              </ul>
            </section>
          </FadeSection>

          {/* ── QUOTE ───────────────────────────────────────────────────────── */}
          {/* The curly quotes are CSS pseudo-content, so the blockquote's text
              stays byte-identical to QUOTE. */}
          <FadeSection>
            <figure className="m-0 rounded-[14px] bg-[#101C31] border border-[#2A3A55] px-6 py-6 md:px-8 md:py-7 flex flex-col gap-3" style={BODY_FONT}>
              <blockquote className="m-0">
                <p className="text-white text-[17px] md:text-xl leading-normal font-medium text-pretty before:content-['“'] after:content-['”']">
                  {QUOTE}
                </p>
              </blockquote>
              <figcaption className="text-[#B8C1CF] text-sm">
                — <span className="font-bold text-[#C9A84C]">Natnael</span> · Starnet Security Inc.
              </figcaption>
            </figure>
          </FadeSection>

          {/* ── CTA ─────────────────────────────────────────────────────────── */}
          <FadeSection>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3" style={BODY_FONT}>
              <Link
                href="/demo"
                className="inline-flex items-center min-h-[44px] rounded-lg bg-[#C9A84C] hover:bg-[#D4B560] px-[22px] text-[#0B1526] text-sm font-bold uppercase tracking-[0.08em] transition-colors"
              >
                Watch the walkthrough
              </Link>
              <a
                href="/case-studies/starnet.pdf"
                className="inline-flex items-center min-h-[44px] text-white hover:text-[#C9A84C] text-[15px] font-bold transition-colors"
              >
                Download the one-page PDF
              </a>
            </div>
          </FadeSection>
        </article>
      </main>

      {/* ── FOOTER (same markup as app/page.tsx and app/demo/page.tsx — there
          is no shared footer component) ──────────────────────────────────── */}
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
