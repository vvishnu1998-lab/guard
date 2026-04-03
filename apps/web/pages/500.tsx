export default function Custom500() {
  return (
    <main style={{ minHeight: '100vh', background: '#1A1A2E', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, fontFamily: 'sans-serif' }}>
      <h1 style={{ fontSize: 64, fontWeight: 700, color: '#EF4444', letterSpacing: 8, margin: 0 }}>500</h1>
      <p style={{ color: '#9CA3AF', letterSpacing: 4, fontSize: 14, margin: 0 }}>SERVER ERROR</p>
      <a href="/" style={{ border: '1px solid #FBBF24', color: '#FBBF24', padding: '8px 24px', borderRadius: 8, letterSpacing: 4, fontSize: 12, textDecoration: 'none' }}>GO HOME</a>
    </main>
  );
}
