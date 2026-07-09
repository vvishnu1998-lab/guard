'use client';
/**
 * Admin — Report photo gallery (/admin/activity/<id>/photos)
 * Opened in a new tab from the Activity Log when the admin clicks any
 * report row's media or view icon. Shows all photos attached to the
 * report plus the report meta + description.
 *
 * Path renamed from /admin/reports/<id>/photos on 2026-07-08 (task #5).
 * next.config.js keeps a permanent 301 for the old URL.
 */
import { useParams } from 'next/navigation';
import { adminGet } from '../../../../../lib/adminApi';
import ReportPhotosView from '../../../../../components/ReportPhotosView';

export default function AdminReportPhotosPage() {
  const params   = useParams();
  const reportId = String(params?.reportId ?? '');
  if (!reportId) return null;
  return <ReportPhotosView reportId={reportId} fetcher={adminGet} accentClass="text-amber-400" />;
}
