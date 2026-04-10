import AdminConditionalNav from '../../components/admin/AdminConditionalNav';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden">
      <AdminConditionalNav />
      <main className="flex-1 overflow-y-auto bg-[#0B1526] p-6">{children}</main>
    </div>
  );
}
