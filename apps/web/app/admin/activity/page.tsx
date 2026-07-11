'use client';
/**
 * Admin — Activity Logs (/admin/activity)
 *
 * Search, site + shift dropdowns (shift no longer requires site
 * pre-selection), compact date-range picker, and DOWNLOAD PDF button.
 * Row detail expands inline as an accordion — the old
 * /admin/activity/[reportId]/photos sub-route was removed.
 *
 * URL was renamed from /admin/reports on 2026-07-08 (route-renames
 * task #5); a permanent 301 in next.config.js still redirects the
 * old path so bookmarked links keep working.
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
    />
  );
}
