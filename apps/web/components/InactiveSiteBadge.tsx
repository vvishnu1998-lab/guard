'use client';

/**
 * <InactiveSiteBadge /> — pill flag rendered next to a site name in any
 * historical view (activity log, guard profile hours, shifts detail,
 * recent alerts, dashboards) when the underlying site has been
 * deactivated. History stays visible; the badge just tells the reader
 * the site itself is decommissioned.
 *
 * Backend contract: any list/detail endpoint that surfaces historical
 * site-scoped rows returns `site_is_active: boolean`. Render the badge
 * when `site_is_active === false`.
 *
 * XLSX / CSV exports get the equivalent treatment server-side by
 * prefixing "[INACTIVE] " on the site name at SELECT time (see
 * billing.ts + monthlyHoursReport.ts + exports.ts).
 */
export default function InactiveSiteBadge({
  siteIsActive,
  className = '',
}: {
  siteIsActive: boolean | null | undefined;
  className?: string;
}) {
  if (siteIsActive !== false) return null;
  return (
    <span
      className={`ml-2 inline-flex items-center text-[9px] font-bold tracking-widest text-gray-400 bg-gray-800/60 border border-gray-700 rounded px-1.5 py-0.5 align-middle ${className}`}
      title="Site has been deactivated. Historical rows remain visible."
    >
      INACTIVE
    </span>
  );
}
