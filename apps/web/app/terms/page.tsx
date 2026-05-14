import React from 'react';
import Link from 'next/link';

export default function TermsOfService() {
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
        <div className="space-y-4 mb-16">
          <h1 className="text-4xl md:text-5xl font-bold text-white tracking-tight">Terms of Service</h1>
          <p className="text-gray-400 text-lg">Effective Date: May 13, 2026</p>
        </div>

        <div className="space-y-12 prose prose-invert prose-p:text-gray-300 prose-headings:text-white prose-a:text-[#00C8FF] max-w-none">
          <section>
            <h2 className="text-2xl font-bold text-white mb-4">1. Introduction</h2>
            <p className="mb-4">
              Welcome to NetraOps.
            </p>
            <p>
              By accessing or using NetraOps, you agree to be bound by these Terms of Service. If you disagree with any part of the terms, you may not access the service.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white mb-4">2. Service Description</h2>
            <p>
              NetraOps provides a SaaS platform and mobile applications designed for security companies to manage guards, track patrols, monitor shift schedules, and generate operational reports for their end clients.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white mb-4">3. User Accounts</h2>
            <p className="mb-4">
              To use NetraOps, an account is required. You agree to:
            </p>
            <ul className="list-disc pl-6 space-y-3">
              <li>Maintain the confidentiality of your account credentials.</li>
              <li>Ensure that accounts are used by a single designated individual (no sharing of accounts).</li>
              <li>Promptly notify us of any unauthorized use or security breaches.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white mb-4">4. Acceptable Use</h2>
            <p className="mb-4">
              You agree not to use NetraOps to:
            </p>
            <ul className="list-disc pl-6 space-y-3">
              <li>Violate any local, state, national, or international law.</li>
              <li>Interfere with or disrupt the integrity or performance of the platform.</li>
              <li>Attempt to gain unauthorized access to the service or its related systems.</li>
              <li>Upload malicious code or engage in unauthorized data mining.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white mb-4">5. Subscription Billing</h2>
            <p>
              Billing for NetraOps is conducted on a per-site monthly basis. Subscription tiers, payment terms, and related financial agreements are handled separately through signed commercial contracts or integrated payment systems (when implemented). Failure to pay may result in suspension of services.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white mb-4">6. Liability Limits</h2>
            <p>
              In no event shall NetraOps, its directors, employees, partners, agents, or affiliates, be liable for any indirect, incidental, special, consequential or punitive damages, including without limitation, loss of profits, data, use, goodwill, or other intangible losses, resulting from your access to or use of or inability to access or use NetraOps.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white mb-4">7. Termination</h2>
            <p>
              We may terminate or suspend access to our service immediately, without prior notice or liability, for any reason whatsoever, including without limitation if you breach the Terms. All provisions of the Terms which by their nature should survive termination shall survive termination, including ownership provisions, warranty disclaimers, indemnity, and limitations of liability.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white mb-4">8. Governing Law</h2>
            <p>
              These Terms shall be governed and construed in accordance with the laws of California, USA, without regard to its conflict of law provisions.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white mb-4">9. Contact Us</h2>
            <p>
              If you have any questions about these Terms, please contact us at: <a href="mailto:vvishnu1998@gmail.com" className="text-[#00C8FF] hover:underline">vvishnu1998@gmail.com</a>.
            </p>
          </section>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-[#1A2639] py-8 text-center text-gray-500 text-sm">
        <p>&copy; {new Date().getFullYear()} NetraOps. All rights reserved.</p>
      </footer>
    </div>
  );
}
