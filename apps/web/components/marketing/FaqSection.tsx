import Link from 'next/link';

// Server component — native <details>/<summary> accordion. The `name`
// attribute gives one-open-at-a-time behavior in modern browsers with zero
// JS; older browsers simply allow multiple open. All Q&A text is in the
// server HTML for SEO.
const faqs: { q: string; a: React.ReactNode }[] = [
  {
    q: 'How does NetraOps track guards on site?',
    a: 'Every clock-in, patrol ping, and report is GPS-verified against your site’s geofence — on our servers, not the phone. Guards check in with photo-verified pings every 30 minutes, so you always know who’s on post.',
  },
  {
    q: 'What happens when a guard doesn’t show up?',
    a: 'NetraOps detects the missed shift automatically and alerts your admins within minutes of the scheduled start — no waiting for a client to call you first.',
  },
  {
    q: 'Do guards need special hardware?',
    a: 'No. Guards use the NetraOps app on their own iOS or Android phone. No fobs, no wands, no extra equipment to buy or lose.',
  },
  {
    q: 'Can my clients see reports?',
    a: 'Yes. Each client gets their own portal with live coverage status and the reports their contract covers — nothing more, nothing less.',
  },
  {
    q: 'How much does it cost?',
    a: 'Pricing is per site, per month, and scales with your operation. Request a demo and we’ll put together a quote for your site count.',
  },
  {
    q: 'How long does onboarding take?',
    a: 'Most companies have their sites, guards, and schedules set up in under a day. We’ll walk you through it.',
  },
  {
    q: 'Is my data secure?',
    a: (
      <>
        Yes — tenant isolation, server-side verification, and encrypted traffic throughout. Read the
        details on our{' '}
        <Link href="/security" className="text-[#C9A84C] hover:text-[#D4B560] underline underline-offset-2 transition-colors">
          Security page
        </Link>
        .
      </>
    ),
  },
  {
    q: 'Do you offer a trial?',
    a: 'Yes — your first month is free. Request a demo to get started.',
  },
];

export default function FaqSection() {
  return (
    <div className="max-w-3xl mx-auto">
      {faqs.map((item, i) => (
        <details key={i} name="faq" className="group border-b border-white/[0.07]" open={i === 0}>
          <summary className="flex items-center justify-between gap-4 py-5 cursor-pointer list-none [&::-webkit-details-marker]:hidden text-white font-bold tracking-tight group-open:text-[#C9A84C] transition-colors hover:text-[#D4B560]">
            <span>{item.q}</span>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              className="w-4 h-4 shrink-0 text-white/40 group-open:text-[#C9A84C] group-open:rotate-180 transition-transform duration-200"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
            </svg>
          </summary>
          <p
            className="faq-answer pb-5 pr-8 text-white/45 text-sm leading-relaxed"
            style={{ fontFamily: 'var(--font-dm-sans), sans-serif' }}
          >
            {item.a}
          </p>
        </details>
      ))}
      <style>{`
        @keyframes faqIn {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        details[open] .faq-answer { animation: faqIn 0.25s ease; }
      `}</style>
    </div>
  );
}
