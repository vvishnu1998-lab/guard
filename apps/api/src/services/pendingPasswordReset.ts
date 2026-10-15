/**
 * N207. A password reset no longer replaces the password (Vishnu, 2026-10-15: 1a, 2a, 3a).
 *
 * POST /api/auth/forgot-password used to overwrite the account's password with the emailed temporary one at once,
 * so anyone who knew an email could end its owner's password. Now the temporary password waits here, beside the
 * password, hashed with bcrypt at the password cost and never stored plain (pending_password_resets, schema_v83),
 * until one of these happens:
 *   - the owner signs in with it: it becomes the password, with a forced change, as before (useReset);
 *   - the owner signs in with the current password, or the password changes: it is dropped (cancelReset);
 *   - RESET_TTL_HOURS pass: it no longer signs in.
 *
 * One row per account. Its created_at also paces the emails: one per account per RESET_EMAIL_GAP_MINUTES. The
 * claim is a single statement, so two requests at once send one email.
 */
import bcrypt from 'bcrypt';
import { pool } from '../db/pool';

export type ResetRole = 'company_admin' | 'client' | 'guard';

/** 2a: how long an emailed temporary password signs in. */
export const RESET_TTL_HOURS = 24;
/** 3a: at most one reset email per account in this many minutes. */
export const RESET_EMAIL_GAP_MINUTES = 15;
/** The cost of every password hash the API stores. */
export const PASSWORD_HASH_COST = 12;

const ACCOUNT_TABLE: Record<ResetRole, 'company_admins' | 'clients' | 'guards'> = {
  company_admin: 'company_admins',
  client: 'clients',
  guard: 'guards',
};

/** False while the account's last reset email is under RESET_EMAIL_GAP_MINUTES old. A cheap early out; claimReset decides. */
export async function resetEmailDue(role: ResetRole, accountId: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM pending_password_resets
      WHERE role = $1 AND account_id = $2 AND created_at > NOW() - make_interval(mins => $3)`,
    [role, accountId, RESET_EMAIL_GAP_MINUTES],
  );
  return r.rowCount === 0;
}

/**
 * Store a new temporary password's hash, replacing an older pending one, unless that one is under
 * RESET_EMAIL_GAP_MINUTES old. True when this request won and its email should go out.
 */
export async function claimReset(role: ResetRole, accountId: string, hash: string): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO pending_password_resets (role, account_id, password_hash, expires_at, created_at)
     VALUES ($1, $2, $3, NOW() + make_interval(hours => $4), NOW())
     ON CONFLICT (role, account_id) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            expires_at    = EXCLUDED.expires_at,
            created_at    = EXCLUDED.created_at
      WHERE pending_password_resets.created_at <= NOW() - make_interval(mins => $5)
     RETURNING 1`,
    [role, accountId, hash, RESET_TTL_HOURS, RESET_EMAIL_GAP_MINUTES],
  );
  return r.rowCount === 1;
}

/** Undo a claim whose email did not go out, so it neither signs in nor holds back the next request. */
export async function releaseReset(role: ResetRole, accountId: string, hash: string): Promise<void> {
  await pool.query(
    'DELETE FROM pending_password_resets WHERE role = $1 AND account_id = $2 AND password_hash = $3',
    [role, accountId, hash],
  );
}

/** The pending reset's hash when `password` is its unexpired temporary password; otherwise null. */
export async function pendingResetFor(role: ResetRole, accountId: string, password: string): Promise<string | null> {
  const r = await pool.query(
    'SELECT password_hash FROM pending_password_resets WHERE role = $1 AND account_id = $2 AND expires_at > NOW()',
    [role, accountId],
  );
  const hash: string | undefined = r.rows[0]?.password_hash;
  return hash && (await bcrypt.compare(password, hash)) ? hash : null;
}

/** A sign-in with the temporary password: in one statement it becomes the password, with a forced change, and the row goes. */
export async function useReset(role: ResetRole, accountId: string, hash: string): Promise<void> {
  const table = ACCOUNT_TABLE[role];
  await pool.query(
    `WITH used AS (
       DELETE FROM pending_password_resets
        WHERE role = $1 AND account_id = $2 AND password_hash = $3
       RETURNING password_hash
     )
     UPDATE ${table} SET password_hash = used.password_hash, must_change_password = true
       FROM used
      WHERE ${table}.id = $2`,
    [role, accountId, hash],
  );
}

/** A sign-in with the current password, or a new password: a pending reset is void. */
export async function cancelReset(role: ResetRole, accountId: string): Promise<void> {
  await pool.query('DELETE FROM pending_password_resets WHERE role = $1 AND account_id = $2', [role, accountId]);
}
