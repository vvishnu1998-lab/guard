'use client';
/**
 * Admin — Report photo gallery (/admin/reports/<id>/photos)
 * Opened in a new tab from the Activity Log when the admin clicks any
 * report row's media or view icon. Shows all photos attached to the
 * report plus the report meta + description.
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
