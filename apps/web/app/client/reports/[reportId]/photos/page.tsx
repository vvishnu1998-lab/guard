'use client';
/**
 * Client — Report photo gallery (/client/reports/<id>/photos)
 * Opened in a new tab from the Site Activity Log. Server scopes the
 * fetch to the client's site_id, so a client can't view reports from a
 * site they don't own even if they hand-craft a URL.
 */
import { useParams } from 'next/navigation';
import { clientGet } from '../../../../../lib/clientApi';
import ReportPhotosView from '../../../../../components/ReportPhotosView';

export default function ClientReportPhotosPage() {
  const params   = useParams();
  const reportId = String(params?.reportId ?? '');
  if (!reportId) return null;
  return <ReportPhotosView reportId={reportId} fetcher={clientGet} accentClass="text-blue-400" />;
}
