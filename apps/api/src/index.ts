// Sentry init MUST run before `express` is imported so @sentry/node v8's
// auto-instrumentation can patch the Express prototype. The Sentry module
// also loads dotenv first so SENTRY_DSN resolves.
import { Sentry } from './services/sentry';
import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { pool } from './db/pool';

// Route imports
import authRoutes from './routes/auth';
import shiftsRoutes from './routes/shifts';
import reportsRoutes from './routes/reports';
import locationsRoutes from './routes/locations';
import tasksRoutes from './routes/tasks';
import sitesRoutes from './routes/sites';
import guardsRoutes from './routes/guards';
import clientsRoutes from './routes/clients';
import adminRoutes from './routes/admin';
import exportRoutes from './routes/exports';
import uploadRoutes from './routes/uploads';
import clientPortalRoutes from './routes/clientPortal';
import aiRoutes from './routes/ai';
import billingRoutes from './routes/billing';
import chatRoutes from './routes/chat';
import notificationsRoutes from './routes/notifications';
import activityLogRoutes from './routes/activityLog';
import geocodeRoutes from './routes/geocode';
import schedulingRoutes from './routes/scheduling';
import checkpointsRoutes from './routes/checkpoints';
import locationIntegrityRoutes from './routes/locationIntegrity';
import offlineDeadLetterRoutes from './routes/offlineDeadLetter';
import vehiclesRoutes from './routes/vehicles';
import inspectionsRoutes from './routes/inspections';

// Cron jobs
import './jobs/nightlyPurge';
import './jobs/dailyShiftEmail';
import './jobs/missedShiftAlert';
import './jobs/autoCompleteShifts';
import './jobs/monthlyHoursReport';
import './jobs/chatRetention';
import './jobs/pingReminder';
import './jobs/preShiftReminder';
import './jobs/shiftStartReminder';
import './jobs/expireSwapRequests';
import './jobs/handoffNudge';
import './jobs/lateClockInReminder';
import './jobs/missedPingCron';
import './jobs/missedReportCron';
import './jobs/taskDueCron';
import './jobs/breakExpiryCron';
import './jobs/locationIntegrityCron';
import './jobs/orphanedSessionCheck';
import './jobs/clockOutReminder';
// Job registration is an import side-effect, so this must run after the block
// above or it reports 0. See jobs/_run.ts for why the wrapper exists.
import { logJobRegistration, registeredJobs, computeStaleJobs } from './jobs/_run';
import type { HeartbeatRow } from './jobs/_run';

logJobRegistration();

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

// Rate limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // tighter limit for auth endpoints
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
});

// Fail-closed CORS (CB4, audit/WEEK1.md C3).
// - ALLOWED_ORIGINS is required; the server refuses to start without it so
//   we never fall back to the old "origin: true" wildcard-with-credentials
//   behaviour (which browsers will reject anyway but still a foot-gun).
// - Non-browser requests (React Native, curl, health probes) arrive with
//   no Origin header; those are allowed through — CORS isn't relevant to
//   them and we still have auth enforcement below.
if (!process.env.ALLOWED_ORIGINS) {
  throw new Error(
    'ALLOWED_ORIGINS is required. Set a comma-separated list of exact origins (no wildcards).'
  );
}
const allowedOrigins = process.env.ALLOWED_ORIGINS
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// Pattern allowance for our Vercel project's auto-generated origins. Static
// ALLOWED_ORIGINS handles canonical hosts (app.netraops.com etc.); this
// regex covers the two auto-generated shapes Vercel ships for our project:
//   https://guard-vvishnu1998-labs-projects.vercel.app                   (production-deploy team alias)
//   https://guard-git-{branch}-vvishnu1998-labs-projects.vercel.app      (any branch preview)
// Both the project name (`guard`) and team slug (`vvishnu1998-labs-projects`)
// are pinned, so unrelated *.vercel.app sites can't slip through and the
// allowance can't be abused by a phishing site hosted on Vercel. Per-deploy
// hash URLs are intentionally NOT matched — admins don't browse those directly.
const VERCEL_PREVIEW_PATTERN = /^https:\/\/guard(?:-git-[a-z0-9-]+)?-vvishnu1998-labs-projects\.vercel\.app$/;

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);               // native app / curl / health
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (VERCEL_PREVIEW_PATTERN.test(origin)) return cb(null, true);
    return cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  // Content-Disposition is NOT a CORS-safelisted response header, so without
  // this the browser cannot read it and the download filename the server
  // chose is invisible to apps/web. A blob: URL carries no filename of its
  // own, so the anchor would fall back to the blob UUID. The billing page
  // parses this header to name the file; everything else about the response
  // is unchanged.
  exposedHeaders: ['Content-Disposition'],
}));
app.use(globalLimiter);
app.use(express.json());

// Health check
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

// Dead-cron probe. GET /health is not a substitute: it runs SELECT 1 and
// nothing else, so a wedged job leaves it returning {"status":"ok"}. This
// route is the thing an external uptime monitor should watch.
//
// A job that HAS a heartbeat row is STALE when the row is older than TWICE its
// own interval. 2x absorbs one skipped tick without alarming; beyond that is a
// real gap.
//
// A job that has NEVER ticked is stale only once it has been REGISTERED for
// longer than that same 2x window (Phase 4.1). Before that, "no row" means
// "not due yet" -- the normal state of a daily job seconds after a deploy.
// Without the grace, this route returned 503 from deploy until all 19 jobs had
// fired, which from a fresh database is up to a month.
//
// ACCEPTED v1 LIMIT -- detection lag scales with the interval, under both
// halves of the rule. The */5 and per-minute jobs are flagged within 10 and 2
// minutes. The daily jobs (dailyShiftEmail, locationIntegrityCron,
// nightlyPurge) take up to 48 HOURS, and monthlyHoursReport about 62 DAYS. A
// better scheme would compare against the next expected fire time rather than
// a multiple of the interval; that needs a real cron parser and is out of
// scope for v1.
//
// Job names and timings only. No guard, site or tenant data passes through
// here, per the data rule in docs/OPS/POLICY.md.
app.get('/health/crons', async (_req, res) => {
  const jobs = registeredJobs();
  try {
    const { rows } = await pool.query<HeartbeatRow>(
      `SELECT job_name,
              EXTRACT(EPOCH FROM (NOW() - last_tick_at))::int AS age_s,
              last_result
         FROM cron_heartbeats`,
    );
    const stale = computeStaleJobs(jobs, rows);
    if (stale.length > 0) {
      return res.status(503).json({ status: 'stale', jobs: jobs.length, stale });
    }
    return res.json({ status: 'ok', jobs: jobs.length, stale: [] });
  } catch {
    return res.status(503).json({ status: 'error' });
  }
});

// Routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/shifts', shiftsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/locations', locationsRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/sites', sitesRoutes);
app.use('/api/guards', guardsRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/exports', exportRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/client', clientPortalRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/activity-log', activityLogRoutes);
app.use('/api/geocode', geocodeRoutes);
app.use('/api/scheduling', schedulingRoutes);
app.use('/api/checkpoints', checkpointsRoutes);
app.use('/api/location-integrity', locationIntegrityRoutes);
app.use('/api/offline', offlineDeadLetterRoutes);
app.use('/api/vehicles', vehiclesRoutes);
app.use('/api/inspections', inspectionsRoutes);

// Sentry error handler — MUST come after all routes and BEFORE any other
// error-handling middleware. It captures the error then calls next(err),
// so the existing express-async-errors / default 500 response chain is
// unaffected — clients still get the same response shape.
Sentry.setupExpressErrorHandler(app);

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
});

export default app;
