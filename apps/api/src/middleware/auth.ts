import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool';
import { tagRequest } from '../services/sentry';

export type UserRole = 'guard' | 'company_admin' | 'client' | 'vishnu';

export interface AuthPayload {
  sub: string;
  role: UserRole;
  company_id?: string;
  site_id?: string;    // client portal only
  is_primary?: boolean; // company_admin only
  jti?: string;        // refresh tokens only
  /**
   * Session B — 'preview' identifies an admin-generated preview token
   * (POST /api/admin/sites/:siteId/preview-client-token). Middleware
   * treats these tokens as read-only client tokens: they bypass the
   * clients table lookup (sub is the string 'admin-preview', not a
   * real UUID) but any non-GET method is rejected.
   */
  scope?: 'preview';
  iat: number;
  exp: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

/**
 * Access-token signing/verifying secret keyed by role.
 *
 * `vishnu` (super-admin) uses `VISHNU_JWT_SECRET` — a separation-of-privilege
 * hedge so a compromise of `JWT_SECRET` alone cannot mint a super-admin
 * token. Every other role uses `JWT_SECRET`. Refresh tokens are unaffected
 * (still `JWT_REFRESH_SECRET` for every role).
 */
export function secretForRole(role: string | undefined): string | undefined {
  if (role === 'vishnu') return process.env.VISHNU_JWT_SECRET;
  return process.env.JWT_SECRET;
}

export function requireAuth(...roles: UserRole[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization token' });
    }

    const token = header.slice(7);

    // Decode without verification to peek at the role, so we can pick the
    // matching secret. This is safe: a forged role only changes which key
    // we verify against — signature verification below still gates trust.
    const unsafe = jwt.decode(token) as (AuthPayload | null);
    const secret = secretForRole(unsafe?.role);
    if (!secret) {
      // VISHNU_JWT_SECRET absent at runtime — fail-closed.
      return res.status(503).json({ error: 'Auth misconfigured' });
    }

    let payload: AuthPayload;
    try {
      payload = jwt.verify(token, secret) as AuthPayload;
    } catch (err) {
      const msg = err instanceof jwt.TokenExpiredError ? 'Token expired' : 'Invalid token';
      return res.status(401).json({ error: msg });
    }

    if (roles.length && !roles.includes(payload.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    // CB6 — access-token revocation blocklist (audit/WEEK1.md §C5).
    // Both /logout and /auth/refresh insert the presented jti into
    // revoked_tokens; the row has TTL = token.exp so the table stays
    // small.  On failure to reach the DB we deliberately fail-closed.
    if (payload.jti) {
      try {
        const revoked = await pool.query(
          'SELECT 1 FROM revoked_tokens WHERE jti = $1 LIMIT 1',
          [payload.jti]
        );
        if (revoked.rows.length > 0) {
          return res.status(401).json({ error: 'Token has been revoked' });
        }
      } catch {
        return res.status(503).json({ error: 'Auth verification unavailable' });
      }
    }

    // Guard-specific: check account is still active, and that this token
    // wasn't nuked by an admin via /api/auth/admin/revoke-guard/:id.
    if (payload.role === 'guard') {
      const guardResult = await pool.query(
        'SELECT is_active, tokens_not_before FROM guards WHERE id = $1',
        [payload.sub]
      ).catch(() => ({ rows: [] as { is_active: boolean; tokens_not_before: Date | null }[] }));

      const guardRow = guardResult.rows[0];
      if (!guardRow?.is_active) {
        return res.status(403).json({ error: 'Account deactivated' });
      }

      // Per-guard session nuke: any access token minted before the
      // revocation stamp is rejected. `iat` is seconds since epoch
      // (jsonwebtoken uses Math.floor(Date.now()/1000)); tokens_not_before
      // is TIMESTAMPTZ with ms precision. Comparing them naively with
      // strict < fails deterministically when both are set in the same
      // second (login writes NOW() then immediately signs a JWT whose
      // iat truncates to the start of that second, so iat*1000 <
      // notBeforeMs is always true for the sub-second fraction). The
      // +1s / <= form gives a one-second grace that fixes the precision
      // mismatch without weakening the revocation model: any explicit
      // admin revocation strictly after the token was minted is still
      // in the future by ≥1s and rejected.
      if (guardRow.tokens_not_before) {
        const notBeforeMs = new Date(guardRow.tokens_not_before).getTime();
        if ((payload.iat + 1) * 1000 <= notBeforeMs) {
          return res.status(401).json({ error: 'Session revoked by administrator' });
        }
      }
    }

    // Client-specific: mirror the guard pattern so admin's DISABLE PORTAL /
    // site deactivation / nightly retention purge can revoke live client
    // sessions (Session B / Option A). Admin-generated preview tokens
    // (scope='preview') skip the clients table lookup (no real row) but are
    // hard-restricted to GET.
    if (payload.role === 'client') {
      if (payload.scope === 'preview') {
        if (req.method !== 'GET') {
          return res.status(403).json({ error: 'Preview tokens are read-only' });
        }
      } else {
        const clientResult = await pool.query(
          'SELECT is_active, tokens_not_before FROM clients WHERE id = $1',
          [payload.sub]
        ).catch(() => ({ rows: [] as { is_active: boolean; tokens_not_before: Date | null }[] }));

        const clientRow = clientResult.rows[0];
        if (!clientRow?.is_active) {
          return res.status(403).json({ error: 'Account deactivated' });
        }
        if (clientRow.tokens_not_before) {
          const notBeforeMs = new Date(clientRow.tokens_not_before).getTime();
          // See guard branch above for the +1s / <= rationale (iat is
          // second-precision, tokens_not_before is ms-precision).
          if ((payload.iat + 1) * 1000 <= notBeforeMs) {
            return res.status(401).json({ error: 'Session revoked by administrator' });
          }
        }
      }
    }

    // Company-admin session revocation (Finding #1). Mirrors the guard/
    // client branches: is_active gate + tokens_not_before nbf check.
    // Stamped by admin change-password and company deactivation. A NULL
    // tokens_not_before means no revocation — existing sessions survive.
    if (payload.role === 'company_admin') {
      const adminResult = await pool.query(
        'SELECT is_active, tokens_not_before FROM company_admins WHERE id = $1',
        [payload.sub]
      ).catch(() => ({ rows: [] as { is_active: boolean; tokens_not_before: Date | null }[] }));

      const adminRow = adminResult.rows[0];
      if (!adminRow?.is_active) {
        return res.status(403).json({ error: 'Account deactivated' });
      }
      if (adminRow.tokens_not_before) {
        const notBeforeMs = new Date(adminRow.tokens_not_before).getTime();
        // See guard branch above for the +1s / <= precision rationale.
        if ((payload.iat + 1) * 1000 <= notBeforeMs) {
          return res.status(401).json({ error: 'Session revoked by administrator' });
        }
      }
    }

    // Vishnu (super-admin) session revocation (Finding #1). Vishnu has no
    // DB row (env-based auth), so revocation lives in the vishnu_state
    // singleton, bumped by POST /api/auth/vishnu/revoke-sessions. No
    // is_active check (no row to deactivate). On a DB read error we fail
    // OPEN — same as the guard/client tokens_not_before reads, which treat
    // an unreadable stamp as "no revocation" rather than locking out the
    // only super-admin on a transient blip.
    if (payload.role === 'vishnu') {
      const vsResult = await pool.query(
        'SELECT tokens_not_before FROM vishnu_state WHERE id = 1'
      ).catch(() => ({ rows: [] as { tokens_not_before: Date | null }[] }));

      const nb = vsResult.rows[0]?.tokens_not_before;
      if (nb) {
        const notBeforeMs = new Date(nb).getTime();
        if ((payload.iat + 1) * 1000 <= notBeforeMs) {
          return res.status(401).json({ error: 'Session revoked' });
        }
      }
    }

    req.user = payload;
    tagRequest(req, payload);
    next();
  };
}

/** Middleware that requires the caller to be the primary admin of their company */
export function requirePrimaryAdmin() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'company_admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    if (!req.user.is_primary) {
      return res.status(403).json({ error: 'Only the primary admin can perform this action' });
    }
    next();
  };
}
