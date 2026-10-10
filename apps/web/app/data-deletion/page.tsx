import React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Account and Data Deletion',
  description:
    'How to request deletion of your NetraOps account and data. Email support@netraops.com or ask your employer’s administrator.',
};

export default function DataDeletion() {
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
          <h1 className="font-display text-4xl md:text-5xl font-bold text-white tracking-tight">
            Account and Data Deletion
          </h1>
          <p className="text-gray-400 text-lg">
            How to ask us to delete your NetraOps account and the data attached to it.
          </p>
        </div>

        {/* App / developer identity */}
        <div className="rounded-2xl border border-[#1A2639] bg-[#0F1D30] p-6 sm:p-8 mb-12">
          <dl className="grid sm:grid-cols-2 gap-y-4 gap-x-8">
            <div>
              <dt className="text-gray-400 text-sm font-medium tracking-wide uppercase mb-1">App</dt>
              <dd className="text-white font-medium">NetraOps</dd>
              <dd className="text-gray-400 text-sm break-all">com.netraops.guard</dd>
            </div>
            <div>
              <dt className="text-gray-400 text-sm font-medium tracking-wide uppercase mb-1">Developer</dt>
              <dd className="text-white font-medium">Calvern LLC</dd>
            </div>
          </dl>
        </div>

        {/* How accounts work */}
        <section className="mb-12">
          <h2 className="font-display text-2xl font-bold text-white mb-4">How NetraOps accounts work</h2>
          <p className="mb-4">
            NetraOps is software that security companies use to run their guard operations.{' '}
            <strong className="text-white">Guards do not sign themselves up.</strong> An administrator at
            the security company you work for creates your account, assigns you to sites, and manages it
            for as long as you work there.
          </p>
          <p>
            Calvern LLC builds and runs NetraOps on your employer&apos;s behalf. Your employer decides what
            is recorded about your work and how long it is kept. We handle that data for them. That is why,
            for most of your data, the decision to delete it is your employer&apos;s to make, and we act on
            their instruction.
          </p>
        </section>

        {/* Two routes */}
        <section className="mb-12">
          <h2 className="font-display text-2xl font-bold text-white mb-4">Two ways to ask</h2>

          <div className="rounded-2xl border border-[#1A2639] bg-[#0F1D30] p-6 sm:p-8 mb-6">
            <p className="text-gray-400 text-sm font-medium tracking-wide uppercase mb-3">
              1 &middot; Ask your employer &mdash; usually fastest
            </p>
            <p className="text-gray-200">
              Speak to the administrator at your security company. They can close your account straight
              away and tell us to delete your data.
            </p>
          </div>

          <div className="rounded-2xl border border-[#1A2639] bg-[#0F1D30] p-6 sm:p-8">
            <p className="text-gray-400 text-sm font-medium tracking-wide uppercase mb-3">
              2 &middot; Email us directly
            </p>
            <a
              href="mailto:support@netraops.com?subject=Account%20deletion%20request"
              className="text-xl md:text-2xl font-bold text-[#00C8FF] hover:underline break-all"
            >
              support@netraops.com
            </a>
            <p className="text-gray-200 mt-4 mb-3">
              Use the subject line <strong className="text-white">&ldquo;Account deletion request&rdquo;</strong>{' '}
              and tell us:
            </p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Your full name, as it appears in the app</li>
              <li>The email address you sign in with</li>
              <li>The name of the security company you work for</li>
            </ul>
          </div>

          <p className="mt-6">
            We will pass your request to your employer&apos;s administrator and write back to you once it
            has been carried out. We do not close a guard&apos;s account without telling the employer who
            created it, because doing so could destroy records they are required to keep.
          </p>
        </section>

        {/* What we delete */}
        <section className="mb-12">
          <h2 className="font-display text-2xl font-bold text-white mb-4">What we delete</h2>
          <p className="mb-4">Once a request is approved, we remove:</p>
          <ul className="list-disc pl-6 space-y-3">
            <li>Your sign-in details and your access to the app</li>
            <li>Your personal phone number and email address</li>
            <li>Device identifiers and push notification tokens</li>
            <li>Sign-in and session logs</li>
            <li>
              Raw GPS location traces, beyond the short window needed to confirm the shifts they belong to
            </li>
            <li>Photos you submitted that are not part of an incident record</li>
          </ul>
          <p className="mt-4">
            After that you can no longer sign in, and the app holds nothing that identifies you.
          </p>
        </section>

        {/* What is kept */}
        <section className="mb-12">
          <h2 className="font-display text-2xl font-bold text-white mb-4">What is kept, and why</h2>
          <p className="mb-4">
            Some records cannot be deleted just because you ask.{' '}
            <strong className="text-white">
              Your employer is required to keep them
            </strong>
            , and that duty sits with the security company as your employer &mdash; not with Calvern LLC.
          </p>
          <ul className="list-disc pl-6 space-y-3">
            <li>
              <strong className="text-white">Time and pay records</strong> &mdash; clock-in and clock-out
              times, hours worked, break records, and anything that affects your wages. California law
              requires employers to keep these for a set period, commonly four years, and requires them to
              stay linked to a named employee. Stripping your name off them would destroy the very purpose
              the law requires them to serve.
            </li>
            <li>
              <strong className="text-white">Licensing and training records</strong> &mdash; guard card and
              training data your employer has to hold to stay compliant.
            </li>
            <li>
              <strong className="text-white">Incident reports and their photos</strong> &mdash; these often
              involve other people and may be needed as evidence. On request we restrict who can see them
              rather than deleting them.
            </li>
          </ul>
          <p className="mt-4">
            These are held under your employer&apos;s obligations. Once those obligations end, the records
            are deleted on our normal schedule.
          </p>
        </section>

        {/* Verification */}
        <section className="mb-12">
          <h2 className="font-display text-2xl font-bold text-white mb-4">Checking it is really you</h2>
          <p>
            We confirm every request before acting on it, so that nobody can close someone else&apos;s
            account. Normally that means your employer&apos;s administrator confirming the request is
            genuine. If we cannot confirm it, we will tell you why rather than go ahead.
          </p>
        </section>

        {/* Timeline */}
        <section className="mb-12">
          <h2 className="font-display text-2xl font-bold text-white mb-4">How long it takes</h2>
          <p className="mb-4">
            We reply to confirm we have your request within{' '}
            <strong className="text-white">5 business days</strong>, and we finish approved requests within{' '}
            <strong className="text-white">45 days</strong>. If something is complicated and needs longer,
            we will tell you before the 45 days are up and explain why.
          </p>
          <p>
            Deleted data can still sit in our encrypted backups until those backups expire on their normal
            rotation. If a backup is ever restored, the deletion is applied again.
          </p>
        </section>

        {/* Questions */}
        <section className="rounded-2xl border border-[#00C8FF]/30 bg-[#00C8FF]/5 p-6">
          <p className="text-gray-200">
            Questions about any of this? Email{' '}
            <a href="mailto:support@netraops.com" className="text-[#00C8FF] hover:underline">support@netraops.com</a>{' '}
            or read our{' '}
            <Link href="/privacy" className="text-[#00C8FF] hover:underline">Privacy Policy</Link>.
          </p>
        </section>

        <p className="text-gray-500 text-sm mt-12">Last updated: 18 September 2026</p>
      </main>

      {/* Footer */}
      <footer className="border-t border-[#1A2639] py-8 text-center text-gray-500 text-sm">
        <p>
          NetraOps &middot;{' '}
          <a href="mailto:support@netraops.com" className="text-gray-400 hover:text-[#00C8FF] transition-colors">support@netraops.com</a>
        </p>
      </footer>
    </div>
  );
}
