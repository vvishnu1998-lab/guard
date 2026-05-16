/** API request/response shapes used by both mobile and web clients */

export interface LoginResponse {
  access: string;
  refresh: string;
}

export interface PresignedUrlResponse {
  url: string;
  key: string;
}

export interface ClockInRequest {
  clock_in_coords: string;
}

export interface ClockOutRequest {
  handover_notes?: string;
}

export interface ClockInVerificationRequest {
  shift_session_id: string;
  selfie_url: string;
  site_photo_url: string;
  verified_lat: number;
  verified_lng: number;
  is_within_geofence: boolean;
}

export interface SubmitReportRequest {
  shift_session_id: string;
  report_type: 'activity' | 'incident' | 'maintenance';
  description: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  photo_urls?: { url: string; size_kb: number }[];
  latitude?: number;
  longitude?: number;
}

export interface LocationPingRequest {
  shift_session_id: string;
  latitude: number;
  longitude: number;
  ping_type: 'gps_only' | 'gps_photo';
  photo_url?: string;
  /** Item 7 — set by the mobile battery-throttle hook when the cadence
   *  was multiplied (low battery or low-power-mode). Server writes to
   *  location_pings.throttle_reason. Absent / undefined = normal cadence. */
  throttle_reason?: 'low_battery' | 'low_power_mode';
}

export interface GeofenceViolationRequest {
  shift_session_id: string;
  latitude: number;
  longitude: number;
  photo_url?: string;
}

export interface CreateSiteRequest {
  name: string;
  address: string;
  contract_start: string;
  contract_end: string;
}

export interface UpdateGeofenceRequest {
  polygon_coordinates: { lat: number; lng: number }[];
  center_lat: number;
  center_lng: number;
  radius_meters: number;
}
