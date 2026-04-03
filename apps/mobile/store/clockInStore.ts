/**
 * Clock-In Store — collects all three proofs during the 4-step clock-in flow.
 * Cleared after a successful clock-in or on cancel/error.
 */
import { create } from 'zustand';

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
  verifiedAt:               string | null;

  // Step 2 — Guard selfie
  selfie:                   PhotoProof | null;

  // Step 3 — Site photo
  sitePhoto:                PhotoProof | null;

  // Admin-defined checkpoint instruction shown in step 3
  pendingShiftInstruction:  string | null;

  // The shift that is being clocked into (set from shiftStore before entering flow)
  pendingShiftId:           string | null;

  // Actions
  setGpsVerified:           (lat: number, lng: number) => void;
  setSelfie:                (proof: PhotoProof) => void;
  setSitePhoto:             (proof: PhotoProof) => void;
  setPendingShift:          (shiftId: string, instruction?: string) => void;
  reset:                    () => void;
}

const initialState = {
  verifiedLatitude:        null,
  verifiedLongitude:       null,
  verifiedAt:              null,
  selfie:                  null,
  sitePhoto:               null,
  pendingShiftInstruction: null,
  pendingShiftId:          null,
};

export const useClockInStore = create<ClockInState>((set) => ({
  ...initialState,

  setGpsVerified: (lat, lng) =>
    set({
      verifiedLatitude:  lat,
      verifiedLongitude: lng,
      verifiedAt:        new Date().toISOString(),
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
