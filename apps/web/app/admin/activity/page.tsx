'use client';
/**
 * Admin — Activity Log (/admin/reports)
 *
 * Site dropdown → Shift dropdown → date range. Photos click through to
 * /admin/reports/<reportId>/photos in a new tab.
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
      detailPathPrefix="/admin/reports"
    />
  );
}
