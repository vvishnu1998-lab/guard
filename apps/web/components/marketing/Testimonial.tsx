import Link from 'next/link';
import FadeSection from './FadeSection';

// Customer testimonial, approved by STARNET Security Inc (iMessage, 2026-10).
// QUOTE and the attribution are VERBATIM as approved — do not edit a word,
// and do not add a title, city, photo, logo, metric or site name.
// Layout follows the "STARNET Testimonial & Case Study — Sample" canvas,
// artboard A: the "Read the Starnet story" button, then the walkthrough link.
// The button shows everywhere; /demo hides only the walkthrough link (it would
// point at the page it sits on).

// Exported for app/customers/starnet/page.tsx, which renders the same quote.
// One constant, so the two pages cannot drift apart.
export const QUOTE =
  'Before NetraOps, I found out about a problem when the client called. Now I know a guard is late or off post before they do, every shift is on the record, and my client gets their reports without asking me. It runs on the phones my guards already carry.';

export default function Testimonial({ showWalkthroughLink = true }: { showWalkthroughLink?: boolean }) {
  return (
    <section
      aria-labelledby="testimonial-heading"
      className="relative z-10 py-28 px-6 border-t border-white/[0.05]"
    >
      <div className="max-w-5xl mx-auto">
        <FadeSection className="flex flex-col gap-10">
          <div className="flex flex-col gap-3.5">
            <p className="text-[#C9A84C] text-xs tracking-[0.32em] font-bold uppercase">
              From a security company running on NetraOps
            </p>
            <h2
              id="testimonial-heading"
              className="font-display uppercase text-4xl md:text-[52px] font-bold leading-[0.98] tracking-[0.01em] text-white text-balance"
            >
              <span className="block">They used to hear it from the client.</span>
              <span className="block text-[#C9A84C]">Now they hear it first.</span>
            </h2>
          </div>

          <figure className="m-0 rounded-2xl bg-[#101C31] border border-[#2A3A55] p-6 sm:p-8 md:px-12 md:py-11 flex flex-col gap-6 md:gap-7">
            <svg width="44" height="34" viewBox="0 0 44 34" fill="none" aria-hidden="true" className="w-9 h-auto md:w-11">
              <path
                d="M2 32V20C2 10 7 4 17 2l1.5 4C12 8 9.5 12 9.5 17H18v15H2Zm24 0V20c0-10 5-16 15-18l1.5 4C36 8 33.5 12 33.5 17H42v15H26Z"
                stroke="#C9A84C"
                strokeWidth={2.5}
                strokeLinejoin="round"
              />
            </svg>
            <blockquote className="m-0">
              <p
                className="text-white text-xl md:text-[26px] leading-[1.45] font-medium text-pretty"
                style={{ fontFamily: 'var(--font-dm-sans), sans-serif' }}
              >
                {QUOTE}
              </p>
            </blockquote>
            <figcaption className="flex items-center gap-4" style={{ fontFamily: 'var(--font-dm-sans), sans-serif' }}>
              <span
                aria-hidden="true"
                className="font-display font-bold shrink-0 w-12 h-12 rounded-full bg-[#0B1526] border-2 border-[#C9A84C] text-[#C9A84C] text-[22px] flex items-center justify-center"
              >
                N
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-white text-[17px] font-bold">Natnael</span>
                <span className="sr-only"> — </span>
                <span className="text-[#B8C1CF] text-[15px]">Starnet Security Inc.</span>
              </span>
            </figcaption>
          </figure>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-3" style={{ fontFamily: 'var(--font-dm-sans), sans-serif' }}>
            <Link
              href="/customers/starnet"
              className="inline-flex items-center min-h-[44px] rounded-lg bg-[#C9A84C] hover:bg-[#D4B560] px-[22px] text-[#0B1526] text-sm font-bold uppercase tracking-[0.08em] transition-colors"
            >
              Read the Starnet story
            </Link>
            {showWalkthroughLink && (
              <Link
                href="/demo"
                className="inline-flex items-center min-h-[44px] text-white hover:text-[#C9A84C] text-[15px] font-bold transition-colors"
              >
                Watch the 3-minute walkthrough&nbsp;<span aria-hidden="true">→</span>
              </Link>
            )}
          </div>
        </FadeSection>
      </div>
    </section>
  );
}
