'use client';
/**
 * Admin — Activity Log (/admin/activity)
 *
 * Site dropdown → Shift dropdown → date range. Photos click through to
 * /admin/activity/<reportId>/photos in a new tab. The nav label still
 * reads "REPORTS" because that's what admins colloquially call it; the
 * URL was renamed from /admin/reports on 2026-07-08 to match the actual
 * activity-log content (route-renames task #5). A permanent 301 in
 * next.config.js redirects /admin/reports → /admin/activity so existing
 * bookmarks still work.
 */
import ActivityLogTable from '../../../components/ActivityLogTable';
import { adminGet } from '../../../lib/adminApi';

export default function AdminActivityLogPage() {
  return (
    <ActivityLogTable
      fetcher={adminGet}
      accentClass="text-amber-400"
      heading="ACTIVITY LOGS"
      mode="admin"
      detailPathPrefix="/admin/activity"
    />
  );
}
