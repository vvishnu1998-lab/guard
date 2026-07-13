/**
 * Clock-In Step 2 — Guard Selfie (Section 5.2)
 *
 * Full camera + preview UX lives in components/SelfieCapture (extracted
 * 2026-07-10 to unify with the handoff-clock-in wizard). This screen is
 * now a thin wrapper that:
 *   - Renders SelfieCapture with the clock-in step label + instruction
 *   - On captured: writes the proof into useClockInStore and advances
 *     to step4 (submit).
 */
import { router } from 'expo-router';
import { useClockInStore } from '../../store/clockInStore';
import SelfieCapture, { SelfieProof } from '../../components/SelfieCapture';

export default function ClockInStep2() {
  const { setSelfie } = useClockInStore();

  function handleSelfieCaptured(proof: SelfieProof) {
    setSelfie(proof);
    router.replace('/clock-in/step4');
  }

  return (
    <SelfieCapture
      uploadContext="clock_in"
      stepLabel="CLOCK IN · STEP 2 OF 3"
      instruction="Take a clear photo of yourself"
      onSelfieCaptured={handleSelfieCaptured}
    />
  );
}
