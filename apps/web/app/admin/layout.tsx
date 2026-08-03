import AdminConditionalNav from '../../components/admin/AdminConditionalNav';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden">
      <AdminConditionalNav />
      {/* On mobile: push content down 56px (mobile top bar height) */}
      {/* scrollbar-gutter: stable — reserve the gutter whether or not the
          scrollbar is present, so content growing past the fold (or modals)
          never reflows the page on classic-scrollbar machines. */}
      <main className="flex-1 overflow-y-auto [scrollbar-gutter:stable] bg-[#0B1526] p-4 md:p-6 pt-[72px] md:pt-6">{children}</main>
    </div>
  );
}
