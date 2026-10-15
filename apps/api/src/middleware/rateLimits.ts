/**
 * The API's two rate limits, per IP. Moved here from index.ts for N202,
 * unchanged but for authLimiter's skip, so a harness can mount the real ones.
 */
import rateLimit from 'express-rate-limit';

export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * /api/auth: sign-ins, password changes and resets, 20 per 15 minutes.
 *
 * N202 (Vishnu's decision 3a, 2026-10-14): a sign-out is not counted. POST
 * /api/auth/logout needs a live session, so it cannot be used to guess a
 * password, and a sign-out refused here would leave that session alive. The
 * global limit above still applies to it.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // tighter limit for auth endpoints
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
  skip: (req) => req.method === 'POST' && req.path === '/logout',
});
