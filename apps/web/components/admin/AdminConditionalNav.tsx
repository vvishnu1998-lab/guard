'use client';
import { usePathname } from 'next/navigation';
import AdminNav from './AdminNav';

export default function AdminConditionalNav() {
  const pathname = usePathname();
  if (pathname === '/admin/login') return null;
  return <AdminNav />;
}
