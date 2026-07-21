import React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Support · NetraOps',
  description: 'Get help with NetraOps. Contact support@netraops.com for account, sign-in, or shift questions.',
};

export default function Support() {
  return (
    <div className="min-h-screen bg-[#0B1526] text-gray-300 font-sans selection:bg-[#00C8FF] selection:text-[#0B1526]">
      {/* Header */}
      <header className="border-b border-[#1A2639] bg-[#0B1526]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-6 h-20 flex items-center justify-between">
          <Link href="/" className="flex items-center space-x-3 group">
            <div className="w-10 h-10 bg-[#00C8FF]/10 rounded-xl flex items-center justify-center group-hover:bg-[#00C8FF]/20 transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6 text-[#00C8FF]"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>
            </div>
            <span className="text-xl font-bold text-white tracking-tight">NetraOps</span>
          </Link>
          <Link href="/" className="text-sm font-medium text-gray-400 hover:text-[#00C8FF] transition-colors flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg> Back to Home
          </Link>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-3xl mx-auto px-6 py-16">
        <div className="space-y-4 mb-12">
          <h1 className="text-4xl md:text-5xl font-bold text-white tracking-tight">NetraOps Support</h1>
          <p className="text-gray-400 text-lg">Need help? We&apos;re here.</p>
        </div>

        {/* Email block */}
        <div className="rounded-2xl border border-[#1A2639] bg-[#0F1D30] p-6 sm:p-8 mb-12">
          <p className="text-gray-400 text-sm font-medium tracking-wide uppercase mb-3">Email us</p>
          <a
            href="mailto:support@netraops.com"
            className="text-xl md:text-3xl font-bold text-[#00C8FF] hover:underline break-all"
          >
            support@netraops.com
          </a>
          <p className="text-gray-400 mt-4">Typical response: within 1 business day</p>
        </div>

        {/* Common topics */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold text-white mb-4">Common topics</h2>
          <ul className="list-disc pl-6 space-y-3">
            <li>Sign-in issues</li>
            <li>Location permission setup</li>
            <li>Missing shifts or schedule questions</li>
            <li>Guard onboarding</li>
            <li>Billing (admins only)</li>
          </ul>
        </section>

        {/* Urgent */}
        <section className="rounded-2xl border border-[#00C8FF]/30 bg-[#00C8FF]/5 p-6">
          <p className="text-gray-200">
            For urgent issues affecting an active shift, email{' '}
            <a href="mailto:support@netraops.com?subject=URGENT" className="text-[#00C8FF] hover:underline">support@netraops.com</a>{' '}
            with <strong className="text-white">&ldquo;URGENT&rdquo;</strong> in the subject line.
          </p>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-[#1A2639] py-8 text-center text-gray-500 text-sm">
        <p>
          NetraOps ·{' '}
          <a href="mailto:support@netraops.com" className="text-gray-400 hover:text-[#00C8FF] transition-colors">support@netraops.com</a>
        </p>
      </footer>
    </div>
  );
}
