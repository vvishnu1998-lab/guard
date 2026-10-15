import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { apiHost, sameSite } from './lib/session';

/**
 * Next.js Edge Middleware — route protection for all three portals.
 *
 * Portal → cookie → redirect-to-login mapping:
 *   /admin/*   → guard_admin_access   → /admin/login
 *   /client/*  → guard_client_access  → /client/login
 *   /vishnu/*  → guard_vishnu_access  → /vishnu/login
 *
 * Public paths (login) are always let through without a cookie. The
 * forgot-password flow is a panel on the login page + email-delivered
 * temp password, so there is no separate public reset URL.
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
 *
 * N203 stage 2 (Vishnu's 1a, 2026-10-15): where the web and the API are one
 * site (www.netraops.com), the session is the API's HttpOnly cookie, which this
 * host never sees. A non-secret hint, netraops_<portal>_signed_in, lets the
 * portal's pages through; it decides nothing, because the API's 401 is the real
 * check (lib/session.ts). A session signed in before stage 2 carries today's
 * token cookie and no hint: the token is verified as above and swapped for the
 * hint, once, for the rest of its life, so nobody is signed out. Elsewhere (a
 * Vercel preview) the token cookie is checked as above, unchanged.
 */

const ROUTES = [
  {
    prefix:             '/admin',
    loginPath:          '/admin/login',
    cookieName:         'guard_admin_access',
    refreshName:        'guard_admin_refresh',
    hintName:           'netraops_admin_signed_in',
    secretEnvVar:       'JWT_SECRET',
  },
  {
    prefix:             '/client',
    loginPath:          '/client/login',
    cookieName:         'guard_client_access',
    refreshName:        'guard_client_refresh',
    hintName:           'netraops_client_signed_in',
    secretEnvVar:       'JWT_SECRET',
  },
  {
    prefix:             '/vishnu',
    loginPath:          '/vishnu/login',
    cookieName:         'guard_vishnu_access',
    refreshName:        'guard_vishnu_refresh',
    hintName:           'netraops_vishnu_signed_in',
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

    // Let login page through without a valid session
    if (
      pathname === route.loginPath ||
      pathname.startsWith(route.loginPath + '/')
    ) {
      return NextResponse.next();
    }

    if (sameSite(req.nextUrl.hostname, apiHost())) {
      if (req.cookies.get(route.hintName)?.value === '1') return NextResponse.next();
      // 1a: a session from before stage 2 swaps its token cookie for the hint.
      const legacy = req.cookies.get(route.cookieName)?.value;
      const legacySecret = getSecret(route.secretEnvVar);
      if (legacy && legacySecret) {
        try {
          const { payload } = await jwtVerify(legacy, legacySecret, { algorithms: ['HS256'] });
          const left = typeof payload.exp === 'number' ? payload.exp - Math.floor(Date.now() / 1000) : 0;
          const res = NextResponse.next();
          res.cookies.set(route.hintName, '1', { path: '/', maxAge: Math.max(left, 1), sameSite: 'lax', secure: req.nextUrl.protocol === 'https:' });
          res.cookies.delete(route.cookieName);
          res.cookies.delete(route.refreshName);
          return res;
        } catch {
          // Expired or not ours: the sign-in page, below.
        }
      }
      const res = NextResponse.redirect(
        new URL(`${route.loginPath}?from=${encodeURIComponent(pathname + (req.nextUrl.search ?? ''))}`, req.url),
      );
      if (legacy) res.cookies.delete(route.cookieName);
      return res;
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
