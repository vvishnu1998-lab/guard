/**
 * TypeScript types for all 19 database tables.
 * Mirror the PostgreSQL schema exactly — UUIDs as string, timestamps as string (ISO 8601).
 */

// ============================================================
// LAYER 1 — ACCESS AND STRUCTURE
// ============================================================

export interface Company {
  id: string;
  name: string;
  default_photo_limit: number;
  is_active: boolean;
  created_at: string;
}

export interface CompanyAdmin {
  id: string;
  company_id: string;
  name: string;
  email: string;
  password_hash: string;
  is_primary: boolean;
  is_active: boolean;
  created_at: string;
}

export interface Site {
  id: string;
  company_id: string;
  name: string;
  address: string;
  photo_limit_override: number | null;
  is_active: boolean;
  contract_start: string; // DATE — "YYYY-MM-DD"
  contract_end: string;
  client_access_disabled_at: string | null;
  created_at: string;
}

export interface Client {
  id: string;
  site_id: string;
  name: string;
  email: string;
  password_hash: string;
  is_active: boolean;
  created_at: string;
}

export interface Guard {
  id: string;
  company_id: string;
  name: string;
  email: string;
  password_hash: string;
  badge_number: string;
  phone_number: string | null;  // v2: SMS unlock fallback
  is_active: boolean;
  must_change_password: boolean;
  fcm_token: string | null;
  created_at: string;
}

export interface GuardSiteAssignment {
  id: string;
  guard_id: string;
  site_id: string;
  assigned_from: string;   // DATE
  assigned_until: string | null;
  created_at: string;
}

// ============================================================
// LAYER 2 — SHIFTS, REPORTS AND OPERATIONS
// ============================================================

export type ShiftStatus = 'scheduled' | 'active' | 'completed' | 'missed';

export interface Shift {
  id: string;
  site_id: string;
  guard_id: string;
  scheduled_start: string;
  scheduled_end: string;
  status: ShiftStatus;
  daily_report_email_sent: boolean;
  daily_report_email_sent_at: string | null;
  created_at: string;
}

export interface ShiftSession {
  id: string;
  shift_id: string;
  guard_id: string;
  site_id: string;
  clocked_in_at: string;
  clocked_out_at: string | null;
  total_hours: number | null;
  clock_in_coords: string; // "lat,lng"
  created_at: string;
}

export type ReportType = 'activity' | 'incident' | 'maintenance';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface Report {
  id: string;
  shift_session_id: string;
  site_id: string;
  report_type: ReportType;
  description: string;
  severity: Severity | null;
  reported_at: string;
  delete_at: string;
  created_at: string;
}

export interface ReportPhoto {
  id: string;
  report_id: string;
  storage_url: string;
  file_size_kb: number; // max 800
  photo_index: number;  // 1–5
  delete_at: string;
  created_at: string;
}

export interface DataRetentionLog {
  id: string;
  site_id: string;
  client_star_access_until: string;
  data_delete_at: string;
  warning_60_sent: boolean;
  warning_89_sent: boolean;
  warning_140_sent: boolean;
  client_star_access_disabled: boolean;
  data_deleted: boolean;
  created_at: string;
}

// ============================================================
// LAYER 3 — GEOFENCING AND VERIFICATION
// ============================================================

export interface LatLng {
  lat: number;
  lng: number;
}

export interface SiteGeofence {
  id: string;
  site_id: string;
  polygon_coordinates: LatLng[];
  center_lat: number;
  center_lng: number;
  radius_meters: number;
  grace_radius_meters: number;  // v2: buffer to absorb GPS drift before raising violation (default 50 m)
  created_by_admin: string;
  updated_at: string;
  created_at: string;
}

export interface ClockInVerification {
  id: string;
  shift_session_id: string;
  guard_id: string;
  site_id: string;
  selfie_url: string;
  site_photo_url: string;
  verified_lat: number;
  verified_lng: number;
  is_within_geofence: boolean;
  verified_at: string;
}

export type PingType = 'gps_only' | 'gps_photo';

export interface LocationPing {
  id: string;
  shift_session_id: string;
  guard_id: string;
  site_id: string;
  latitude: number;
  longitude: number;
  is_within_geofence: boolean;
  ping_type: PingType;
  photo_url: string | null;
  photo_delete_at: string;
  retain_as_evidence: boolean;  // v2: true = exempt from 7-day purge (referenced by open violation)
  pinged_at: string;
}

export interface GeofenceViolation {
  id: string;
  shift_session_id: string;
  guard_id: string;
  site_id: string;
  violation_lat: number;
  violation_lng: number;
  occurred_at: string;
  resolved_at: string | null;
  duration_minutes: number | null;
  notification_sent: boolean;
  photo_url: string | null;
  supervisor_override: boolean;       // v2: admin manually excused this violation
  override_by: string | null;         // v2: UUID of company_admin who overrode
  created_at: string;
}

// ============================================================
// LAYER 4 — TASKS AND BREAKS
// ============================================================

export type Recurrence = 'daily' | 'weekdays' | 'weekends' | 'custom';

export interface TaskTemplate {
  id: string;
  site_id: string;
  created_by_admin: string;
  title: string;
  description: string;
  scheduled_time: string; // "HH:MM:SS"
  recurrence: Recurrence;
  requires_photo: boolean;
  is_active: boolean;
  created_at: string;
}

export type TaskStatus = 'pending' | 'completed' | 'overdue';

export interface TaskInstance {
  id: string;
  template_id: string;
  shift_id: string;
  site_id: string;
  title: string; // copied from template at generation — NOT a FK reference
  due_at: string;
  status: TaskStatus;
  created_at: string;
}

export interface TaskCompletion {
  id: string;
  task_instance_id: string;
  shift_session_id: string;
  guard_id: string;
  completion_lat: number;
  completion_lng: number;
  photo_url: string | null;
  completed_at: string;
}

export type BreakType = 'scheduled' | 'unscheduled';

export interface BreakSession {
  id: string;
  shift_session_id: string;
  guard_id: string;
  site_id: string;
  break_start: string;
  break_end: string | null;
  duration_minutes: number | null;
  break_type: BreakType;
  created_at: string;
}
