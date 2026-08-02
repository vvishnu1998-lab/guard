import React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Security',
  description: 'How NetraOps protects your data: tenant isolation, role-based access, TLS everywhere, private media storage, and server-side location verification.',
};

export default function Security() {
  return (
    <div className="mkt min-h-screen bg-[#0B1526] text-gray-300 font-sans selection:bg-[#00C8FF] selection:text-[#0B1526]">
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
          <h1 className="font-display text-4xl md:text-5xl font-bold text-white tracking-tight">Security at NetraOps</h1>
          <p className="text-gray-400 text-lg">
            Security companies trust NetraOps with their operations, their people, and their clients&apos; sites.
            We take that seriously. Here is how the platform protects your data.
          </p>
        </div>

        <div className="space-y-12">
          <section>
            <h2 className="font-display text-2xl font-bold text-white mb-4">Your data stays yours</h2>
            <p>
              NetraOps is built for multiple security companies operating side by side, and the platform is
              designed so they never see each other. Every record — every guard, shift, site, report, and
              photo — is scoped to your organization, and that boundary is enforced at the API layer on
              every single request. Requests cannot cross that boundary.
            </p>
          </section>

          <section>
            <h2 className="font-display text-2xl font-bold text-white mb-4">Sign-in you can rely on</h2>
            <p className="mb-4">
              Sessions use signed tokens that the server can revoke at any time — signing out means signed
              out. Accounts are protected against password guessing with automatic lockout and cooldown
              after repeated failed attempts, and password requirements are enforced when credentials are
              created or changed.
            </p>
          </section>

          <section>
            <h2 className="font-display text-2xl font-bold text-white mb-4">The right access for the right role</h2>
            <p>
              Admins, guards, and clients each get their own portal with their own permissions. Guards can
              act only on their own assigned shifts and sites — never anyone else&apos;s. Clients see the
              reporting their contract covers, nothing more. Role checks happen on the server, not in the
              app.
            </p>
          </section>

          <section>
            <h2 className="font-display text-2xl font-bold text-white mb-4">Encrypted in transit</h2>
            <p>
              All traffic between the mobile app, the web portals, and our servers is encrypted with TLS.
              There are no unencrypted paths into the platform.
            </p>
          </section>

          <section>
            <h2 className="font-display text-2xl font-bold text-white mb-4">Private media storage</h2>
            <p>
              Incident photos, verification photos, and generated PDFs are stored in private cloud storage
              buckets that are not publicly accessible. Files are served only through short-lived, signed
              links generated for authorized users — links expire quickly and cannot be reused indefinitely.
            </p>
          </section>

          <section>
            <h2 className="font-display text-2xl font-bold text-white mb-4">Location data that can&apos;t be faked</h2>
            <p>
              Geofence compliance is verified on our servers, not on the phone. The platform independently
              checks every clock-in and location ping against the site&apos;s boundary — a modified app or
              spoofed request can&apos;t simply claim to be on post.
            </p>
          </section>

          <section>
            <h2 className="font-display text-2xl font-bold text-white mb-4">Monitored around the clock</h2>
            <p>
              The platform runs with industry-standard error monitoring and alerting, so problems are
              surfaced to our team quickly.
            </p>
          </section>

          <section>
            <h2 className="font-display text-2xl font-bold text-white mb-4">Built on trusted infrastructure</h2>
            <p>
              NetraOps runs on managed cloud infrastructure — Vercel, Railway, and AWS — with encrypted
              storage and the operational security practices of those platforms behind it.
            </p>
          </section>

          <section className="rounded-2xl border border-[#00C8FF]/30 bg-[#00C8FF]/5 p-6">
            <h2 className="font-display text-2xl font-bold text-white mb-4">Responsible disclosure</h2>
            <p>
              Found something that doesn&apos;t look right? We want to hear about it. Report security concerns
              to{' '}
              <a href="mailto:support@netraops.com?subject=Security%20Report" className="text-[#00C8FF] hover:underline">support@netraops.com</a>{' '}
              and we&apos;ll investigate promptly.
            </p>
          </section>
        </div>
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
