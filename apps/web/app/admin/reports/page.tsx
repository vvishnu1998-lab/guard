'use client';
/**
 * Admin — Activity Log (/admin/reports)
 *
 * Unified table of pings (with synthesized "Missed Ping" rows) and
 * activity / incident / maintenance reports. Filters: date range,
 * guard-name search. Paginated 10/page. Layout matches the Aventus
 * Dispatch reference.
 */
import ActivityLogTable from '../../../components/ActivityLogTable';
import { adminGet } from '../../../lib/adminApi';

export default function AdminActivityLogPage() {
  return (
    <ActivityLogTable
      fetcher={adminGet}
      accentClass="text-amber-400"
      heading="ACTIVITY LOGS"
    />
  );
}
