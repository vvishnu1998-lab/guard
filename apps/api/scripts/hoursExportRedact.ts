/**
 * Redaction for the committed hours-export snapshot (N191).
 *
 * The repo is PUBLIC, and POLICY.md lets guard data leave the database as
 * "guard_id, company_id, badge, counts only". The snapshot fixture used to hold
 * every guard's real name (guard_name, and the label built from it). The
 * harness now passes every dataset through redactHoursExport() BEFORE it
 * asserts, compares or writes, so the fixture carries a pseudonym derived from
 * the badge and the live build is compared in the same redacted form.
 *
 * PURE: no database, no I/O, no import of the pool. `import type` only, so
 * scripts/check-hours-snapshot-redaction.ts runs it offline with no env.
 *
 * WHAT IT CHANGES, and nothing else:
 *   rows[].guard_name                      -> "Guard GRD0004"
 *   by_guard[] / by_guard_site[] guard_name -> "Guard GRD0004"
 *   by_guard[].label                       -> "Guard GRD0004"
 *   by_guard_site[].label                  -> "Guard GRD0004 @ <site_name>"
 * by_site[] and overall carry no guard and are returned untouched. Key order is
 * preserved (object spread keeps a key's position when it is overwritten), so
 * JSON.stringify of the redacted LIVE dataset is byte-identical to the fixture.
 * Array order is NOT changed: the builder sorts by the real label, so the
 * fixture keeps that order, and so does the live build it is compared with.
 *
 * A guard with no badge falls back to the first eight characters of the guard
 * id (an id is allowed out of the database; a name is not).
 */
import type { HoursAggregate, HoursExportDataset, HoursExportRow } from '../src/services/hoursExport';

export function guardPseudonym(badge: string | null, guardId: string): string {
  return badge ? `Guard ${badge}` : `Guard ${guardId.slice(0, 8)}`;
}

const redactRow = (r: HoursExportRow): HoursExportRow => ({
  ...r,
  guard_name: guardPseudonym(r.badge_number, r.guard_id),
});

const redactAggregate = (a: HoursAggregate): HoursAggregate => {
  if (a.guard_id === null) return a; // by_site rows and `overall` carry no guard
  const name = guardPseudonym(a.badge_number, a.guard_id);
  return { ...a, guard_name: name, label: a.site_name ? `${name} @ ${a.site_name}` : name };
};

export function redactHoursExport(d: HoursExportDataset): HoursExportDataset {
  return {
    ...d,
    rows: d.rows.map(redactRow),
    by_guard: d.by_guard.map(redactAggregate),
    by_site: d.by_site.map(redactAggregate),
    by_guard_site: d.by_guard_site.map(redactAggregate),
    overall: redactAggregate(d.overall),
  };
}
