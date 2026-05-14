import React from 'react';
import Link from 'next/link';

export default function PrivacyPolicy() {
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
          <h1 className="text-4xl md:text-5xl font-bold text-white tracking-tight">Privacy Policy</h1>
          <p className="text-gray-400 text-lg">Effective Date: May 13, 2026</p>
        </div>

        <div className="space-y-12 prose prose-invert prose-p:text-gray-300 prose-headings:text-white prose-a:text-[#00C8FF] max-w-none">
          <section>
            <h2 className="text-2xl font-bold text-white mb-4">1. Introduction</h2>
            <p className="mb-4">
              Welcome to NetraOps.
            </p>
            <p>
              We take your privacy seriously. This Privacy Policy explains who we are, what information we collect, why we collect it, how it is used, and your rights regarding your data. By using NetraOps, you agree to the practices described in this policy.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white mb-4">2. Who We Are</h2>
            <p>
              NetraOps provides an operations platform for security companies and their clients. If you have any questions about this policy or our privacy practices, you can contact us at: <a href="mailto:vvishnu1998@gmail.com" className="text-[#00C8FF] hover:underline">vvishnu1998@gmail.com</a>.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white mb-4">3. What Data We Collect and Why</h2>
            <p className="mb-4">We collect specific types of information to provide and improve NetraOps:</p>
            <ul className="list-disc pl-6 space-y-3">
              <li><strong>Account Information:</strong> Name, email, hashed password, and employer/company affiliation. This is required to create your account, manage access securely, and associate you with the correct security company.</li>
              <li><strong>Location Data:</strong> We collect your device's location (including in the background) only during active shifts. This verifies clock-ins, monitors geofence compliance, and sends periodic location pings to your supervisor for safety monitoring.</li>
              <li><strong>Photos:</strong> Incident reports and location verification pings may include photos. These are necessary to provide verifiable proof of presence and document events.</li>
              <li><strong>Device Information & Push Tokens:</strong> We collect device details and push notification tokens to send you important alerts, schedule changes, and operational updates.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white mb-4">4. Biometric Data Notice</h2>
            <p>
              If you enable Face ID or Touch ID for secure login on the NetraOps mobile app, your biometric template remains stored securely on your device. We do not transmit, collect, or store your biometric data on our servers.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white mb-4">5. Data Retention</h2>
            <p className="mb-4">We adhere to a strict data retention policy to minimize stored data:</p>
            <ul className="list-disc pl-6 space-y-3">
              <li><strong>Incident Reports & Photos:</strong> Accessible to clients for 90 days. From 90 to 150 days, they are accessible only to NetraOps administrators. They are permanently deleted at day 150.</li>
              <li><strong>Location Ping Photos:</strong> Kept on a 7-day rolling deletion schedule.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white mb-4">6. Third-Party Services</h2>
            <p className="mb-4">We rely on trusted third-party providers to operate NetraOps:</p>
            <ul className="list-disc pl-6 space-y-3">
              <li><strong>AWS:</strong> Secure storage of photos and documents.</li>
              <li><strong>Google Maps:</strong> Location services and geofencing.</li>
              <li><strong>Firebase:</strong> Delivery of push notifications.</li>
              <li><strong>SendGrid:</strong> Sending automated email alerts and reports.</li>
              <li><strong>Railway:</strong> Secure cloud hosting for our API and databases.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white mb-4">7. Your Rights</h2>
            <p>
              You have the right to access, correct, or request the deletion of your personal information. To exercise these rights, please contact your employer (the security company managing your account) or reach out to us directly at <a href="mailto:vvishnu1998@gmail.com" className="text-[#00C8FF] hover:underline">vvishnu1998@gmail.com</a>.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white mb-4">8. Children's Privacy</h2>
            <p>
              NetraOps is intended strictly for adults employed in the security sector. The app is not designed for or directed at children under the age of 18, and we do not knowingly collect personal data from minors.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white mb-4">9. Updates to this Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. Any changes will be posted on this page with an updated "Effective Date". Continued use of NetraOps after changes constitute your acceptance of the revised policy.
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
