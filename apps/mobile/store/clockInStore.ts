/**
 * Clock-In Store — collects all three proofs during the 4-step clock-in flow.
 * Cleared after a successful clock-in or on cancel/error.
 */
import { create } from 'zustand';
import { NO_LOCATION_SIGNALS, type LocationSignals } from '../lib/locationSignals';

export interface PhotoProof {
  uri:       string;
  latitude:  number;
  longitude: number;
  takenAt:   string; // ISO-8601
}

interface ClockInState {
  // Step 1 — GPS verification result
  verifiedLatitude:         number | null;
  verifiedLongitude:        number | null;
  /** GPS accuracy in meters (expo-location coords.accuracy). Plumbed through
   *  to the API so server-side geofence validation can apply it as a tolerance
   *  budget. Item 3. */
  verifiedAccuracy:         number | null;
  verifiedAt:               string | null;
  /** Shadow capture (Wave 1) — recorded and sent, never evaluated. No screen
   *  reads these and no button is gated on them. See lib/locationSignals.ts. */
  verifiedSignals:          LocationSignals;

  // Step 2 — Guard selfie
  selfie:                   PhotoProof | null;

  // Step 3 — Site photo
  sitePhoto:                PhotoProof | null;

  // Admin-defined checkpoint instruction shown in step 3
  pendingShiftInstruction:  string | null;

  // The shift that is being clocked into (set from shiftStore before entering flow)
  pendingShiftId:           string | null;

  // Actions
  setGpsVerified:           (lat: number, lng: number, accuracy: number, signals?: LocationSignals) => void;
  setSelfie:                (proof: PhotoProof) => void;
  setSitePhoto:             (proof: PhotoProof) => void;
  setPendingShift:          (shiftId: string, instruction?: string) => void;
  reset:                    () => void;
}

const initialState = {
  verifiedLatitude:        null,
  verifiedLongitude:       null,
  verifiedAccuracy:        null,
  verifiedSignals:         NO_LOCATION_SIGNALS,
  verifiedAt:              null,
  selfie:                  null,
  sitePhoto:               null,
  pendingShiftInstruction: null,
  pendingShiftId:          null,
};

export const useClockInStore = create<ClockInState>((set) => ({
  ...initialState,

  setGpsVerified: (lat, lng, accuracy, signals) =>
    set({
      verifiedLatitude:  lat,
      verifiedLongitude: lng,
      verifiedAccuracy:  accuracy,
      verifiedAt:        new Date().toISOString(),
      verifiedSignals:   signals ?? NO_LOCATION_SIGNALS,
    }),

  setSelfie: (proof) => set({ selfie: proof }),

  setSitePhoto: (proof) => set({ sitePhoto: proof }),

  setPendingShift: (shiftId, instruction) =>
    set({
      pendingShiftId:          shiftId,
      pendingShiftInstruction: instruction ?? null,
    }),

  reset: () => set(initialState),
}));
