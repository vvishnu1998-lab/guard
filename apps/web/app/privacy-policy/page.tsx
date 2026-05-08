export const metadata = {
  title: 'Privacy Policy — Netra Security Management',
};

export default function PrivacyPolicy() {
  return (
    <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", background: '#f8fafc', color: '#1e293b', lineHeight: 1.7, minHeight: '100vh' }}>
      <header style={{ background: '#0b1526', color: '#fff', padding: '32px 24px' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, letterSpacing: '0.05em', margin: 0 }}>NetraOps — Privacy Policy</h1>
        <p style={{ color: '#94a3b8', fontSize: '0.85rem', marginTop: 4, marginBottom: 0 }}>Security Management Platform</p>
      </header>

      <main style={{ maxWidth: 760, margin: '40px auto', padding: '0 24px 80px' }}>
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '16px 20px', marginBottom: 32, fontSize: '0.85rem', color: '#64748b' }}>
          <strong style={{ color: '#1e293b' }}>Effective date:</strong> April 14, 2026 &nbsp;·&nbsp;
          <strong style={{ color: '#1e293b' }}>Last updated:</strong> April 14, 2026 &nbsp;·&nbsp;
          <strong style={{ color: '#1e293b' }}>Contact:</strong>{' '}
          <a href="mailto:vvishnu1998@gmail.com" style={{ color: '#2563eb' }}>vvishnu1998@gmail.com</a>
        </div>

        <p style={{ marginBottom: 12, fontSize: '0.95rem', color: '#334155' }}>
          Netra ("Netra", "we", "our") operates the Netra mobile application and web portals. This Privacy Policy explains what information we collect, how we use it, and your rights regarding that information.
        </p>

        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0b1526', margin: '36px 0 10px', paddingBottom: 6, borderBottom: '2px solid #e2e8f0' }}>1. Information We Collect</h2>
        <ul style={{ margin: '8px 0 12px 20px' }}>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}><strong>Account information:</strong> Name, email address, and company affiliation provided at registration.</li>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}><strong>Location data:</strong> GPS coordinates collected during active guard shifts for geofence compliance verification. Location is only collected when the app is in use during a shift.</li>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}><strong>Camera / photos:</strong> Photos taken at clock-in (selfie for identity verification) and during shift reports (site photos for incident documentation). Photos are stored securely and scoped to your employer.</li>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}><strong>Shift and report data:</strong> Clock-in/clock-out times, shift duration, activity reports, incident reports, and maintenance reports submitted during shifts.</li>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}><strong>Device identifiers:</strong> Push notification tokens (FCM) for real-time alert delivery.</li>
        </ul>

        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0b1526', margin: '36px 0 10px', paddingBottom: 6, borderBottom: '2px solid #e2e8f0' }}>2. How We Use Your Information</h2>
        <ul style={{ margin: '8px 0 12px 20px' }}>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}>Verify guard presence on-site during shifts via GPS geofencing.</li>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}>Confirm guard identity at clock-in via photo verification.</li>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}>Generate shift reports and audit records for security operations.</li>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}>Send real-time alerts to security managers for incidents and geofence violations.</li>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}>Provide clients (site owners) with read-only access to reports for their site.</li>
        </ul>

        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0b1526', margin: '36px 0 10px', paddingBottom: 6, borderBottom: '2px solid #e2e8f0' }}>3. Camera Permission</h2>
        <p style={{ marginBottom: 12, fontSize: '0.95rem', color: '#334155' }}>Netra requests camera access for two purposes:</p>
        <ul style={{ margin: '8px 0 12px 20px' }}>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}><strong>Clock-in selfie:</strong> A photo is captured at the start of each shift to verify the correct guard is on duty. This photo is stored securely and visible only to your company administrator.</li>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}><strong>Report photos:</strong> Guards may attach photos to incident and maintenance reports. These photos are stored in secure cloud storage (AWS S3) and accessible only to authorized personnel.</li>
        </ul>
        <p style={{ marginBottom: 12, fontSize: '0.95rem', color: '#334155' }}>Camera access is only requested when actively clocking in or submitting a report. Netra does not access the camera in the background.</p>

        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0b1526', margin: '36px 0 10px', paddingBottom: 6, borderBottom: '2px solid #e2e8f0' }}>4. Location Permission</h2>
        <p style={{ marginBottom: 12, fontSize: '0.95rem', color: '#334155' }}>Netra requests location access to:</p>
        <ul style={{ margin: '8px 0 12px 20px' }}>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}>Verify you are within the designated site boundary when clocking in.</li>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}>Send periodic GPS pings during active shifts for live guard tracking visible to your security manager.</li>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}>Trigger geofence violation alerts if a guard leaves the designated area during a shift.</li>
        </ul>
        <p style={{ marginBottom: 12, fontSize: '0.95rem', color: '#334155' }}>Location data is collected only while a shift is active. Location is not collected in the background when no shift is in progress.</p>

        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0b1526', margin: '36px 0 10px', paddingBottom: 6, borderBottom: '2px solid #e2e8f0' }}>5. Data Retention</h2>
        <ul style={{ margin: '8px 0 12px 20px' }}>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}>Shift records, GPS pings, and reports are retained for <strong>90 days</strong> after a site contract ends.</li>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}>After 90 days from contract end, client portal access is revoked. Data is fully deleted within 150 days.</li>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}>Active accounts retain all data for the duration of their service agreement.</li>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}>You may request deletion of your personal data at any time by contacting us.</li>
        </ul>

        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0b1526', margin: '36px 0 10px', paddingBottom: 6, borderBottom: '2px solid #e2e8f0' }}>6. Data Sharing</h2>
        <p style={{ marginBottom: 12, fontSize: '0.95rem', color: '#334155' }}>We do not sell your personal data. Data is shared only with:</p>
        <ul style={{ margin: '8px 0 12px 20px' }}>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}><strong>Your employer / security company:</strong> Shift data, location, and reports are visible to your company administrator.</li>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}><strong>Site clients:</strong> Site owners have read-only access to reports filed at their site.</li>
          <li style={{ fontSize: '0.95rem', color: '#334155', marginBottom: 6 }}><strong>Service providers:</strong> AWS S3 (photo storage), Railway (database hosting), SendGrid (email delivery), Firebase (push notifications), Twilio (SMS OTP). All are bound by data processing agreements.</li>
        </ul>

        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0b1526', margin: '36px 0 10px', paddingBottom: 6, borderBottom: '2px solid #e2e8f0' }}>7. Security</h2>
        <p style={{ marginBottom: 12, fontSize: '0.95rem', color: '#334155' }}>All data is transmitted over HTTPS. Passwords are stored as bcrypt hashes. JWT tokens expire after 8 hours. Photos are stored in private S3 buckets with signed URLs. Database access is restricted to the application server.</p>

        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0b1526', margin: '36px 0 10px', paddingBottom: 6, borderBottom: '2px solid #e2e8f0' }}>8. Your Rights</h2>
        <p style={{ marginBottom: 12, fontSize: '0.95rem', color: '#334155' }}>Depending on your jurisdiction, you may have rights to access, correct, or delete your personal data. To exercise these rights, contact us at <a href="mailto:vvishnu1998@gmail.com" style={{ color: '#2563eb' }}>vvishnu1998@gmail.com</a>.</p>

        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0b1526', margin: '36px 0 10px', paddingBottom: 6, borderBottom: '2px solid #e2e8f0' }}>9. Children&apos;s Privacy</h2>
        <p style={{ marginBottom: 12, fontSize: '0.95rem', color: '#334155' }}>Netra is designed for use by employed security professionals. We do not knowingly collect data from individuals under 18 years of age.</p>

        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0b1526', margin: '36px 0 10px', paddingBottom: 6, borderBottom: '2px solid #e2e8f0' }}>10. Changes to This Policy</h2>
        <p style={{ marginBottom: 12, fontSize: '0.95rem', color: '#334155' }}>We may update this policy as the app evolves. The effective date at the top of this page will reflect the most recent revision. Continued use of the app after changes constitutes acceptance.</p>

        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0b1526', margin: '36px 0 10px', paddingBottom: 6, borderBottom: '2px solid #e2e8f0' }}>11. Contact</h2>
        <p style={{ marginBottom: 12, fontSize: '0.95rem', color: '#334155' }}>
          For privacy questions or data requests, contact:<br />
          <strong>Netra</strong><br />
          <a href="mailto:vvishnu1998@gmail.com" style={{ color: '#2563eb' }}>vvishnu1998@gmail.com</a>
        </p>
      </main>

      <footer style={{ textAlign: 'center', padding: 32, fontSize: '0.8rem', color: '#94a3b8', borderTop: '1px solid #e2e8f0' }}>
        © 2026 Netra. All rights reserved.
      </footer>
    </div>
  );
}
