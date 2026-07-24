'use client';

import { useState } from 'react';

// ── Contact form ──────────────────────────────────────────────────────────────
const SITE_OPTIONS = ['1–4 sites', '5–14 sites', '15–24 sites', '25+ sites'];

export default function ContactForm() {
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [sites, setSites] = useState(SITE_OPTIONS[0]);
  const [message, setMessage] = useState('');
  const [website, setWebsite] = useState(''); // honeypot — humans never see it
  const [status, setStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim() || !company.trim() || !email.trim()) return;
    setStatus('sending');
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, company, email, sites, message, website }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setStatus('success');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'success') {
    return (
      <div className="flex flex-col items-center text-center py-12 gap-4">
        <div className="w-16 h-16 rounded-full border-2 border-[#C9A84C]/60 bg-[#C9A84C]/10 flex items-center justify-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="#C9A84C" strokeWidth={2} className="w-8 h-8">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        </div>
        <p className="text-white font-bold text-lg tracking-tight">Request received</p>
        <p className="text-white/40 text-sm" style={{ fontFamily: 'var(--font-dm-sans), sans-serif' }}>
          We&apos;ll reach out within one business day.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <div className="flex flex-col gap-2">
          <label className="text-white/40 text-xs tracking-[0.2em] font-semibold">NAME</label>
          <input
            type="text"
            name="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="John Smith"
            className="bg-white/[0.04] border border-white/[0.1] rounded-lg px-4 py-3 text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-[#C9A84C]/50 transition-colors"
            style={{ fontFamily: 'var(--font-dm-sans), sans-serif' }}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-white/40 text-xs tracking-[0.2em] font-semibold">COMPANY</label>
          <input
            type="text"
            name="company"
            required
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Apex Security Ltd."
            className="bg-white/[0.04] border border-white/[0.1] rounded-lg px-4 py-3 text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-[#C9A84C]/50 transition-colors"
            style={{ fontFamily: 'var(--font-dm-sans), sans-serif' }}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <div className="flex flex-col gap-2">
          <label className="text-white/40 text-xs tracking-[0.2em] font-semibold">EMAIL</label>
          <input
            type="email"
            name="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="john@apexsecurity.com"
            className="bg-white/[0.04] border border-white/[0.1] rounded-lg px-4 py-3 text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-[#C9A84C]/50 transition-colors"
            style={{ fontFamily: 'var(--font-dm-sans), sans-serif' }}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-white/40 text-xs tracking-[0.2em] font-semibold">NUMBER OF SITES</label>
          <select
            name="sites"
            value={sites}
            onChange={(e) => setSites(e.target.value)}
            className="bg-[#0B1526] border border-white/[0.1] rounded-lg px-4 py-3 text-white text-sm focus:outline-none focus:border-[#C9A84C]/50 transition-colors appearance-none cursor-pointer"
            style={{ fontFamily: 'var(--font-dm-sans), sans-serif' }}
          >
            {SITE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-white/40 text-xs tracking-[0.2em] font-semibold">MESSAGE (OPTIONAL)</label>
        <textarea
          name="message"
          rows={4}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Tell us about your security operations..."
          className="bg-white/[0.04] border border-white/[0.1] rounded-lg px-4 py-3 text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-[#C9A84C]/50 transition-colors resize-none"
          style={{ fontFamily: 'var(--font-dm-sans), sans-serif' }}
        />
      </div>

      {/* Honeypot — visually hidden, ignored by humans, filled by bots */}
      <input
        type="text"
        name="website"
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
      />

      {status === 'error' && (
        <p className="text-red-400/90 text-sm text-center" style={{ fontFamily: 'var(--font-dm-sans), sans-serif' }}>
          Something went wrong — email us at{' '}
          <a href="mailto:support@netraops.com" className="underline hover:text-red-300">support@netraops.com</a>
        </p>
      )}

      <button
        type="submit"
        disabled={status === 'sending'}
        className="bg-[#C9A84C] hover:bg-[#D4B560] disabled:opacity-60 disabled:cursor-not-allowed text-[#0B1526] font-black py-4 rounded-lg tracking-[0.15em] text-sm transition-all shadow-lg shadow-[#C9A84C]/20 hover:shadow-[#C9A84C]/30 mt-2"
      >
        {status === 'sending' ? 'SENDING…' : 'REQUEST A DEMO'}
      </button>
    </form>
  );
}
