# Phase 9 — Code quality

## Score: 4/10

Low score is driven by two things: zero automated tests and inconsistent tsconfig strictness. The code itself reads cleanly in the spots sampled, but without tests or strict types, "reads cleanly" is worth very little at the velocity a B2B SaaS needs to ship.

## Test coverage: zero

```
find apps -name "*.test.*" -o -name "*.spec.*" → (no output)
```

No Vitest, Jest, Playwright, Cypress, or Expo testing-library setups. No `test` script in `package.json` that actually runs anything. Not a single assertion about:
- Clock-in race behaviour (Phase 3 C3)
- Retention cron correctness
- Multi-tenant isolation (Phase 7)
- Offline queue replay (Phase 6 M2)

For comparison: TrackTik's public engineering posts reference >80% backend coverage. Silvertrac ships with a QA team. V-Wing ships on vibes.

## Type safety

| App | Strict | `: any` count |
|---|---|---|
| `apps/api` | `strict: true` (inherited, confirmed via lint-clean TS output) | 6 |
| `apps/web` | `strict: false` (only `strictNullChecks`) | 36 |
| `apps/mobile` | extends `expo/tsconfig.base`, no local override | 28 |

**Total**: 71 `: any` occurrences across 42 files.

Hot spots:
- `apps/web/app/admin/shifts/page.tsx` — 7 `: any`
- `apps/web/app/admin/guards/page.tsx` — 5 `: any`
- `apps/web/app/vishnu/companies/page.tsx` — 5 `: any`
- `apps/mobile/lib/offlineQueue.ts` — 1 in the one file you *really* want strictly typed

`strict: true` in web would force fixing all 36 before the build succeeds. Worth one focused day of work and a PR titled "turn on strict mode."

## Dependencies

Not exhaustively audited — spot checks:
- **Express 4** (not 5). Fine; 4.x is still supported but the ecosystem is moving. Express 5 `async` support is native and would let you drop `express-async-errors`.
- **Node 18** (per memory). 18 goes EOL in April 2025 — already past. Upgrade to Node 20 LTS.
- **Expo SDK**: version not spot-checked; recent commits don't reference an upgrade.
- **`pg`** client pool usage is direct (no ORM). Trade-off: no migrations framework visible, no type generation. Search for a migrations directory:

```
apps/api/src/db/ — check for migrations/ subdir (not verified)
```

Every schema change today is presumably a manual SQL statement against prod. Add a migrations tool (`node-pg-migrate`, `drizzle-kit`, or Prisma migrate) before you have more than one engineer on the project.

## Lint / CI

- No evidence of ESLint / Prettier enforcement in CI (no `.github/workflows/*.yml` viewed).
- `turbo.json` exists at repo root (implied by the monorepo structure) but not audited.
- Vercel and Railway build on push — that's the only gate between a bad commit and prod.

## Repo hygiene

From current `git status`:
```
M  .gitignore
M  apps/mobile/store/authStore.ts   (uncommitted, feature work)
M  apps/web/tsconfig.tsbuildinfo    (build artifact — shouldn't be tracked)
?? apps/web/.gitignore              (new, untracked)
?? "guard app/"                     (stray dir with space in name)
?? play-store-assets/               (should be in an assets branch or elsewhere)
?? vwing-location-demo-fast.mp4
?? vwing-location-demo.mp4
```

Two demo videos and a play-store-assets directory in repo root is working-tree debris. Move them.

## Commit hygiene — good

Recent commits (`git log --oneline`):
```
e2fec53 fix: prevent ghost guards on dashboard by filtering completed shifts
1d499ca fix: correct Vercel outputDirectory path
fc075fa fix: guard reactivate + mobile responsive portals
daab01d fix: handle duplicate email/badge 409 + validate required fields on POST /api/guards
a228f53 redesign: V-Wing UI — 3-tab nav, calendar, notifications, cyan theme, drawer
```

Conventional-commit-ish, scope-clear, intent-readable. This is the one area of the repo where discipline is visible — keep it up.

## What's working well

- **Parameterized SQL throughout** — no injection surface (Phase 2).
- **Module boundaries are clean** — `routes/`, `jobs/`, `services/`, `middleware/`, `db/`. Nothing is mis-located.
- **Self-documenting job / route names** — `autoCompleteShifts`, `missedShiftAlert`, `nightlyPurge`. No cleverness.
- **Turbo monorepo** — workspace setup appears coherent; one install, one build orchestrator.
- **Commit messages are disciplined** — high signal, scope-prefixed, intent-clear.

## UNVERIFIED

- Whether any migrations tool is set up (need to check `apps/api/src/db/` directory).
- Whether a `.github/workflows/` directory exists and runs typecheck on PR.
- Whether `turbo.json` defines a `test` pipeline (moot if no tests exist).
- Whether `package.json` has a `lint` script and whether it's enforced anywhere.
