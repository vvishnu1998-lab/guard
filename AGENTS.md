# NetraOps (V-Wing) — Guard Management SaaS

## Project
Multi-tenant SaaS for security guard management. Three parties: super admin (Vishnu), security companies (admins), end clients (read-only).

## Stack
- Mobile: React Native / Expo (account: vvishnu1998, project ID: 5fd28125-2461-4165-b9df-7f34ced8b194)
- Web portals: Next.js, deployed on Vercel → app.netraops.com
- API: Node/Express on Railway → guard-production-6be4.up.railway.app (project: adorable-courage)
- DB: PostgreSQL on Railway (22 tables, multi-tenant by company_id)
- Storage: AWS S3 bucket `starguard-media` (us-east-2)
- Push: Firebase/FCM (Sender ID: 872564523776)
- Email: SendGrid (sender: alerts@netraops.com, domain verified)
- Maps: Google Maps
- Domain: netraops.com (purchased May 2026)

## Repo layout
- `apps/api` — Express API
- `apps/web` — Next.js web portals (admin + client)
- `apps/mobile` — Expo guard app

## Branding
NetraOps. Navy `#0B1526` + cyan `#00C8FF`. Logos and bundle IDs already updated from V-Wing/StarGuard.

## Rules — non-negotiable
- Never commit secrets. All `.env*` files are gitignored. A `gitleaks` pre-commit hook is active.
- Every DB query must scope by `company_id`. Multi-tenant isolation is a security requirement.
- S3 uploads: server-side **byte-level (magic-byte) validation** required in addition to MIME. PE/EXE bytes must be rejected even if Content-Type says `image/jpeg`.
- Photo/report writes must respect retention: 90 days full → 60 days Vishnu-only → permanent delete at day 150. Ping photos: 7-day rolling delete.
- Photos: max 5 per report, 800 KB compression, no video.
- **Photo uploads must route through `ImageManipulator.manipulateAsync`.** The
  Expo manipulator's native pipeline (iOS `UIImage.jpegData`, Android
  `Bitmap.compress`) strips EXIF — including GPS — as a side effect of
  decoding to a bitmap and re-encoding. Bypassing the manipulator (e.g.
  uploading raw `takePictureAsync` output, or piping a library-picked file
  straight to S3) would silently leak GPS metadata to the bucket. The 5
  current upload paths have an inline comment marking the contract; any new
  photo-upload code path inherits the same rule.
- Run `npm run lint` and `npm test` in the affected package before declaring a task done.
- Never push to `main` directly. Branch + PR.

## Business logic
- Per-site monthly billing: ~$149/site → $69/site at 25+ sites.
- Location pings every 30 min, alternating: GPS+photo on the hour, GPS-only on the half hour.
- Incident emails: instant to clients. Shift report emails: daily 9 AM next morning.
- BIPA compliance: deferred pending target-state decision.

## Current focus — Week 1 fix phases
- Phase A: JWT secret cleanup + gitleaks hook (DONE)
- Phase B: forensic investigations on 4 incident reports with zero photos (IN PROGRESS)
- Phase C: CB1–CB6 code fixes (IN PROGRESS — CB1 race condition on clock-in, NULL total_hours on auto-completed shifts, etc.)
- Phase D: S3 presigned POST hardening + post-upload byte validation (PENDING — V6 attack confirmed live vuln)
- Phase E: full re-verification (PENDING)
- CB11 outstanding: confirm JWT secrets removed from Vercel env vars.

## Out of scope this week
Twilio SMS OTP, Stripe billing, 2FA, full automated test suite, BIPA remediation.

## Working agreements
- Show the plan before editing code on Phase C/D tasks.
- Group test failures by package when reporting.
- After any fix: run lint + tests in that package, then summarize the diff.