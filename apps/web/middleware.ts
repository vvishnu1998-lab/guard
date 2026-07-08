import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

/**
 * Next.js Edge Middleware — route protection for all three portals.
 *
 * Portal → cookie → redirect-to-login mapping:
 *   /admin/*   → guard_admin_access   → /admin/login
 *   /client/*  → guard_client_access  → /client/login
 *   /vishnu/*  → guard_vishnu_access  → /vishnu/login
 *
 * Public paths (login + reset-password) are always let through without a cookie.
 *
 * Verifies HS256 signature with the portal's own signing key (must match the
 * API's signing key for the corresponding role) via `jose`, which is
 * Edge-runtime compatible (does not need node:crypto). On failure — bad
 * signature, tampered payload, expired, or missing secret — the cookie is
 * cleared and the request is redirected to the portal's login.
 *
 * Per-portal key routing mirrors the API (see `secretForRole` in
 * apps/api/src/middleware/auth.ts): vishnu → VISHNU_JWT_SECRET, all
 * others → JWT_SECRET.
 */

const ROUTES = [
  {
    prefix:             '/admin',
    loginPath:          '/admin/login',
    resetPasswordPath:  '/admin/reset-password',
    cookieName:         'guard_admin_access',
    secretEnvVar:       'JWT_SECRET',
  },
  {
    prefix:             '/client',
    loginPath:          '/client/login',
    resetPasswordPath:  '/client/reset-password',
    cookieName:         'guard_client_access',
    secretEnvVar:       'JWT_SECRET',
  },
  {
    prefix:             '/vishnu',
    loginPath:          '/vishnu/login',
    resetPasswordPath:  '/vishnu/reset-password',
    cookieName:         'guard_vishnu_access',
    secretEnvVar:       'VISHNU_JWT_SECRET',
  },
] as const;

const encoder = new TextEncoder();

function getSecret(envVar: string): Uint8Array | null {
  const s = process.env[envVar];
  return s ? encoder.encode(s) : null;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  for (const route of ROUTES) {
    if (!pathname.startsWith(route.prefix)) continue;

    // Let login and reset-password pages through without a valid session
    if (
      pathname === route.loginPath ||
      pathname.startsWith(route.loginPath + '/') ||
      pathname === route.resetPasswordPath ||
      pathname.startsWith(route.resetPasswordPath + '/')
    ) {
      return NextResponse.next();
    }

    const token = req.cookies.get(route.cookieName)?.value;
    if (!token) {
      // Preserve query string too — the incident-email deep-link relies on
      // ?report=<id> surviving a login redirect. encodeURIComponent flattens
      // the nested ?/= into %-escapes so URLSearchParams unpacks cleanly on
      // the login page.
      const originalPath = pathname + (req.nextUrl.search ?? '');
      return NextResponse.redirect(
        new URL(`${route.loginPath}?from=${encodeURIComponent(originalPath)}`, req.url),
      );
    }

    const secret = getSecret(route.secretEnvVar);
    if (!secret) {
      // Fail-closed: if the portal's signing key isn't configured we
      // cannot verify, so we treat every token as invalid rather than
      // fall through.
      const res = NextResponse.redirect(new URL(`${route.loginPath}?invalid=1`, req.url));
      res.cookies.delete(route.cookieName);
      return res;
    }

    try {
      await jwtVerify(token, secret, { algorithms: ['HS256'] });
    } catch (err) {
      const expired = (err as { code?: string })?.code === 'ERR_JWT_EXPIRED';
      const res = NextResponse.redirect(
        new URL(`${route.loginPath}?${expired ? 'expired=1' : 'invalid=1'}`, req.url),
      );
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
