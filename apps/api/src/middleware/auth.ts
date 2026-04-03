import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool';

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

    // Guard-specific: check account is still active and not locked
    if (payload.role === 'guard') {
      const guardResult = await pool.query(
        'SELECT is_active FROM guards WHERE id = $1',
        [payload.sub]
      ).catch(() => ({ rows: [] as { is_active: boolean }[] }));

      if (!guardResult.rows[0]?.is_active) {
        return res.status(403).json({ error: 'Account deactivated' });
      }
    }

    req.user = payload;
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
