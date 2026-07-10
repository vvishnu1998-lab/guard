-- Schema v27 — Geocoded coordinates on sites
--
-- The admin's NEW SITE flow now looks up the site's address through the
-- Google Maps Geocoding API on address-blur (server-side proxied via
-- POST /api/geocode). The returned lat/lng lands in these columns so
-- that when the admin later opens the geofence editor for that site,
-- the LATITUDE + LONGITUDE inputs are pre-filled with the geocoded
-- point.
--
-- These are separate from site_geofence.center_lat / center_lng which
-- represent the ACTUAL configured fence. A site can have geocoded_*
-- populated (address was resolved) yet no site_geofence row (admin
-- hasn't drawn a fence yet) — in that case the sites list still shows
-- "NOT SET — Configure" and clicking Edit pre-populates the coords.
--
-- Nullable + additive: existing rows stay unaffected. Column-add on
-- Postgres is metadata-only (no rewrite) so this migration is
-- millisecond-fast even at scale.

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS geocoded_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS geocoded_lng DOUBLE PRECISION;
