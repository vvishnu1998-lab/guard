import { Router } from 'express';
import { requireAuth } from '../middleware/auth';

/**
 * POST /api/geocode — server-side Google Maps Geocoding proxy.
 *
 * Body: { address: string }
 * Response:
 *   200 { lat, lng, formatted_address }  — resolved
 *   400 { error: '...' }                 — bad input
 *   404 { error: 'No results' }          — geocoder returned ZERO_RESULTS
 *   501 { error: 'Geocoding not configured' } — GOOGLE_GEOCODING_API_KEY missing
 *   502 { error: '...' }                 — upstream error / bad response
 *
 * Auth: company_admin OR vishnu (admin-only feature; guards and clients
 * have no need to geocode).
 *
 * The API key lives server-side to avoid burning quota from browser abuse
 * and to keep the key out of Vercel client bundles. If the deploy has no
 * GOOGLE_GEOCODING_API_KEY set, the endpoint returns 501 so the UI can
 * degrade gracefully to manual coordinate entry.
 *
 * No caching yet — request volume is admin-triggered and low. If abuse
 * shows up, add a per-company + per-address in-memory LRU cache here.
 */
const router = Router();

interface GoogleGeocodeResp {
  status: string;
  results: Array<{
    geometry: { location: { lat: number; lng: number } };
    formatted_address: string;
  }>;
  error_message?: string;
}

router.post('/', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const { address } = req.body as { address?: string };
  if (typeof address !== 'string' || address.trim().length < 5) {
    return res.status(400).json({ error: 'address (string, ≥5 chars) is required' });
  }
  const key = process.env.GOOGLE_GEOCODING_API_KEY;
  if (!key) {
    return res.status(501).json({ error: 'Geocoding not configured on this deploy.' });
  }
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address.trim())}&key=${key}`;
  try {
    const upstream = await fetch(url);
    if (!upstream.ok) {
      return res.status(502).json({ error: `Geocoding upstream returned ${upstream.status}` });
    }
    const data = (await upstream.json()) as GoogleGeocodeResp;
    if (data.status === 'ZERO_RESULTS') {
      return res.status(404).json({ error: 'Coordinates not found for this address.' });
    }
    if (data.status !== 'OK' || !data.results?.length) {
      return res.status(502).json({ error: data.error_message || `Geocoder returned ${data.status}` });
    }
    const top = data.results[0];
    return res.json({
      lat: top.geometry.location.lat,
      lng: top.geometry.location.lng,
      formatted_address: top.formatted_address,
    });
  } catch (err: any) {
    // Network-level failure — bubble a 502 so the UI shows a retryable error
    // instead of a scary 500.
    console.error('[POST /api/geocode] fetch failed:', err?.message ?? err);
    return res.status(502).json({ error: 'Geocoding request failed. Please try again.' });
  }
});

export default router;
