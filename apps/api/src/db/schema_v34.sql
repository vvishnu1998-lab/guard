-- Schema v34 — Retention rebuild, CONTRACT phase
--
-- Drops the data_retention_log table and the sites.client_access_
-- disabled_at column is INTENTIONALLY PRESERVED — the retention
-- rebuild repurposed it as the client-portal login gate
-- (see routes/auth.ts). Do not drop it here.
--
-- Ships in Commit B after every reader of data_retention_log has been
-- removed (routes/sites.ts, routes/admin.ts, routes/auth.ts,
-- services/email.ts, jobs/monthlyRetentionNotice.ts, jobs/nightlyPurge.ts,
-- and apps/web/app/vishnu/retention/page.tsx are all cleaned in the
-- same commit). If any reader survives, this DROP will 500 the API on
-- deploy — inspect grep before applying.
--
-- Zero real data. The 6 test rows in the table are discarded here.

DROP TABLE IF EXISTS data_retention_log CASCADE;
