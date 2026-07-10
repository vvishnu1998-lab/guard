'use client';
/**
 * Session B — admin "Preview as client" support.
 *
 * When an admin clicks PREVIEW AS CLIENT on the sites page we open a new
 * tab at /client?preview=<jwt>. clientApi.getToken() adopts the token
 * and drops it into the guard_client_access cookie on the first fetch.
 * This component then scrubs the URL so refreshing the tab doesn't
 * re-inject the (possibly expired) token. Renders nothing.
 */
import { useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

export default function PreviewBootstrap() {
  const router       = useRouter();
  const pathname     = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!searchParams?.get('preview')) return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete('preview');
    const rest = next.toString();
    router.replace(rest ? `${pathname}?${rest}` : (pathname ?? '/client'), { scroll: false });
  }, [pathname, router, searchParams]);

  return null;
}
