# Guard — Production Deployment Checklist

## 1. Environment Variables

### API (`apps/api/.env`)
- [ ] `DATABASE_URL` — Railway PostgreSQL connection string
- [ ] `JWT_SECRET` — minimum 64-character random string
- [ ] `JWT_REFRESH_SECRET` — separate 64-character random string
- [ ] `VISHNU_JWT_SECRET` — for Vishnu super-admin portal
- [ ] `CLIENT_JWT_SECRET` — for client read-only portal
- [ ] `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `AWS_REGION` + `S3_BUCKET`
- [ ] `SENDGRID_API_KEY` — live key from SendGrid dashboard
- [ ] `SENDGRID_FROM_EMAIL` — verified sender email
- [ ] `VISHNU_EMAIL` — Vishnu's email for 140-day warnings
- [ ] `ALLOWED_ORIGINS` — comma-separated: `https://app.guard.com,https://client.guard.com,https://vishnu.guard.com`
- [ ] `PORT` — 3001 (Railway sets this automatically)

### Web (`apps/web/.env.local`)
- [ ] `NEXT_PUBLIC_API_URL` — production API base URL
- [ ] `JWT_SECRET` — same value as API (used in Edge Middleware for cookie verification)

### Mobile (`apps/mobile`)
- [ ] `EXPO_PUBLIC_API_URL` — set in `eas.json` per build profile (already done)

---

## 2. Database

- [ ] Run all migrations on Railway production database
- [ ] Verify 19-table schema is applied: `psql $DATABASE_URL -c "\dt"`
- [ ] Create Vishnu super-admin account manually via SQL:
  ```sql
  INSERT INTO vishnu_admins (email, password_hash) VALUES ('vishnu@guard.com', '<bcrypt_hash>');
  ```
- [ ] Confirm `pg_cron` extension is available for Railway (or rely on node-cron in the API process)
- [ ] Enable connection pooling via PgBouncer if expected > 100 concurrent connections

---

## 3. API Server (Railway)

- [ ] Deploy `apps/api` as a Railway service
- [ ] Set all environment variables in Railway dashboard
- [ ] Confirm `/health` endpoint returns `{ status: "ok", db: "connected" }`
- [ ] Verify rate limiting is active: hit `/api/auth/guard/login` 21× and confirm 429
- [ ] Confirm CORS allows web domain: check `Access-Control-Allow-Origin` header
- [ ] Cron jobs start on process boot — check Railway logs for:
  - `[nightlyPurge] scheduled`
  - `[dailyShiftEmail] scheduled`
  - `[monthlyRetentionNotice] scheduled`

---

## 4. Web App (Vercel)

- [ ] Deploy `apps/web` to Vercel
- [ ] Set `NEXT_PUBLIC_API_URL` + `JWT_SECRET` environment variables in Vercel dashboard
- [ ] Confirm three portals load without errors:
  - Admin: `/admin/login`
  - Client: `/client/login`
  - Vishnu: `/vishnu/login`
- [ ] Verify Edge Middleware redirects unauthenticated requests correctly
- [ ] Test PDF download from client portal (token in query param)

---

## 5. S3 / File Storage

- [ ] Create S3 bucket (`guard-media-prod`) in the correct region
- [ ] Set bucket policy to block public access
- [ ] Confirm presigned PUT URLs work from mobile (clock-in photo upload)
- [ ] Confirm presigned GET URLs work for admin report photo display
- [ ] Set lifecycle rule: delete objects with prefix `pings/` after 10 days as a safety net

---

## 6. SendGrid

- [ ] Verify sender domain in SendGrid
- [ ] Send a test daily shift report email via `/api/admin` endpoint or cron trigger
- [ ] Confirm incident alert email reaches client within 60 seconds
- [ ] Test retention notice email (day 60) renders correctly in Gmail/Outlook

---

## 7. Mobile App — iOS (Pending — Apple Developer approval in progress)

- [ ] Once Apple Developer account is approved, fill in `eas.json` submit > production > ios:
  ```json
  "ios": {
    "appleId": "your@email.com",
    "ascAppId": "NUMERIC_APP_ID_FROM_APP_STORE_CONNECT",
    "appleTeamId": "XXXXXXXXXX"
  }
  ```
- [ ] Confirm app icon (1024×1024 PNG, no transparency) at `assets/icon.png`
- [ ] Confirm splash screen at `assets/splash.png`
- [ ] Run `eas build --platform ios --profile production`
- [ ] Test on real device via TestFlight before production submission
- [ ] Submit: `eas submit --platform ios --profile production`

---

## 8. Mobile App — Android

