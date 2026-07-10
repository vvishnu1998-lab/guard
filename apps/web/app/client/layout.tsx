import { Suspense } from 'react';
import ClientConditionalNav from '../../components/client/ClientConditionalNav';
import PreviewBootstrap from '../../components/client/PreviewBootstrap';

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden">
      {/* Adopts ?preview=<token> from window.open, then scrubs the URL. */}
      <Suspense fallback={null}><PreviewBootstrap /></Suspense>
      <ClientConditionalNav />
      <main className="flex-1 overflow-y-auto bg-[#0B1526] p-4 md:p-6 pt-[72px] md:pt-6">{children}</main>
    </div>
  );
}
