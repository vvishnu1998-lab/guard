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

export function requireAuth(...roles: UserRole[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization token' });
    }

    let payload: AuthPayload;
    try {
      payload = jwt.verify(header.slice(7), process.env.JWT_SECRET!) as AuthPayload;
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
      // revocation stamp is rejected.  `iat` is seconds since epoch.
      if (guardRow.tokens_not_before) {
        const notBeforeMs = new Date(guardRow.tokens_not_before).getTime();
        if (payload.iat * 1000 < notBeforeMs) {
          return res.status(401).json({ error: 'Session revoked by administrator' });
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
