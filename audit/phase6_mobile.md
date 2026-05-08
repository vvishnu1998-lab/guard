# Phase 6 — Mobile (Expo RN)

## Score: 6/10

The flows exist and the chain-of-custody for photos is enforced at the hook layer (camera-only, no gallery). But there's no test coverage, 28 `: any` uses, and the mobile app extends `expo/tsconfig.base` with no explicit strict flags — so compile-time guarantees are weaker than the API.

## Route inventory — `apps/mobile/app/`

### Auth (`(auth)/`)
`login.tsx`, `badge-login.tsx`, `change-password.tsx`, `sms-unlock.tsx`

### Tabs (`(tabs)/`)
`home.tsx`, `schedule.tsx`, `tasks.tsx`, `reports.tsx`, `alerts.tsx`, `notifications.tsx`, `profile.tsx`

**Note**: 7 tabs in the mobile app. Recent commit `a228f53` mentions "3-tab nav" — that refers to the web admin redesign, not mobile. Mobile-side tab count is worth a product discussion: 7 tabs on phone UI is cramped; industry standard is 3–5.

### Top-level flows
- `clock-in/step1..step4.tsx` — 4-step clock-in wizard
- `clock-out/index.tsx`
- `break/index.tsx`
- `ping/gps-only.tsx`, `ping/photo.tsx` — geofence verification modes
- `reports/new.tsx`, `reports/new/{activity,incident,maintenance}.tsx`
- `tasks/complete/[id].tsx`
- `active-shift/`, `violation/`, `lock.tsx`

Every flow the API implies has a matching screen. No orphaned endpoints.

## MAJOR

### M1. `tsconfig.json` is effectively unconfigured
**File**: `apps/mobile/tsconfig.json`
```json
{ "compilerOptions": {}, "extends": "expo/tsconfig.base" }
```
`expo/tsconfig.base` enables `strict: true` in recent SDK versions, but it's brittle — an Expo SDK upgrade can silently change strictness. And 28 `: any` leaked through regardless. Explicit is better: declare `strict: true` locally and treat drift as a build failure.

### M2. Offline queue exists but scope is unclear
**File**: `apps/mobile/lib/offlineQueue.ts` + `apps/mobile/store/offlineStore.ts`
Both files use `: any` (5 total between them). No tests. A guard standing in an elevator for 10 minutes must not lose their clock-in, their pings, or a just-submitted report. Without tests, there's no way to assert this behavior holds after any given edit. This is the mobile feature most likely to regress silently and most likely to cost you a customer — "the guard clocked in but HQ saw nothing" is a worst-case UX story.

**Fix**: smoke test — toggle airplane mode, perform clock-in + 5 pings + 1 report, toggle back, confirm all arrive in order. Add to release checklist.

### M3. No version / update gate
Nothing in the login flow checks the installed app version against a server-side `minimum_supported_version`. If a breaking API change ships, old clients silently 4xx. For a field-deployed fleet of guards who rarely open the app store page, you need a forced-update prompt.

**Fix**: add `GET /api/mobile/min-version`; mobile checks on login, blocks with "Update required" if below.

## MINOR

- **Tab icons**: not verified visually. Recent commits don't flag icon issues, but nothing in the grep confirms each tab renders a meaningful icon at the required densities.
- **`recent_changes` mentions camera gates** (Apr 15 memory) — confirmed `hooks/usePhotoAttachments.ts` uses `launchCameraAsync` exclusively. Good. Worth adding a comment locking that choice in so a future engineer doesn't "helpfully" add gallery support and break chain-of-custody.
- **`store/authStore.ts` is modified** (uncommitted per `git status`) — worth reviewing what changed before shipping.
- **`reports/new.tsx` and `reports/new/*.tsx` coexist** — might be the legacy `new.tsx` + the new per-type screens (activity/incident/maintenance). If `new.tsx` is unreachable, delete it. If it's the chooser, rename to `reports/new/index.tsx` for clarity.
- **Two MP4 demo files in repo root** (`vwing-location-demo-fast.mp4`, `vwing-location-demo.mp4`) — likely demo content. Move out of repo.

## WORKING WELL

- **Camera-only photo capture** — `launchCameraAsync`, no `launchImageLibraryAsync` anywhere. Chain-of-custody is preserved at the source. This is the single most important line of defence against a guard submitting fabricated evidence, and it's in place.
- **Multi-step clock-in wizard (step1..step4)** — breaks the flow into auditable stages. Good UX pattern for a distracted-user environment.
- **Separate `badge-login` / `sms-unlock`** — evidence of a thought-out auth recovery model, not just "password-only."
- **`change-password` screen exists** — required for the "first login forces rotation" flow.
- **7 tabs is too many but every tab has a purpose** — nothing looks like a placeholder.
- **Route structure is consistent with API routes** — no client calls to endpoints that don't exist.

## UNVERIFIED

- Actual behavior in airplane mode (no live device test).
- iOS build status (memory note 2026-04-16 "pending iOS build").
- Whether `expo-notifications` is actually wired to FCM — grep-level evidence only.
- Whether `store/authStore.ts`'s uncommitted change is safe to ship.
