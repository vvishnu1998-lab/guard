import AdminConditionalNav from '../../components/admin/AdminConditionalNav';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden">
      <AdminConditionalNav />
      {/* On mobile: push content down 56px (mobile top bar height) */}
      <main className="flex-1 overflow-y-auto bg-[#0B1526] p-4 md:p-6 pt-[72px] md:pt-6">{children}</main>
    </div>
  );
}
