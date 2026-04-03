import { NextRequest, NextResponse } from 'next/server';

/**
 * Next.js Edge Middleware — route protection for all three portals.
 *
 * Portal → cookie → redirect-to-login mapping:
 *   /admin/*   → guard_admin_access   → /admin/login
 *   /client/*  → guard_client_access  → /client/login
 *   /vishnu/*  → guard_vishnu_access  → /vishnu/login
 *
 * Decodes the JWT access token without importing jsonwebtoken
 * (Edge runtime does not support Node.js crypto — we do a lightweight decode only).
 * Full signature verification happens on the API for every data request.
 */

const ROUTES = [
  {
    prefix:     '/admin',
    loginPath:  '/admin/login',
    cookieName: 'guard_admin_access',
  },
  {
    prefix:     '/client',
    loginPath:  '/client/login',
    cookieName: 'guard_client_access',
  },
  {
    prefix:     '/vishnu',
    loginPath:  '/vishnu/login',
    cookieName: 'guard_vishnu_access',
  },
];

function decodeJwtExpiry(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(atob(payload));
    return decoded.exp ?? null;
  } catch {
    return null;
  }
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  for (const route of ROUTES) {
    if (!pathname.startsWith(route.prefix)) continue;

    // Let login page through
    if (pathname === route.loginPath || pathname.startsWith(route.loginPath + '/')) {
      return NextResponse.next();
    }

    const token = req.cookies.get(route.cookieName)?.value;
    if (!token) {
      return NextResponse.redirect(new URL(`${route.loginPath}?from=${pathname}`, req.url));
    }

    const exp = decodeJwtExpiry(token);
    if (!exp || exp * 1000 < Date.now()) {
      // Token expired — redirect to login and clear stale cookie
      const res = NextResponse.redirect(new URL(`${route.loginPath}?expired=1`, req.url));
      res.cookies.delete(route.cookieName);
      return res;
    }

    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/client/:path*', '/vishnu/:path*'],
};
