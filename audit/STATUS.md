# V-Wing — Brutally Honest Status

**Date**: 2026-04-25
**Author**: Claude (audit synthesis from REPORT.md, REGRESSION-DIAGNOSIS.md, BUILD-2026-04-24.md, WEEK1.md)
**Note**: There is no `audit/SESSION-HANDOFF.md` in the repo. This was synthesized from the existing audit set.

---

## 1. What works in production today

**Admin web portal** (`guard-web-one.vercel.app/admin`)
- Login (no 2FA).
- Create company, sites, guards, schedules.
- View reports, photos, shift history.
- Dashboard with active shifts (no longer shows ghost guards).
- Retention setup at site creation (partial — see §2).

**Client web portal** (`/client`)
- Login with site-scoped JWT.
- View reports for their site.
- Download report PDFs (now via 60-second handoff token, no JWT in URL).

**Super admin portal** (`/vishnu`)
- Cross-tenant view of all companies, sites, guards.

**Guard mobile (Android, `com.vishnu.guardapp` versionCode 10)**
- Login + forced password change on first login.
- Shift list, open shift display.
- Photo-verified clock-in (selfie + ID badge, camera-only, no gallery picker).
- GPS clock-in with geofence ray-casting.
- Incident & activity reports with up to 5 photos.
- AI-enhanced report descriptions (Anthropic Sonnet 4.5).
- Photo upload to S3 (multipart POST, size capped at 5 MiB, magic-byte validated server-side).
- Defensive guard against API/mobile protocol skew (after the 2026-04-24 fire).

**API** (`guard-production-6be4.up.railway.app`)
- JWT auth with `jti`-based access-token revocation.
- Fail-closed CORS (throws on boot if `ALLOWED_ORIGINS` unset).
- Atomic clock-in / clock-out + partial unique index blocking double sessions at the DB layer.
- `total_hours` computed on auto-complete.
- Server-enforced incident-photo-required rule.
- Retention crons: 60d / 89d / 90d / 140d / 150d touchpoints, transactional hard-delete.
- Missed-shift alerts (fixed Apr 15 — now actually fires).
- Daily report email at 9 AM, monthly retention notice last day of month.

**iOS (apps/mobile via Expo)**
- Source compiles. **Not validated end-to-end on a real device or TestFlight** — the last simulator build was cancelled and never re-triggered.

---

## 2. What doesn't work

- **iOS not validated end-to-end.** No TestFlight build, no on-device smoke. If someone signs and they have iPhones, you cannot deliver today.
- **No public marketing site.** `vwing.tld` does not exist as a sales surface. There is no signup, no pricing page, no ToS, no privacy-only-page-for-marketing. The only public page is the privacy policy stub.
- **No billing.** No Stripe, no invoice generator, no payment surface. Money is collected manually or not at all.
- **No 2FA anywhere.** Admin and super-admin login is password-only.
- **No push notifications proven.** FCM tokens are stored but no path in the codebase actually sends one. Missed-shift alerts go via email only.
- **`POST /api/sites` does not seed `data_retention_log`.** Site `60cea6fb` already has both retention columns NULL — that site will never be auto-purged. New sites created through the same code path inherit the bug.
- **No global Express error handler.** Raw Postgres `err.message` strings (constraint names, column names) leak in 500 responses.
- **No automated test suite.** Zero `*.test.*` / `*.spec.*` files. The "tests" are 11 hand-rolled regression scripts under `apps/api/scripts/test-*.ts` that no CI runs automatically.
- **No error monitoring.** No Sentry, no Datadog, no Logtail. The way you find out about a crash is a customer email.
- **No mobile forced-update gate.** A breaking API change silently 4xx's every old client. (You just lived through this on 2026-04-24 — except in reverse.)
- **No license / certification tracking** for guards (regulated requirement in most US states + Canada).
- **No i18n.** English only.
- **OTP guard-unlock is brute-forceable.** 6-digit OTP, no per-account lockout.
- **Forgot-password is not rate-limited per target.** Email-bomb a known guard email = SendGrid quota burn.
- **No audit log for business events.** `auth_events` covers logins only. Who deleted that report? You can't tell.
- **Crons run in-process with no distributed lock.** If Railway ever scales to >1 worker, retention emails double-send and hard-deletes double-fire.

---

## 3. What's risky

