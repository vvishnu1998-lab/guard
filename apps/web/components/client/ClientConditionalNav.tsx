'use client';
import { usePathname } from 'next/navigation';
import ClientNav from './ClientNav';

export default function ClientConditionalNav() {
  const pathname = usePathname();
  if (pathname === '/client/login' || pathname === '/client/select-site') return null;
  return <ClientNav />;
}
