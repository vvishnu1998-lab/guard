import AdminNav from '../../components/admin/AdminNav';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden">
      <AdminNav />
      <main className="flex-1 overflow-y-auto bg-[#1A1A2E] p-6">{children}</main>
    </div>
  );
}