- **Google Maps API key `AIzaSyBCB…7jiA` is burned.** Committed in git history (`61bca7f1`, `d193e046`), still in HEAD of `apps/mobile/app.json`, `.env.example`, the Xcode project, the Android manifest — and therefore inside every shipped APK. No bundle-ID / referrer restrictions on the Google Cloud side. Billing-drain and embed-spoofing risk is silent and continuous until it's rotated.
- **BIPA selfie collection.** Every clock-in stores `selfie_url` in `clock_in_verifications`. No consent table, no notice, no deletion endpoint. One Illinois plaintiff's firm + one Illinois guard = $1,000–$5,000 statutory per violation. Held by founder directive.
- **S3 bucket `guard-media-prod` may have been abused before the 2026-04-23 hardening.** The presign endpoint accepted any bytes + unbounded size for ~6 weeks. Nobody has audited the bucket for leftover non-image objects.
- **Retention cron branches have never fired against real data.** Unit tests pass; the 60-day, 89-day, and 90-day code paths have zero triggering rows in prod. First real site hits day 90 on **2026-09-28**. If a branch is broken you find out the day a customer complains.
- **The 2026-04-24 mobile/API skew incident.** It got fixed but the *prevention* is one CI contract test. No git pre-push hook prevents committing a mobile change without the corresponding API change being deployed first.
- **Missed-shift alert** — verified once on 2026-04-15. The cron runs every 5 min; nobody has watched it for a full week to confirm it doesn't false-positive or skip.
- **SendGrid key on Railway** — last known state (Apr 15) was unverified whether the value in Railway is a real `SG.xxx` or the placeholder. If it's the placeholder, none of the email features work in prod and nobody would know.
- **Maps key inside the binary** — even after rotation, the new key gets shipped in the APK. Without bundle-ID and SHA-1 restrictions in Google Cloud Console, any kid who unzips the APK has it again.
- **Crons run in-process** — works on single-worker Railway today. The day you scale up, retention emails go out twice and hard-delete is racy.
- **Anthropic model pin.** Now env-var driven (`ANTHROPIC_MODEL`), but no calendar reminder is set for the published retirement date of `claude-sonnet-4-5-20250929`. Same fire, different ignition.
- **Password rules are length-only.** Admin can set `Aaaa@1234` and the system says yes. No HIBP check, no zxcvbn.
- **No Sentry** means a guard could be hitting a 500 every clock-in for a week and you'd only learn when the company admin called.

---

## 4. What only the founder can do

- **Rotate the burned Google Maps API key.** Requires Google Cloud Console access on the billing account. Add bundle-ID + SHA-1 + referrer + API restrictions on the new key. Then check the billing dashboard for any abuse spike since 2026-04-07 — you may already owe Google.
- **Decide the BIPA stance.** Either (a) refuse to sell to anyone with guards in IL / TX / WA / NY, write that into the contract, and move on, or (b) commit to the ~3 eng-day consent + deletion surface. Cannot delegate this — it's a legal-exposure decision.
- **Apple Developer Program.** Enroll, get the team approved, generate the iOS provisioning profile. Until this happens iOS does not exist as a product. Nobody else can sign DocuSign on your behalf.
- **Pricing decision.** $149 self-serve vs $400–600/site high-touch is a business call. The audit recommended high-touch given the productization gaps; you have to actually choose and stop revisiting it weekly.
- **Pick the design partner.** One company, real guards, real shifts. Probably someone you already know. This is a sales / relationships call — no engineer can make it.
- **Verify Railway env vars.** Log into Railway dashboard, confirm `SENDGRID_API_KEY` is a real key, not `SG.xxx`. Same check for `ANTHROPIC_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `JWT_SECRET`, `ALLOWED_ORIGINS`. Anyone else looking at it is a security violation.
- **Upload `vwing-location-demo-fast.mp4` to YouTube** and paste the URL into Play Console → App Content → Location Permissions. Required for Google Play approval. Cannot be done by an engineer without your Google account.
- **Get the Play Store listing past Google's background-location review.** Your account, your responses, your timeline.

---

## 5. Shortest path to one real paying customer

1. **Rotate the Maps key today.** It's 30 minutes. Push to main, Railway redeploys, the next APK build picks up the new key. Add bundle-ID restriction on Google Cloud Console while you're there. This blocks nothing else but one Google bill from being a surprise.
2. **Pick one design partner this week.** A small security company you already know — 5 to 20 guards, English-speaking, ideally not in IL/TX/WA/NY (avoids BIPA blocker). Sell it as "managed deployment, $400–600/site/month, I onboard your team personally."
3. **Hand-deliver the Android APK** (`com.vishnu.guardapp` v10 is good enough) and run the first week of shifts with you on the phone. The product is fine for one customer with hand-holding. It is not fine for ten via self-serve.
4. **Manual invoice via email.** A PDF, a Stripe payment link generated one-off, or an ACH wire. Whatever the customer prefers. Stripe Billing is a 5-day distraction you do not need yet.
5. **Fix bugs as the design partner finds them.** That's the entire roadmap until they pay the second invoice. Their bug list is more valuable than any planning document.

---

## 6. What NOT to do before that first paying customer

- **Don't build Stripe Checkout / billing.** The first customer pays you by invoice. The second one too. Build it on the way to customer five.
- **Don't add 2FA.** It's a real gap, but the design partner doesn't care and won't ask. Closing it now buys you nothing this quarter.
- **Don't write a Vitest test harness.** The 11 hand-rolled regression scripts are working. Adding a framework is two days of yak-shaving for zero customer value.
- **Don't tackle BIPA.** Sell to a non-IL/TX/WA/NY partner first. BIPA is ~3 eng-days you don't owe yet.
- **Don't ship iOS** unless the design partner specifically asks. Android-only is fine for one customer.
- **Don't build the public marketing site.** No pricing page, no ToS auto-generator, no feature grid. You are not running self-serve. You are running a 1-customer pilot.
- **Don't add Sentry, Datadog, or any observability tooling.** `tail -f` Railway logs is enough for one customer.
- **Don't worry about SOC 2, GDPR DPAs, or any compliance artifacts.** None of these is a blocker for the first contract. They become blockers around customer five.
- **Don't add i18n, license tracking, or shift-swap UX.** Differentiator features are for after the first invoice clears, not before.
- **Don't refactor anything.** Including the things the audit flagged as "MAJOR." Major ≠ blocking.
- **Don't write more audit documents.** You have nine of them. Read them when something breaks; otherwise close the laptop and call your first design partner.