### One-time Google Play Console Setup
- [ ] Create app in Google Play Console → **All Apps → Create app**
  - App name: `Guard`
  - Default language: English
  - App / Game: App
  - Free / Paid: select as appropriate
- [ ] Complete Store Listing:
  - Short description (80 chars max)
  - Full description (4000 chars max)
  - Upload screenshots: phone (min 2), 7-inch tablet optional
  - Feature graphic: 1024×500 PNG
  - App icon: 512×512 PNG
- [ ] Complete Content Rating questionnaire (Dashboard → Policy → App content)
- [ ] Set Target Audience & Content (Dashboard → Policy → App content)
- [ ] Create **Internal Testing** track first to validate the pipeline

### Google Service Account (for `eas submit`)
- [ ] Go to Google Play Console → **Setup → API access**
- [ ] Link to a Google Cloud project (create one if needed)
- [ ] Click **Create new service account** → follow the Google Cloud Console link
  - Role: **Service Account User** (Play Console will grant Play permissions)
- [ ] In Google Cloud Console: create a JSON key for the service account → download it
- [ ] Rename the downloaded file to `google-service-account.json`
- [ ] Place it at `apps/mobile/google-service-account.json`
- [ ] Add `google-service-account.json` to `.gitignore` — **never commit this file**
- [ ] Back in Play Console → Grant access to the service account:
  - Permission level: **Release manager** (minimum required for uploads)

### Build & Submit
- [ ] Run from `apps/mobile`:
  ```bash
  eas build --platform android --profile production
  ```
- [ ] Wait for EAS build to complete — download the `.aab` to verify if needed
- [ ] Test the AAB on a real device (via Firebase App Distribution or direct install)
- [ ] Verify: background location tracking, camera, biometric unlock, geofence alerts
- [ ] Submit to Internal Testing track first:
  ```bash
  eas submit --platform android --profile production
  ```
  *(`eas.json` is set to `"track": "internal"` and `"releaseStatus": "draft"` — safe for first run)*
- [ ] Once internal testing passes, promote to **Production** track in Play Console:
  - Play Console → Testing → Internal testing → Promote release → Production
  - Set rollout percentage (start at 10–20% for a staged rollout)
- [ ] After promoting, update `eas.json` track to `"production"` for future submissions

---

## 9. End-to-End Smoke Tests (post-deploy)

### Guard Mobile Flow
- [ ] Register guard → login → clock in with photo + geofence check
- [ ] Submit a report with photo upload
- [ ] Complete a task with proof photo
- [ ] Clock out → verify shift session recorded in DB
- [ ] Background location pings recorded every 5 min during shift

### Admin Portal Flow
- [ ] Login → create site with geofence polygon
- [ ] Assign guard to site
- [ ] Schedule a shift
- [ ] View live map (auto-refresh, guard pins visible)
- [ ] View reports feed with filters
- [ ] Download analytics CSV and XLSX
- [ ] Create client portal account for a site

### Client Portal Flow
- [ ] Login with client credentials
- [ ] View reports scoped to own site only (confirm cannot see other sites)
- [ ] See guards on duty list
- [ ] Download daily PDF report
- [ ] Confirm retention notice appears when `days_until_deletion <= 30`

### Vishnu Super Admin Flow
- [ ] Login → view KPI dashboard
- [ ] Create a new company + admin
- [ ] Set photo limit override for a site
- [ ] View retention table → confirm urgent rows highlighted

---

## 10. Security Sign-Off

- [ ] All JWT secrets are unique and ≥ 64 chars
- [ ] No `.env` files committed to git (`git log --all -- '*.env'` returns empty)
- [ ] SQL injection fix in `exports.ts` confirmed (parameterized queries only)
- [ ] Rate limiting active on `/api/auth` (20 req / 15 min) and global (500 req / 15 min)
- [ ] `retain_as_evidence = true` pings are NOT deleted by nightly purge
- [ ] Client JWT is site-scoped (cannot access another site's data)
- [ ] Admin JWT is company-scoped (cannot access another company's data)
- [ ] S3 bucket is private (no public-read ACL)

---

## 11. Monitoring & Alerts

- [ ] Set up Railway deployment notifications (Slack or email)
- [ ] Add UptimeRobot or similar to monitor `/health` every 5 min
- [ ] Configure Railway log retention ≥ 30 days
- [ ] Set SendGrid bounce/spam alerts to go to `vishnu@guard.com`

---

## Post-Launch (Day 1)

- [ ] Confirm first nightly purge ran at 00:00 UTC and logged output
- [ ] Confirm 9AM daily report email was sent and received
- [ ] Monitor Railway memory/CPU for the first 48 hours
- [ ] Review Railway DB connection count — scale if approaching limit
