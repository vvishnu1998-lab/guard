import { create } from 'zustand';

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

  setActiveSession: (shift, session) =>
    set({ activeShift: shift, activeSession: session, pendingShift: null }),

  clearSession: () =>
    set({ activeShift: null, activeSession: null, pendingShift: null }),
}));
