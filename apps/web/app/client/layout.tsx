import ClientConditionalNav from '../../components/client/ClientConditionalNav';

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden">
      <ClientConditionalNav />
      <main className="flex-1 overflow-y-auto bg-[#0B1526] p-6">{children}</main>
    </div>
  );
}
