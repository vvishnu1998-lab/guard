# Phase 5 — Web / Next.js frontend

## Score: 6/10

Three portals (admin, client, vishnu super-admin) all exist and cover the main CRUD surfaces. Biggest drags: `strict: false` in tsconfig, 36 `: any` uses, no tests, no marketing/signup page, and no evidence of responsive or dark-mode testing discipline.

## Portal inventory

| Portal | Routes (apps/web/app/) |
|---|---|
| Admin | `/admin` + `/admin/{analytics, clients, guards, live-map, login, reports, reset-password, shifts, sites, tasks}` |
| Client | `/client` + `/client/{download, login, reset-password, schedule}` |
| Vishnu | `/vishnu` + children (companies, sites, retention, etc. — see dir listing) |
| Public | `/` (root), `/privacy-policy`, `/not-found` |

## CRITICAL

### C1. No public marketing or signup surface
**File**: `apps/web/app/page.tsx` (verify content)
There is no `/pricing`, `/signup`, `/about`, or any acquisition page. The only public routes are the three login pages and `/privacy-policy`. For a SaaS charging $149/site/month, the only way a prospect becomes a customer is: find you → email you → you manually create their company → you manually create their primary admin. That's not a sellable product, that's a bespoke engagement.

This ties back to Phase 8 — there is no Stripe, no onboarding, no invite flow. The web app is an admin console, not a product.

## MAJOR

### M1. `tsconfig.json` has `strict: false`
**File**: `apps/web/tsconfig.json:16`
Only `strictNullChecks` is on. `noImplicitAny`, `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`, `alwaysStrict` are all off. 36 `: any` occurrences across 16 files is the visible symptom. Silent type regressions are inevitable; at least one of the bugs fixed in recent commits (`daab01d`, `fc075fa`) looks like the kind that a strict build would have caught at compile time.

**Fix**: flip to `strict: true`, fix the fallout (likely a day of work), commit. Not sellable until this is done — enterprise buyers look at `tsconfig.json` during due diligence.

### M2. Forgot-password works but is not discoverable as its own flow
Each login page (admin, client, vishnu) has an inline modal that POSTs to `/api/auth/forgot-password` (e.g., `admin/login/page.tsx:63`). There is no `/forgot-password` page, no direct link in reset emails except via the token URL. Functionally fine, but if the modal UI regresses silently, there's no canonical page to fall back to.

### M3. Dashboard realtime: polling, not push
Grep confirms no WebSocket/SSE server. The live-map and dashboard refresh via interval timers (verify in `admin/live-map/page.tsx`). For a "live" guard-tracking product that's the main UX promise, SSE or a long-poll would be cheap to add and visibly more responsive. At 28 location pings over the whole DB that's a moot point today, but at 100 active guards it matters.

### M4. `"guard app/"` directory in repo root (untracked)
From `git status`: `?? "guard app/"`. A directory with a space in the name and untracked — likely a stray `npx create-*` output or a prior scaffold attempt. Clean up or commit; leaving it risks accidental `git add .`.

## MINOR

- **`apps/web/tsconfig.tsbuildinfo` is tracked**: `git status` shows it modified. Build artifacts don't belong in the repo; add to `.gitignore` (there is an `apps/web/.gitignore` untracked — may already handle this).
- **No `<meta>` tag discipline verified** — title, description, og:image not audited. Likely default Next.js scaffolding.
- **No `robots.txt` / `sitemap.xml`** — fine for an admin-only app, concerning once marketing pages exist.
- **`play-store-assets/` and two MP4 demo files** untracked in repo root. Not code, but should be in a separate assets branch or S3, not the main repo.
- **Public /privacy-policy page exists** (good — required for app store listings).

## WORKING WELL

- **App Router (Next.js 14)** — modern, server-component-ready.
- **Three cleanly separated portals** — no role confusion in routing; each has its own `layout.tsx` and `login` page.
- **Reset-password pages exist for all three portals** (`admin/reset-password`, `client/reset-password`, plus `vishnu/reset-password` expected under `/vishnu/`).
- **Client portal `download` route exists** for PDF reports (pairs with the client PDF export endpoint).
- **`not-found.tsx`** — custom 404 page.
- **Privacy policy page exists** — necessary for Play Store / App Store.

## UNVERIFIED

- Dashboard responsiveness at <640px, 768px, 1024px (would require live preview).
- Dark mode consistency across portals (not tested).
- Actual UX of the forgot-password modal (functional, not usability-tested).
- Whether the mobile-responsive fixes in commit `fc075fa` ("mobile responsive portals") hold across the 25+ pages.
- Whether any page currently throws a client-side error on load in production.
