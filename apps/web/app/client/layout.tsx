import ClientNav from '../../components/client/ClientNav';

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden">
      <ClientNav />
      <main className="flex-1 overflow-y-auto bg-[#1A1A2E] p-6">{children}</main>
    </div>
  );
}
