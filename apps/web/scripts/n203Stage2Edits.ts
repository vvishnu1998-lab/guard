/**
 * N203 stage 2's edits to the web (Vishnu's decisions 1a 2a 3b 4a, 2026-10-15), file by file, as exact
 * replacements on main before it (51814bc). Each pair is one hunk of that diff with enough unchanged lines
 * around it to be found once.
 *
 * scripts/check-session-cookie.ts proves that applying them to 51814bc's files gives today's and undoing them
 * gives 51814bc's back. Older checks that compare a page with their own BASE undo them first, so each still
 * proves its own change exactly. lib/session.ts is new in stage 2 and components/client/PreviewBootstrap.tsx is
 * gone; neither is here.
 */
export const N203_STAGE2_BASE = '51814bca7831b43687109fd80974b20a09815c40';

export const N203_STAGE2_EDITS: Record<string, Array<[string, string]>> = {
  "app/admin/billing/page.tsx": [
    [
      "import { adminGet } from '../../../lib/adminApi';\n",
      "import { adminGet } from '../../../lib/adminApi';\nimport { authInit } from '../../../lib/session';\n"
    ],
    [
      "const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';\nfunction getAdminToken() {\n  if (typeof document === 'undefined') return '';\n  return document.cookie.match(/guard_admin_access=([^;]+)/)?.[1] ?? '';\n}\n",
      "const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';\n"
    ],
    [
      "      const res = await fetch(`${API}/api/billing/hours-export?${params.toString()}`, {\n        headers: { Authorization: `Bearer ${getAdminToken()}` },\n      });\n",
      "      // N203 stage 2: the admin's session as lib/session.ts sends it.\n      const res = await fetch(`${API}/api/billing/hours-export?${params.toString()}`, authInit('admin'));\n"
    ]
  ],
  "app/admin/change-password/page.tsx": [
    [
      "import { useState, FormEvent } from 'react';\n",
      "import { useState, FormEvent } from 'react';\nimport { authInit, forgetSession } from '../../../lib/session';\n"
    ],
    [
      "\nfunction readCookie(name: string): string | null {\n  if (typeof document === 'undefined') return null;\n  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));\n  return m ? decodeURIComponent(m[1]) : null;\n}\n\nexport default function AdminChangePasswordPage() {\n",
      "\nexport default function AdminChangePasswordPage() {\n"
    ],
    [
      "      const access = readCookie('guard_admin_access');\n",
      "      // N203 stage 2: the session as lib/session.ts sends it (the cookie, or a preview's bearer token).\n      const auth = authInit('admin');\n"
    ],
    [
      "        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },\n",
      "        credentials: auth.credentials,\n        headers: { 'Content-Type': 'application/json', ...auth.headers },\n"
    ],
    [
      "      // cookies we hold are already revoked — expire them and send the\n      // admin to sign in fresh instead of into a wall of 401s.\n      document.cookie = 'guard_admin_access=; path=/; max-age=0; SameSite=Strict';\n      document.cookie = 'guard_admin_refresh=; path=/; max-age=0; SameSite=Strict';\n",
      "      // session we hold is already revoked, and the API cleared its cookie.\n      // Forget the rest and send the admin to sign in fresh instead of\n      // into a wall of 401s.\n      forgetSession('admin');\n"
    ]
  ],
  "app/admin/clients/page.tsx": [
    [
      "import { adminGet, adminPatch, adminPost, adminDelete } from '../../../lib/adminApi';\n",
      "import { adminGet, adminPatch, adminPost, adminDelete } from '../../../lib/adminApi';\nimport { markSignedIn } from '../../../lib/session';\n"
    ],
    [
      "      const r = await adminPost<{ access_token: string; expires_in: number }>(\n",
      "      // N206 (N203 stage 2): no token in a URL. The API set the client portal's\n      // cookie for the preview's 30 minutes; a preview of the web (bearer path)\n      // gets the token in the body instead. The hint lets the client pages open.\n      const r = await adminPost<{ access_token?: string; expires_in: number }>(\n"
    ],
    [
      "      window.open(`/client?preview=${encodeURIComponent(r.access_token)}`, '_blank', 'noopener');\n",
      "      markSignedIn('client', r.access_token, r.expires_in);\n      window.open('/client', '_blank', 'noopener');\n"
    ]
  ],
  "app/admin/login/page.tsx": [
    [
      "import { useSearchParams } from 'next/navigation';\n",
      "import { useSearchParams } from 'next/navigation';\nimport { COOKIE_REFUSED, markSignedIn, sessionKept, signInHeaders } from '../../../lib/session';\n"
    ],
    [
      "        credentials: 'include',\n        headers: { 'Content-Type': 'application/json' },\n",
      "        credentials: 'include',\n        headers: { 'Content-Type': 'application/json', ...signInHeaders('admin') },\n"
    ],
    [
      "      document.cookie = `guard_admin_access=${data.access}; path=/; max-age=28800; SameSite=Strict`;\n",
      "      // N203 stage 2: the session is the API's HttpOnly cookie; the page guard reads a hint (lib/session.ts).\n      markSignedIn('admin', data.access);\n      if (!(await sessionKept('admin'))) { setError(COOKIE_REFUSED); return; }\n"
    ]
  ],
  "app/admin/settings/page.tsx": [
    [
      "import { adminGet, adminPatch, ApiError } from '../../../lib/adminApi';\n",
      "import { adminGet, adminPatch, ApiError } from '../../../lib/adminApi';\nimport { authInit } from '../../../lib/session';\n"
    ],
    [
      "const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';\nfunction getAdminToken() {\n  if (typeof document === 'undefined') return '';\n  return document.cookie.match(/guard_admin_access=([^;]+)/)?.[1] ?? '';\n}\n",
      "const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';\n"
    ],
    [
      "  try {\n    const res = await fetch(`${API}/api/admin/company/logo`, {\n",
      "  try {\n    // N203 stage 2: the admin's session as lib/session.ts sends it.\n    const res = await fetch(`${API}/api/admin/company/logo`, {\n"
    ],
    [
      "      headers: { Authorization: `Bearer ${getAdminToken()}` },\n",
      "      ...authInit('admin'),\n"
    ]
  ],
  "app/admin/sites/page.tsx": [
    [
      "import { adminGet, adminPatch, adminPost } from '../../../lib/adminApi';\n",
      "import { adminGet, adminPatch, adminPost } from '../../../lib/adminApi';\nimport { authInit } from '../../../lib/session';\n"
    ],
    [
      "const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';\nfunction getAdminToken() {\n  if (typeof document === 'undefined') return '';\n  return document.cookie.match(/guard_admin_access=([^;]+)/)?.[1] ?? '';\n}\n",
      "const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';\n"
    ],
    [
      "    try {\n      await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/api/scheduling/profile/${profile.id}`, {\n",
      "    try {\n      // N203 stage 2: the admin's session as lib/session.ts sends it.\n      const auth = authInit('admin');\n      await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/api/scheduling/profile/${profile.id}`, {\n"
    ],
    [
      "        method: 'DELETE',\n",
      "        method: 'DELETE',\n        credentials: auth.credentials,\n"
    ],
    [
      "          Authorization:   `Bearer ${document.cookie.match(/guard_admin_access=([^;]+)/)?.[1] ?? ''}`,\n",
      "          ...auth.headers,\n"
    ],
    [
      "    fd.append('file', file);\n",
      "    fd.append('file', file);\n    // N203 stage 2: the admin's session as lib/session.ts sends it.\n"
    ],
    [
      "      headers: { Authorization: `Bearer ${getAdminToken()}` },\n",
      "      ...authInit('admin'),\n"
    ]
  ],
  "app/client/change-password/page.tsx": [
    [
      "import { useState, FormEvent } from 'react';\n",
      "import { useState, FormEvent } from 'react';\nimport { authInit, forgetSession } from '../../../lib/session';\n"
    ],
    [
      "      <line x1=\"1\" y1=\"1\" x2=\"23\" y2=\"23\"/>\n    </svg>\n  );\n}\n\nfunction readCookie(name: string): string | null {\n  if (typeof document === 'undefined') return null;\n  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));\n  return m ? decodeURIComponent(m[1]) : null;\n}\n\n",
      "      <line x1=\"1\" y1=\"1\" x2=\"23\" y2=\"23\"/>\n    </svg>\n  );\n}\n\n"
    ],
    [
      "      const access = readCookie('guard_client_access');\n",
      "      // N203 stage 2: the session as lib/session.ts sends it (the cookie, or a preview's bearer token).\n      const auth = authInit('client');\n"
    ],
    [
      "        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },\n",
      "        credentials: auth.credentials,\n        headers: { 'Content-Type': 'application/json', ...auth.headers },\n"
    ],
    [
      "      // cookies we hold are already revoked — expire them and send the\n      // client to sign in fresh instead of into a wall of 401s.\n      document.cookie = 'guard_client_access=; path=/; max-age=0; SameSite=Strict';\n      document.cookie = 'guard_client_refresh=; path=/; max-age=0; SameSite=Strict';\n",
      "      // session we hold is already revoked, and the API cleared its cookie.\n      // Forget the rest and send the client to sign in fresh instead of\n      // into a wall of 401s.\n      forgetSession('client');\n"
    ]
  ],
  "app/client/layout.tsx": [
    [
      "import { Suspense } from 'react';\nimport ClientConditionalNav from '../../components/client/ClientConditionalNav';\n",
      "import ClientConditionalNav from '../../components/client/ClientConditionalNav';\n"
    ],
    [
      "import PreviewBootstrap from '../../components/client/PreviewBootstrap';\n\nexport default function ClientLayout({ children }: { children: React.ReactNode }) {\n",
      "\nexport default function ClientLayout({ children }: { children: React.ReactNode }) {\n"
    ],
    [
      "    <div className=\"flex h-screen overflow-hidden\">\n      {/* Adopts ?preview=<token> from window.open, then scrubs the URL. */}\n      <Suspense fallback={null}><PreviewBootstrap /></Suspense>\n",
      "    <div className=\"flex h-screen overflow-hidden\">\n"
    ]
  ],
  "app/client/login/page.tsx": [
    [
      "import { useSearchParams } from 'next/navigation';\n",
      "import { useSearchParams } from 'next/navigation';\nimport { COOKIE_REFUSED, markSignedIn, sessionKept, signInHeaders } from '../../../lib/session';\n"
    ],
    [
      "        credentials: 'include',\n        headers: { 'Content-Type': 'application/json' },\n",
      "        credentials: 'include',\n        headers: { 'Content-Type': 'application/json', ...signInHeaders('client') },\n"
    ],
    [
      "      document.cookie = `guard_client_access=${data.access}; path=/; max-age=28800; SameSite=Strict`;\n",
      "      // N203 stage 2: the session is the API's HttpOnly cookie; the page guard reads a hint (lib/session.ts).\n      markSignedIn('client', data.access);\n      if (!(await sessionKept('client'))) { setError(COOKIE_REFUSED); return; }\n"
    ]
  ],
  "app/client/select-site/page.tsx": [
    [
      "import { clientFetch, clientGet } from '../../../lib/clientApi';\n",
      "import { clientFetch, clientGet } from '../../../lib/clientApi';\nimport { markSignedIn } from '../../../lib/session';\n"
    ],
    [
      "      document.cookie = `guard_client_access=${data.access}; path=/; max-age=28800; SameSite=Strict`;\n",
      "      // N203 stage 2: the new site's session is the API's cookie (lib/session.ts); the hint is renewed.\n      markSignedIn('client', data.access);\n"
    ]
  ],
  "app/vishnu/login/page.tsx": [
    [
      "import { useState, FormEvent } from 'react';\n",
      "import { useState, FormEvent } from 'react';\nimport { COOKIE_REFUSED, markSignedIn, sessionKept, signInHeaders } from '../../../lib/session';\n"
    ],
    [
      "        credentials: 'include',\n        headers: { 'Content-Type': 'application/json' },\n",
      "        credentials: 'include',\n        headers: { 'Content-Type': 'application/json', ...signInHeaders('vishnu') },\n"
    ],
    [
      "      document.cookie = `guard_vishnu_access=${data.access}; path=/; max-age=28800; SameSite=Strict`;\n",
      "      // N203 stage 2: the session is the API's HttpOnly cookie; the page guard reads a hint (lib/session.ts).\n      markSignedIn('vishnu', data.access);\n      if (!(await sessionKept('vishnu'))) { setError(COOKIE_REFUSED); return; }\n"
    ]
  ],
  "lib/adminApi.ts": [
    [
      " * Reads the guard_admin_access JWT cookie and attaches it as Bearer token.\n",
      " * Sends the admin's session the way lib/session.ts says (N203 stage 2): the\n * API's HttpOnly cookie on the web's own site, the bearer token on a preview.\n"
    ],
    [
      " */\n\n",
      " */\nimport { authInit, signedOut } from './session';\n\n"
    ],
    [
      "const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';\n\nfunction getToken(): string {\n  if (typeof document === 'undefined') return '';\n  return document.cookie.match(/guard_admin_access=([^;]+)/)?.[1] ?? '';\n}\n",
      "const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';\n"
    ],
    [
      "export async function adminFetch(path: string, options?: RequestInit): Promise<Response> {\n",
      "export async function adminFetch(path: string, options?: RequestInit): Promise<Response> {\n  const auth = authInit('admin');\n"
    ],
    [
      "    cache: 'no-store',  // never serve a stale list — refetches after mutations must reflect them\n",
      "    cache: 'no-store',  // never serve a stale list — refetches after mutations must reflect them\n    credentials: auth.credentials,\n"
    ],
    [
      "      Authorization: `Bearer ${getToken()}`,\n",
      "      ...auth.headers,\n"
    ],
    [
      "  });\n",
      "  });\n  // N203 stage 2: the API's 401 is the real check. The session is gone: sign in again.\n  if (res.status === 401) signedOut('admin');\n"
    ]
  ],
  "lib/clientApi.ts": [
    [
      " * Reads the guard_client_access JWT cookie and attaches it as Bearer token.\n",
      " * Sends the client's session the way lib/session.ts says (N203 stage 2): the\n * API's HttpOnly cookie on the web's own site, the bearer token on a preview.\n * An admin's \"Preview as client\" arrives the same way, as the client portal's\n * cookie, never as a token in a URL (N206).\n"
    ],
    [
      " */\n\n",
      " */\nimport { authInit, signedOut } from './session';\n\n"
    ],
    [
      "\nfunction getToken(): string {\n  if (typeof document === 'undefined') return '';\n  // Session B — admin \"Preview as client\" flow. window.open drops a\n  // ?preview=<token> query param on the target URL. When there is no\n  // real client cookie yet, adopt the preview token AND persist it as\n  // the client cookie so subsequent navigations Just Work. The URL is\n  // scrubbed by <PreviewBootstrap /> after mount.\n  const cookieToken = document.cookie.match(/guard_client_access=([^;]+)/)?.[1];\n  if (cookieToken) return cookieToken;\n  try {\n    const params = new URLSearchParams(window.location.search);\n    const preview = params.get('preview');\n    if (preview) {\n      document.cookie = `guard_client_access=${preview}; path=/; SameSite=Strict`;\n      return preview;\n    }\n  } catch { /* SSR or non-browser env */ }\n  return '';\n}\n\nexport async function clientFetch(path: string, options?: RequestInit): Promise<Response> {\n",
      "\nexport async function clientFetch(path: string, options?: RequestInit): Promise<Response> {\n"
    ],
    [
      "  return fetch(`${API}${path}`, {\n",
      "  const auth = authInit('client');\n  const res = await fetch(`${API}${path}`, {\n    credentials: auth.credentials,\n"
    ],
    [
      "      Authorization: `Bearer ${getToken()}`,\n",
      "      ...auth.headers,\n"
    ],
    [
      "  });\n}\n",
      "  });\n  // N203 stage 2: the API's 401 is the real check. The session is gone: sign in again.\n  if (res.status === 401) signedOut('client');\n  return res;\n}\n"
    ]
  ],
  "lib/signOut.ts": [
    [
      " * refused request would sign the browser out and leave the session alive.\n",
      " * refused request would sign the browser out and leave the session alive.\n *\n * N203 stage 2: on the web's own site the session is the API's HttpOnly cookie,\n * which no script can see, so SIGN OUT always asks the API, naming the portal,\n * and the API clears the cookie. On a preview it sends the bearer token, as\n * before. Then the browser forgets the hint and any token (lib/session.ts).\n"
    ],
    [
      " */\nconst API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';\n",
      " */\nimport { authInit, cookieSession, forgetSession, SIGN_IN_PATH, type Portal } from './session';\n\nexport { SIGN_IN_PATH };\nexport type { Portal };\n\nconst API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';\n"
    ],
    [
      "\nexport type Portal = 'admin' | 'client' | 'vishnu';\n\nconst COOKIE_PREFIX: Record<Portal, string> = { admin: 'guard_admin', client: 'guard_client', vishnu: 'guard_vishnu' };\nexport const SIGN_IN_PATH: Record<Portal, string> = { admin: '/admin/login', client: '/client/login', vishnu: '/vishnu/login' };\nexport const SIGN_OUT_TIMEOUT_MS = 3000;\n",
      "\nexport const SIGN_OUT_TIMEOUT_MS = 3000;\n"
    ],
    [
      "    const prefix = COOKIE_PREFIX[portal];\n    const access = readCookie(`${prefix}_access`);\n    const refresh = readCookie(`${prefix}_refresh`);\n    if (access) {\n",
      "    const access = readCookie(`guard_${portal}_access`);\n    const refresh = readCookie(`guard_${portal}_refresh`);\n    if (cookieSession() || access) {\n"
    ],
    [
      "          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },\n",
      "          headers: { 'Content-Type': 'application/json', ...authInit(portal).headers },\n"
    ],
    [
      "    document.cookie = `${prefix}_access=; path=/; max-age=0`;\n    document.cookie = `${prefix}_refresh=; path=/; max-age=0`;\n",
      "    forgetSession(portal);\n"
    ]
  ],
  "lib/vishnuApi.ts": [
    [
      " * Reads the guard_vishnu_access JWT cookie and attaches it as Bearer token.\n",
      " * Sends the session the way lib/session.ts says (N203 stage 2): the API's\n * HttpOnly cookie on the web's own site, the bearer token on a preview.\n"
    ],
    [
      " */\n",
      " */\nimport { authInit, signedOut } from './session';\n"
    ],
    [
      "\nfunction getToken(): string {\n  if (typeof document === 'undefined') return '';\n  return document.cookie.match(/guard_vishnu_access=([^;]+)/)?.[1] ?? '';\n}\n\nexport async function vishnuFetch(path: string, options?: RequestInit): Promise<Response> {\n",
      "\nexport async function vishnuFetch(path: string, options?: RequestInit): Promise<Response> {\n"
    ],
    [
      "  return fetch(`${API}${path}`, {\n",
      "  const auth = authInit('vishnu');\n  const res = await fetch(`${API}${path}`, {\n    credentials: auth.credentials,\n"
    ],
    [
      "      Authorization: `Bearer ${getToken()}`,\n",
      "      ...auth.headers,\n"
    ],
    [
      "  });\n",
      "  });\n  // N203 stage 2: the API's 401 is the real check. The session is gone: sign in again.\n  if (res.status === 401) signedOut('vishnu');\n  return res;\n"
    ],
    [
      "    if (res.status === 401 && typeof window !== 'undefined') {\n      window.location.href = '/vishnu/login';\n",
      "    if (res.status === 401 && typeof window !== 'undefined') {\n"
    ]
  ],
  "middleware.ts": [
    [
      "import { jwtVerify } from 'jose';\n",
      "import { jwtVerify } from 'jose';\nimport { apiHost, sameSite } from './lib/session';\n"
    ],
    [
      " * others → JWT_SECRET.\n",
      " * others → JWT_SECRET.\n *\n * N203 stage 2 (Vishnu's 1a, 2026-10-15): where the web and the API are one\n * site (www.netraops.com), the session is the API's HttpOnly cookie, which this\n * host never sees. A non-secret hint, netraops_<portal>_signed_in, lets the\n * portal's pages through; it decides nothing, because the API's 401 is the real\n * check (lib/session.ts). A session signed in before stage 2 carries today's\n * token cookie and no hint: the token is verified as above and swapped for the\n * hint, once, for the rest of its life, so nobody is signed out. Elsewhere (a\n * Vercel preview) the token cookie is checked as above, unchanged.\n"
    ],
    [
      "    cookieName:         'guard_admin_access',\n",
      "    cookieName:         'guard_admin_access',\n    refreshName:        'guard_admin_refresh',\n    hintName:           'netraops_admin_signed_in',\n"
    ],
    [
      "    cookieName:         'guard_client_access',\n",
      "    cookieName:         'guard_client_access',\n    refreshName:        'guard_client_refresh',\n    hintName:           'netraops_client_signed_in',\n"
    ],
    [
      "    cookieName:         'guard_vishnu_access',\n",
      "    cookieName:         'guard_vishnu_access',\n    refreshName:        'guard_vishnu_refresh',\n    hintName:           'netraops_vishnu_signed_in',\n"
    ],
    [
      "      return NextResponse.next();\n",
      "      return NextResponse.next();\n    }\n\n    if (sameSite(req.nextUrl.hostname, apiHost())) {\n      if (req.cookies.get(route.hintName)?.value === '1') return NextResponse.next();\n      // 1a: a session from before stage 2 swaps its token cookie for the hint.\n      const legacy = req.cookies.get(route.cookieName)?.value;\n      const legacySecret = getSecret(route.secretEnvVar);\n      if (legacy && legacySecret) {\n        try {\n          const { payload } = await jwtVerify(legacy, legacySecret, { algorithms: ['HS256'] });\n          const left = typeof payload.exp === 'number' ? payload.exp - Math.floor(Date.now() / 1000) : 0;\n          const res = NextResponse.next();\n          res.cookies.set(route.hintName, '1', { path: '/', maxAge: Math.max(left, 1), sameSite: 'lax', secure: req.nextUrl.protocol === 'https:' });\n          res.cookies.delete(route.cookieName);\n          res.cookies.delete(route.refreshName);\n          return res;\n        } catch {\n          // Expired or not ours: the sign-in page, below.\n        }\n      }\n      const res = NextResponse.redirect(\n        new URL(`${route.loginPath}?from=${encodeURIComponent(pathname + (req.nextUrl.search ?? ''))}`, req.url),\n      );\n      if (legacy) res.cookies.delete(route.cookieName);\n      return res;\n"
    ]
  ]
};

function replaceOnce(src: string, from: string, to: string, what: string): string {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`N203 stage 2 edit, ${what}: found ${n} times`);
  return src.replace(from, () => to);
}

/** A file as stage 2 left it, from its source at N203_STAGE2_BASE. Files stage 2 did not touch come back as they are. */
export function applyN203Stage2(rel: string, src: string): string {
  return (N203_STAGE2_EDITS[rel] || []).reduce((s, [from, to], i) => replaceOnce(s, from, to, `${rel} #${i + 1}`), src);
}

/** A file as it was before stage 2, from its source now. Files stage 2 did not touch come back as they are. */
export function undoN203Stage2(rel: string, src: string): string {
  return (N203_STAGE2_EDITS[rel] || []).slice().reverse().reduce((s, [from, to], i) => replaceOnce(s, to, from, `${rel} undo #${i + 1}`), src);
}
