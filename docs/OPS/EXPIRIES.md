# EXPIRIES

Things that lapse. An expiry that passes unnoticed is an outage with a long
lead time and no alert.

**Every date below is UNVERIFIED.** None of these can be read from the repo, the
production DB, or any CLI authenticated on this machine — they live in Apple's
developer portal, a registrar, SendGrid, Google Cloud, and Railway env vars.
**Vishnu fills the dates.** Once filled, this table is the input to a renewal
reminder.

Credential rotation is **Tier 2** (`POLICY.md`).

---

| # | Item | Where it lives | Expires / last rotated | Renewal owner | Notes |
|---|---|---|---|---|---|
| E1 | Apple Developer Program membership | developer.apple.com | **UNVERIFIED** | Vishnu | Lapse blocks all iOS builds, TestFlight, and App Store updates. Annual. |
| E2 | Domain `netraops.com` | registrar (UNVERIFIED which) | **UNVERIFIED** | Vishnu | Canonical web host is `www.netraops.com`; the one Sentry uptime monitor points at it (id 8024493). Lapse takes down web + the only uptime check. |
| E3 | SendGrid API key | Railway env `SENDGRID_API_KEY` | **UNVERIFIED** | Vishnu | Sender `alerts@em6648.netraops.com`. Powers `dailyShiftEmail`, `missedShiftAlert`, `handoffNudge` admin FYI. Previously rotated after a key appeared in a screenshot. |
| E4 | EAS / Expo account access | `~/.expo/state.json` | **UNVERIFIED** | Vishnu | Verified present 2026-09-05; account `vvishnu1998` / `vvishnu1998@gmail.com`, project `guard` (`5fd28125-2461-4165-b9df-7f34ced8b194`). Token expiry not exposed by the CLI. |
| E5 | Google service account (`google-service-account.json`) | local file + Firebase/GCP | **UNVERIFIED** | Vishnu | Dual-purpose: FCM push credential **and** `eas submit` to Play. Key rotation or project change breaks push and Android submission together. |
| E6 | `JWT_SECRET` / `VISHNU_JWT_SECRET` — last rotation | Railway env | **UNVERIFIED** | Vishnu | Super-admin auth is env-based, not a DB row — `apps/api/src/middleware/auth.ts:185`, with revocation via `vishnu_state.tokens_not_before` (`:193`). Rotation date is not recorded anywhere readable. Tracked as C7 in `OPEN-ITEMS.md`. |
| E7 | Anthropic API key | Railway env `ANTHROPIC_API_KEY` | **UNVERIFIED** | Vishnu | `@anthropic-ai/sdk` is a declared dependency of `apps/api`. Spend cap decision is D5 in `DECISIONS.md` ($100 cap / $50 alert). |
| E9 | Sentry auth token | `~/.sentryclirc` (mode 0600) | **UNVERIFIED** | Vishnu | Verified present 2026-09-05. Scoped, not full-account — `/api/0/api-tokens/` returns 403. Read access confirmed for projects, rules, monitors, uptime. Account has `has2fa: false`. |
| E10 | GitHub OAuth token | macOS keyring (`gh`) | **UNVERIFIED** | Vishnu | Scopes verified 2026-09-05: `gist, read:org, repo, workflow`. **Separate plaintext `gho_` token sits in `.claude/settings.local.json` — revoke it (N1 in `OPEN-ITEMS.md`).** |
| E11 | Railway account / CLI auth | `~/.railway/config.json` | **UNVERIFIED** | Vishnu | Verified present 2026-09-05; `vvishnu1998@gmail.com`, project `adorable-courage` / `production` / `guard`. |
| E12 | Vercel CLI auth | not at `~/.vercel/auth.json` | **UNVERIFIED** | Vishnu | `vercel whoami` → `vvishnu1998-lab`. Project `prj_9YrTvZdvDZaApW7ukrI1XaLPle8u`, org `team_3Mb2v4ni2JKmzw02tWTOakOU`. Storage location of the token not identified. |
| E13 | Database credentials — last rotation | Railway Postgres service vars | **UNVERIFIED** | Vishnu | Rotation is five explicit var writes, not one: `ALTER USER` first, then `POSTGRES_PASSWORD`, `PGPASSWORD`, `DATABASE_URL`, `DATABASE_PUBLIC_URL` on the Postgres service, then the guard service's `DATABASE_URL`. Plus local root + `apps/api` `.env`. |

---

## How to fill this in

Replace `UNVERIFIED` with an ISO date and add the date it was checked. An item
whose expiry cannot be determined should say so explicitly rather than being left
blank — a blank cell reads as "fine" and is how these lapse.
