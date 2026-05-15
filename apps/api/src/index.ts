import 'dotenv/config';
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

// Cron jobs
import './jobs/nightlyPurge';
import './jobs/dailyShiftEmail';
import './jobs/monthlyRetentionNotice';
import './jobs/missedShiftAlert';
import './jobs/autoCompleteShifts';
import './jobs/monthlyHoursReport';
import './jobs/chatRetention';
import './jobs/pingReminder';

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

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);               // native app / curl / health
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
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

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
});

export default app;
