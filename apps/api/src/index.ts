import 'dotenv/config';
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

// Cron jobs
import './jobs/nightlyPurge';
import './jobs/dailyShiftEmail';
import './jobs/monthlyRetentionNotice';

const app = express();
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

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : true,
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

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
});

export default app;
