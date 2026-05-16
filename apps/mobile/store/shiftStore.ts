import { create } from 'zustand';
import { setShiftTag } from '../lib/sentry';

interface Geofence {
  polygon_coordinates: { lat: number; lng: number }[];
  center_lat: number;
  center_lng: number;
  radius_meters: number;
}

interface Shift {
  id: string;
  site_id: string;
  site_name: string;
  scheduled_start: string;
  scheduled_end: string;
  instructions_pdf_url?: string | null;
  effective_photo_limit?: number;
  /** Per-site ping cadence in minutes. Set from sites.ping_interval_minutes
   *  at active-session restore / clock-in. Optional on the wire for
   *  backwards compat with pre-Item-8 API responses; consumers should
   *  fall back to 30 when absent. */
  ping_interval_minutes?: number;
  geofence?: Geofence;
}

interface ShiftSession {
  id: string;
  shift_id: string;
  clocked_in_at: string;
}

interface ShiftState {
  pendingShift: Shift | null;
  activeShift: Shift | null;
  activeSession: ShiftSession | null;
  setPendingShift: (shift: Shift) => void;
  setActiveSession: (shift: Shift, session: ShiftSession) => void;
  clearSession: () => void;
}

export const useShiftStore = create<ShiftState>((set) => ({
  pendingShift: null,
  activeShift: null,
  activeSession: null,

  setPendingShift: (shift) => set({ pendingShift: shift }),

  setActiveSession: (shift, session) => {
    set({ activeShift: shift, activeSession: session, pendingShift: null });
    setShiftTag(session.id);
  },

  clearSession: () => {
    set({ activeShift: null, activeSession: null, pendingShift: null });
    setShiftTag(null);
  },
}));
